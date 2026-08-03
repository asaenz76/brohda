import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { toFixtureRow, toTeamRows } from "@/lib/sports-data/persist";
import type { NormalizedFixture } from "@/lib/sports-data/types";
import { DISCOVERY_COMPETITIONS_PER_CRON_TICK, DISCOVERY_SYNC_INTERVAL_HOURS } from "./constants";

export interface DiscoverySyncResult {
  competitionsChecked: number;
  fixturesAdded: number;
  fixturesUpdated: number;
  errors: number;
}

export interface SyncOneResult {
  success: boolean;
  fixturesAdded: number;
  fixturesUpdated: number;
  error: string | null;
}

interface CompetitionRef {
  id: string;
  external_league_id: string;
  season: string;
}

/**
 * Re-scans one already-imported competition for schedule changes the
 * one-time import can never catch on its own: newly scheduled fixtures,
 * postponements/reschedules, and the fixture counts that drive the
 * Prepared/Active/No-upcoming-fixtures/Completed operational status.
 * Reuses the exact same provider call as the initial import
 * (getSeasonFixtures — the whole season, one request) rather than a
 * different request shape, so discovery and import never disagree about
 * what "the season" contains. Shared by the batch discovery cron and the
 * Workspace's on-demand "Sync now" action.
 */
export async function syncOneCompetition(
  adminClient: ReturnType<typeof createAdminClient>,
  competition: CompetitionRef,
): Promise<SyncOneResult> {
  try {
    const providerFixtures = await apiFootballProvider.getSeasonFixtures(competition.external_league_id, competition.season);

    const { data: existingRows } = await adminClient
      .from("fixtures")
      .select("external_fixture_id, scheduled_start_utc")
      .eq("provider", "api_football")
      .eq("competition_external_id", competition.external_league_id)
      .eq("season", competition.season);
    const existingByExternalId = new Map((existingRows ?? []).map((r) => [r.external_fixture_id, r.scheduled_start_utc]));

    const newFixtures: NormalizedFixture[] = [];
    const changedFixtures: NormalizedFixture[] = [];
    for (const fixture of providerFixtures) {
      const existingStart = existingByExternalId.get(fixture.externalFixtureId);
      if (existingStart === undefined) {
        newFixtures.push(fixture);
      } else if (new Date(existingStart).getTime() !== new Date(fixture.scheduledStartUtc).getTime()) {
        changedFixtures.push(fixture); // postponement/reschedule
      }
    }

    const toWrite = [...newFixtures, ...changedFixtures];
    if (toWrite.length > 0) {
      await adminClient.from("fixtures").upsert(toWrite.map(toFixtureRow), { onConflict: "provider,external_fixture_id" });
      const teamRowsByKey = new Map<string, ReturnType<typeof toTeamRows>[number]>();
      for (const row of toWrite.flatMap(toTeamRows)) teamRowsByKey.set(`${row.provider}:${row.external_id}`, row);
      if (teamRowsByKey.size > 0) {
        await adminClient.from("teams").upsert([...teamRowsByKey.values()], { onConflict: "provider,external_id" });
      }
    }

    const now = new Date();
    const upcoming = providerFixtures.filter((f) => new Date(f.scheduledStartUtc).getTime() > now.getTime());
    const latestProviderFixtureAt = providerFixtures.reduce<string | null>(
      (latest, f) => (!latest || f.scheduledStartUtc > latest ? f.scheduledStartUtc : latest),
      null,
    );

    await adminClient
      .from("league_season_imports")
      .update({
        fixture_count_imported: providerFixtures.length,
        upcoming_fixture_count: upcoming.length,
        completed_fixture_count: providerFixtures.length - upcoming.length,
        provider_fixture_count: providerFixtures.length,
        latest_provider_fixture_at: latestProviderFixtureAt,
        last_fixture_discovery_at: now.toISOString(),
        last_synced_at: now.toISOString(),
        sync_status: "IDLE",
        last_sync_error: null,
      })
      .eq("id", competition.id);

    return { success: true, fixturesAdded: newFixtures.length, fixturesUpdated: changedFixtures.length, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Discovery sync failed";
    await adminClient
      .from("league_season_imports")
      .update({ sync_status: "FAILED", last_sync_error: message })
      .eq("id", competition.id);
    return { success: false, fixturesAdded: 0, fixturesUpdated: 0, error: message };
  }
}

/**
 * Re-scans every already-imported, active competition due for discovery
 * (batch, bounded per tick) — the scheduled counterpart to
 * syncOneCompetition's on-demand use.
 */
export async function runCompetitionDiscoverySync(): Promise<DiscoverySyncResult> {
  const adminClient = createAdminClient();
  const result: DiscoverySyncResult = { competitionsChecked: 0, fixturesAdded: 0, fixturesUpdated: 0, errors: 0 };

  if (!apiFootballProvider.isEnabled()) return result;

  const staleBefore = new Date(Date.now() - DISCOVERY_SYNC_INTERVAL_HOURS * 3600_000).toISOString();
  const { data: due } = await adminClient
    .from("league_season_imports")
    .select("id, external_league_id, season")
    .eq("import_status", "IMPORTED")
    .eq("is_active", true)
    .or(`last_fixture_discovery_at.is.null,last_fixture_discovery_at.lt.${staleBefore}`)
    .limit(DISCOVERY_COMPETITIONS_PER_CRON_TICK);

  for (const competition of due ?? []) {
    result.competitionsChecked += 1;
    const outcome = await syncOneCompetition(adminClient, competition);
    if (outcome.success) {
      result.fixturesAdded += outcome.fixturesAdded;
      result.fixturesUpdated += outcome.fixturesUpdated;
    } else {
      result.errors += 1;
    }
  }

  return result;
}
