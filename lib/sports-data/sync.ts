import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "./api-football-provider";
import { upsertFixture } from "./persist";
import { TERMINAL_STATUSES } from "./status-map";
import type { FixtureInternalStatus } from "./types";
import { EVENT_DEPENDENT_TEMPLATE_IDS } from "@/lib/pools/templates/registry";
import { getProviderStatus, isQuotaExhaustedError } from "./provider-gateway";

const MINUTE_MS = 60_000;

// Pool statuses past which no future grading will ever read events again —
// mirrors the intent of fixtures_available_for_pool_creation's "still
// active" check. Everything else (including pre-lock OPEN/SCHEDULED) is
// left in so events start syncing the moment a fixture goes live, without
// waiting for lock.
const POOL_TERMINAL_STATUSES = [
  "SETTLED",
  "VOIDED",
  "CANCELLED",
  "SETTLEMENT_REVERSED",
  "REVERSAL_FAILED_MANUAL_REVIEW",
  // gradeTemplatePool never re-reads events for a pool once it's routed
  // here — its only exit (an admin cancelling it) needs no fixture data.
  "MANUAL_REVIEW",
];

/**
 * Refresh intervals expressed as multiples of the 1-minute Vercel Cron
 * floor. Spec §9's ~30s live cadence isn't achievable on this platform
 * (documented in docs/ARCHITECTURE.md) — "every run" is the closest we get.
 */
function requiredIntervalMs(
  status: FixtureInternalStatus,
  kickoffMs: number,
  now: number,
): number {
  if (status === "LIVE" || status === "HALFTIME" || status === "EXTRA_TIME" || status === "PENALTIES") {
    return MINUTE_MS;
  }

  const msUntilKickoff = kickoffMs - now;
  if (msUntilKickoff > 0) {
    return msUntilKickoff < 6 * 60 * MINUTE_MS ? 5 * MINUTE_MS : 30 * MINUTE_MS;
  }

  // Past kickoff but not yet live/terminal per the provider — the "result
  // window" spec §9 calls out with its own cadence.
  const msSinceKickoff = now - kickoffMs;
  return msSinceKickoff < 4 * 60 * MINUTE_MS ? 2 * MINUTE_MS : 10 * MINUTE_MS;
}

export interface SyncResult {
  checked: number;
  refreshed: number;
  skipped: number;
  failed: number;
}

export async function runFixtureSync(): Promise<SyncResult> {
  const result: SyncResult = { checked: 0, refreshed: 0, skipped: 0, failed: 0 };

  if (!apiFootballProvider.isEnabled()) {
    return result;
  }

  // Same guard as runCompetitionDiscoverySync — checked before spending any
  // requests. Without it, a quota-exhaustion event left every due fixture
  // to fail individually, one wasted (and logged) request each, for the
  // entire cron run instead of skipping the tick.
  const status = await getProviderStatus(true);
  if (status.circuitBreakerOpen) {
    return result;
  }

  const admin = createAdminClient();
  const terminalList = TERMINAL_STATUSES.join(",");
  const { data: fixtures } = await admin
    .from("fixtures")
    .select("id, external_fixture_id, internal_status, scheduled_start_utc, last_synced_at")
    .not("internal_status", "in", `(${terminalList})`);

  if (!fixtures) return result;

  // One cheap query up front: which fixtures actually have an active,
  // events-dependent TEMPLATE_GRADED pool riding on them. Only those are
  // worth spending an extra /fixtures/events call on.
  const eventFixtureIds = new Set<string>();
  if (EVENT_DEPENDENT_TEMPLATE_IDS.length > 0) {
    const { data: eventPools } = await admin
      .from("pools")
      .select("fixture_id")
      .eq("pool_type", "TEMPLATE_GRADED")
      .in("template_id", EVENT_DEPENDENT_TEMPLATE_IDS)
      .not("status", "in", `(${POOL_TERMINAL_STATUSES.join(",")})`)
      .not("fixture_id", "is", null);
    for (const row of eventPools ?? []) {
      if (row.fixture_id) eventFixtureIds.add(row.fixture_id);
    }
  }

  const now = Date.now();
  const seen = new Set<string>();

  for (const fixture of fixtures) {
    result.checked++;

    if (seen.has(fixture.external_fixture_id)) {
      result.skipped++;
      continue;
    }
    seen.add(fixture.external_fixture_id);

    const kickoffMs = new Date(fixture.scheduled_start_utc).getTime();
    const interval = requiredIntervalMs(
      fixture.internal_status as FixtureInternalStatus,
      kickoffMs,
      now,
    );
    const lastSyncedMs = fixture.last_synced_at ? new Date(fixture.last_synced_at).getTime() : 0;

    if (now - lastSyncedMs < interval) {
      result.skipped++;
      continue;
    }

    try {
      const updated = await apiFootballProvider.getFixtureById(fixture.external_fixture_id);
      if (!updated) {
        result.skipped++;
        continue;
      }
      await upsertFixture(admin, updated);
      result.refreshed++;

      // Events don't exist before kickoff, and are only worth fetching for
      // fixtures an active events-dependent pool actually references.
      if (eventFixtureIds.has(fixture.id) && updated.internalStatus !== "NOT_STARTED") {
        await syncFixtureEvents(admin, fixture.id, fixture.external_fixture_id);
      }
    } catch (error) {
      result.failed++;
      await admin
        .from("fixtures")
        .update({ sync_error: error instanceof Error ? error.message : "unknown error" })
        .eq("id", fixture.id);

      // Same reasoning as runCompetitionDiscoverySync: once the provider
      // reports quota exhaustion, every remaining due fixture in this run
      // would fail identically — stop instead of burning the rest of the
      // batch on guaranteed failures.
      if (isQuotaExhaustedError(error instanceof Error ? error : new Error(String(error)))) {
        break;
      }
    }
  }

  return result;
}

// Separate from upsertFixture/toFixtureRow deliberately — events come from
// a different endpoint on a different cadence, and a failed events fetch
// should never affect (or be affected by) the score/status upsert above.
// A caught error here is swallowed rather than bubbled: the surrounding
// try/catch already reports `result.refreshed++` for the score update,
// which succeeded, so failing to also grab events shouldn't mark the whole
// fixture as `result.failed`. gradeTemplatePool's PENDING gate already
// handles "events not cached yet" safely.
async function syncFixtureEvents(
  admin: ReturnType<typeof createAdminClient>,
  fixtureId: string,
  externalFixtureId: string,
) {
  try {
    const events = await apiFootballProvider.getFixtureEvents(externalFixtureId);
    if (events.length === 0) return;
    await admin
      .from("fixtures")
      .update({ provider_events_payload: events, events_synced_at: new Date().toISOString() })
      .eq("id", fixtureId);
  } catch {
    // Swallowed — see comment above.
  }
}
