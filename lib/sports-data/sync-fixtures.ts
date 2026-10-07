import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { upsertFixturesBatch } from "./persist";
import { TERMINAL_STATUSES } from "./status-map";
import type { FixtureInternalStatus, NormalizedFixture, SportsOddsProvider } from "./types";
import { getProviderStatus } from "./provider-gateway";
import { getOddsProvider } from "./provider-registry";
import { shouldReserveQuota } from "./quota-reserve";
import { extractErrorMessage } from "./provider-errors";
import { activeSportConfigs, type SportConfig } from "./sport-registry";
import { errorMessage } from "@/lib/utils/error-message";

// The one fixture sync for every sport (parameterised by lib/sports-data/sport-registry.ts; originally written for the NFL, whose behaviour it
// preserves exactly — the NFL comments below describe the design every sport inherits).
//
// Deliberately simple: the provider's getSeasonFixtures returns the ENTIRE
// season (confirmed live: 328 games for the NFL 2026, ~1,400-1,500 for an NBA / NHL season, one request, no pagination)
// — there's nothing to gain from tracking per-fixture refresh timing, and
// real gain (much less code, one code path instead of an adaptive-interval
// state machine) in not building one. The one thing
// still worth skipping is re-writing a fixture whose *stored* status is
// already terminal — a finished/cancelled game's score never changes
// again, so there's no reason to re-upsert it every tick.
export interface SportSyncResult {
  checked: number;
  refreshed: number;
  skipped: number;
  // Postseason bracket slots API-NFL schedules before the matchup is
  // determined (Wild Card/Divisional/Conference/Super Bowl) come back with
  // a placeholder team (`id: 0`, `name: null`) on both sides — real, live-
  // confirmed shape, not malformed data. `fixtures.home_team_name`/
  // `away_team_name` are NOT NULL, so these can't be written yet; they're
  // filtered out before the batch upsert (one still-undetermined row would
  // otherwise fail the whole batch) and re-checked every tick until the
  // provider fills in the real teams once the bracket is set.
  pendingMatchup: number;
  failed: number;
  // Confirmed-result reconciliation (lib/pools/templates/nfl-confirmed-
  // result.ts is what actually reads these rows for grading) — counted
  // separately from refreshed/skipped since they measure a different pass.
  resultsConfirmed: number;
  resultsCorrected: number;
  resultsFailed: number;
  /** Games left out because a team is not a franchise of the league (All-Star exhibition "teams") — see sport-registry franchiseSource. */
  nonFranchise: number;
  /** Set when the sync failed outright: the reason, for job health and operators. */
  error?: string;
}

/** Fixture sync for ONE sport, driven entirely by its sport-registry row. The NFL's behaviour is exactly what it was; every other sport runs this same code. */
export async function runSportFixtureSync(config: SportConfig, now: Date = new Date()): Promise<SportSyncResult> {
  const result: SportSyncResult = {
    checked: 0,
    refreshed: 0,
    skipped: 0,
    pendingMatchup: 0,
    failed: 0,
    resultsConfirmed: 0,
    resultsCorrected: 0,
    resultsFailed: 0,
    nonFranchise: 0,
  };

  const provider: SportsOddsProvider | null = getOddsProvider(config.provider);
  if (!provider || !provider.isEnabled()) return result;

  // This job previously had no circuit-breaker or quota-reserve check at
  // all — it would keep hitting API-NFL on every cron tick even after a
  // confirmed quota-exhaustion error. Same guards every provider-calling
  // job in this app applies, now applied here too.
  const status = await getProviderStatus(true, config.provider);
  if (status.circuitBreakerOpen) return result;
  if (await shouldReserveQuota(config.provider)) return result;

  const league = config.leagues[0];
  if (!league?.externalLeagueId) return result;

  const admin = createAdminClient();
  // The NFL league year runs Aug-Feb; API-NFL's `season` param is the
  // calendar year the season STARTS in (confirmed live: the 2026 season,
  // Aug 2026-Feb 2027, is season=2026) — plain UTC year is correct here
  // even in the Jan/Feb tail of a season, unlike a naive "current year"
  // guess for a Jan-Dec league.
  // (Other sports name seasons differently — "2026-2027" for the NBA, the start year for the NHL — which is exactly what config.seasonFor encodes.)
  const currentSeason = config.seasonFor(now);

  let fixtures: NormalizedFixture[];
  try {
    fixtures = await provider.getSeasonFixtures(league.externalLeagueId, currentSeason);
  } catch (error) {
    result.failed = 1;
    result.error = extractErrorMessage(error, "season fetch failed");
    return result;
  }

  // Leagues whose game list also carries exhibition "teams" (the NBA All-Star games) import only real franchises. Fail closed: if the franchise
  // set cannot be established, import nothing rather than let an exhibition team become a Team and a Community.
  if (config.franchiseSource === "standings") {
    const franchises = await resolveFranchises(provider, config, league.externalLeagueId, now);
    if (!franchises) {
      result.failed = 1;
      result.error = "franchise set unavailable (no standings for this or the previous season)";
      return result;
    }
    fixtures = fixtures.filter((f) => {
      const isFranchiseGame = f.homeTeamExternalId != null && f.awayTeamExternalId != null && franchises.has(f.homeTeamExternalId) && franchises.has(f.awayTeamExternalId);
      if (!isFranchiseGame) result.nonFranchise++;
      return isFranchiseGame;
    });
  }

  const { data: existingRows } = await admin
    .from("fixtures")
    .select("id, external_fixture_id, internal_status")
    .eq("provider", config.provider);
  const storedTerminal = new Set(
    (existingRows ?? [])
      .filter((row) => TERMINAL_STATUSES.includes(row.internal_status as FixtureInternalStatus))
      .map((row) => row.external_fixture_id),
  );
  // Confirmed-result reconciliation below needs the internal fixture id
  // (the FK nfl_game_results.fixture_id points at), keyed by the same
  // external_fixture_id the provider array uses.
  const fixtureIdByExternalId = new Map(
    (existingRows ?? []).map((row) => [row.external_fixture_id, row.id as string]),
  );

  // Batched, not per-fixture (see upsertFixturesBatch's own comment) — a
  // first-ever sync writing ~320 new games serially, 3 round trips each,
  // measured in production to exceed cron-job.org's fixed 30s job
  // timeout. One round trip per table regardless of season size instead.
  const toUpsert = fixtures.filter((fixture) => {
    result.checked++;
    if (storedTerminal.has(fixture.externalFixtureId)) {
      result.skipped++;
      return false;
    }
    if (fixture.homeTeamName == null || fixture.awayTeamName == null) {
      result.pendingMatchup++;
      return false;
    }
    return true;
  });

  if (toUpsert.length > 0) {
    try {
      await upsertFixturesBatch(admin, toUpsert);
      result.refreshed += toUpsert.length;
    } catch (error) {
      result.failed += toUpsert.length;
      // extractErrorMessage, not `error instanceof Error ? ... : "unknown
      // error"` — upsertFixturesBatch throws the raw PostgrestError object
      // on a DB failure (persist.ts: `if (fixturesError) throw
      // fixturesError`), which is a plain object with a real `.message`,
      // never an Error instance. The old check silently discarded that
      // message on every real failure here — confirmed live during this
      // operational phase's verification run.
      await admin
        .from("fixtures")
        .update({ sync_error: extractErrorMessage(error, "unknown error") })
        .eq("provider", config.provider)
        .in("external_fixture_id", toUpsert.map((f) => f.externalFixtureId));
    }
  }

  // Confirmed-result reconciliation — deliberately a SEPARATE pass over the
  // freshly-fetched provider array, independent of the storedTerminal skip
  // above. A naive "check right after upsertFixture" hook would only ever
  // fire the single tick a fixture first becomes COMPLETED, since terminal
  // fixtures are skipped on every later tick and fixtures.regulation_*_score
  // itself is frozen for them — a later provider stat correction would
  // never be seen. This pass instead diffs every COMPLETED fixture against
  // nfl_game_results on every tick, regardless of the upsert skip above.
  const completedFixtures = fixtures.filter((f) => f.internalStatus === "COMPLETED");
  if (completedFixtures.length > 0) {
    const fixtureIds = completedFixtures
      .map((f) => fixtureIdByExternalId.get(f.externalFixtureId))
      .filter((id): id is string => id != null);

    const { data: currentResults } = await admin
      .from("nfl_game_results")
      .select("id, fixture_id, home_final_score, away_final_score")
      .in("fixture_id", fixtureIds)
      .eq("is_current", true);
    const currentByFixtureId = new Map((currentResults ?? []).map((r) => [r.fixture_id as string, r]));

    for (const fixture of completedFixtures) {
      // A fixture that's brand new AND already COMPLETED in the very same
      // tick it's first synced has no id here yet (fixtureIdByExternalId
      // was built before this tick's upserts ran) — picked up automatically
      // next tick. In practice every completed NFL game's fixture row was
      // already created (as NOT_STARTED) days/weeks earlier during the
      // season-wide sync, so this gap is not expected to occur for real.
      const fixtureId = fixtureIdByExternalId.get(fixture.externalFixtureId);
      if (!fixtureId) continue;
      if (fixture.regulationHomeScore == null || fixture.regulationAwayScore == null) continue;

      try {
        const current = currentByFixtureId.get(fixtureId);
        if (!current) {
          const { error } = await admin.from("nfl_game_results").insert({
            fixture_id: fixtureId,
            home_team_external_id: fixture.homeTeamExternalId,
            away_team_external_id: fixture.awayTeamExternalId,
            home_final_score: fixture.regulationHomeScore,
            away_final_score: fixture.regulationAwayScore,
            status: "CONFIRMED",
            is_current: true,
          });
          if (error) throw error;
          result.resultsConfirmed++;
          continue;
        }

        const scoreChanged =
          current.home_final_score !== fixture.regulationHomeScore ||
          current.away_final_score !== fixture.regulationAwayScore;
        if (!scoreChanged) continue;

        const before = { home: current.home_final_score, away: current.away_final_score };
        const after = { home: fixture.regulationHomeScore, away: fixture.regulationAwayScore };

        const { error: flipError } = await admin
          .from("nfl_game_results")
          .update({ is_current: false })
          .eq("id", current.id);
        if (flipError) throw flipError;

        const { error: insertError } = await admin.from("nfl_game_results").insert({
          fixture_id: fixtureId,
          home_team_external_id: fixture.homeTeamExternalId,
          away_team_external_id: fixture.awayTeamExternalId,
          home_final_score: fixture.regulationHomeScore,
          away_final_score: fixture.regulationAwayScore,
          status: "CORRECTED",
          is_current: true,
        });
        if (insertError) throw insertError;

        await writeAuditLog({
          actorId: null,
          action: "nfl_game_result.corrected",
          entityType: "nfl_game_result",
          entityId: fixtureId,
          before,
          after,
        });
        result.resultsCorrected++;
      } catch {
        result.resultsFailed++;
      }
    }
  }

  // league_season_imports also backs the Events admin surface's "has odds
  // coverage" display (lib/fixtures/local-browse.ts reads its
  // coverage_snapshot) — without this upsert, upsertFixture above already
  // wrote correct fixtures/teams/leagues rows, but none of them would show
  // workspace/coverage metadata there. Football maintains this via the
  // full competition-import job system; NFL's equivalent is this one small
  // upsert, since there's only ever one row to maintain (a single
  // competition, no import-job queue needed for it).
  const { data: leagueRow } = await admin
    .from("leagues")
    .select("id")
    .eq("provider", config.provider)
    .eq("external_id", league.externalLeagueId)
    .maybeSingle();

  if (leagueRow) {
    // Phase 3 fix: this getLeagueById call previously had no try/catch —
    // a failure here (network blip, quota exhausted mid-tick) threw
    // straight out of runNflFixtureSync, discarding the already-correct
    // result computed above (fixtures had already synced successfully;
    // only the informational league_season_imports metadata refresh was
    // still pending). recordJobRun still caught and logged the throw, but
    // the caller never saw the real result — the whole tick reported as a
    // hard failure even though most of the work had already succeeded.
    try {
      const providerLeague = await provider.getLeagueById(league.externalLeagueId);
      const currentSeasonInfo = providerLeague?.seasons.find((s) => s.year === currentSeason);

      await admin.from("league_season_imports").upsert(
        {
          provider: config.provider,
          external_league_id: league.externalLeagueId,
          season: currentSeason,
          league_id: leagueRow.id,
          season_start_date: currentSeasonInfo?.startDate ?? null,
          season_end_date: currentSeasonInfo?.endDate ?? null,
          provider_current: currentSeasonInfo?.current ?? true,
          import_status: "IMPORTED",
          imported_at: new Date().toISOString(),
          sync_status: "IDLE",
          last_synced_at: new Date().toISOString(),
          fixture_count_imported: result.refreshed,
          is_active: true,
        },
        { onConflict: "provider,external_league_id,season" },
      );
    } catch {
      // Swallowed deliberately — the fixture sync above already
      // succeeded and is reflected in `result`; a failure here only means
      // this tick's league_season_imports metadata refresh (season
      // start/end dates, "current season" flag) didn't happen, not that
      // the fixtures themselves are stale. The real failure is still
      // recorded in provider_request_log via fetchWithRetry. Next tick
      // retries this same upsert regardless of this tick's outcome.
    }
  }

  return result;
}

// ---- franchise set (standings), cached ------------------------------------------------------------------------------------------
// Franchises change at most once a year, so one standings read per league per process every 12 hours is plenty (and keeps the extra request
// out of the every-5-minutes budget). Falls back to the previous season's standings for a brand-new season whose table is still empty.
const FRANCHISE_TTL_MS = 12 * 60 * 60 * 1000;
const franchiseCache = new Map<string, { at: number; ids: Set<string> }>();

async function resolveFranchises(provider: SportsOddsProvider, config: SportConfig, leagueId: string, now: Date): Promise<Set<string> | null> {
  if (!provider.getFranchiseTeamExternalIds) return null;
  const key = `${config.provider}:${leagueId}:${config.seasonFor(now)}`;
  const cached = franchiseCache.get(key);
  if (cached && now.getTime() - cached.at < FRANCHISE_TTL_MS) return cached.ids;

  const previous = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
  for (const season of [config.seasonFor(now), config.seasonFor(previous)]) {
    const ids = await provider.getFranchiseTeamExternalIds(leagueId, season).catch(() => null);
    if (ids && ids.size > 0) {
      franchiseCache.set(key, { at: now.getTime(), ids });
      return ids;
    }
  }
  return null;
}

/** Test seam: forget cached franchise sets. */
export function resetFranchiseCacheForTests(): void {
  franchiseCache.clear();
}

// ---- all active sports -------------------------------------------------------------------------------------------------------------
export interface FixtureSyncSummary {
  /** Per-sport results, keyed by provider identity. */
  sports: Record<string, SportSyncResult>;
  /** One entry per sport whose sync failed outright — read by job health (a failure in one sport never stops another). */
  failures: Array<{ sport: string; provider: string; error: string }>;
}

/**
 * The one fixture-sync job (the existing `sync-fixtures-nfl` cron): every ACTIVE sport with a registered provider, in parallel and
 * failure-isolated — the NFL's sync can never be delayed or broken by another sport, and each sport's failure is reported with its sport and
 * provider so an operator never has to guess which one. Nothing here is sport-specific.
 */
export async function runFixtureSync(env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<FixtureSyncSummary> {
  const configs = activeSportConfigs(env).filter((c) => getOddsProvider(c.provider) !== null);
  const settled = await Promise.allSettled(configs.map((c) => runSportFixtureSync(c, now)));
  const summary: FixtureSyncSummary = { sports: {}, failures: [] };
  settled.forEach((outcome, i) => {
    const config = configs[i];
    if (outcome.status === "fulfilled") {
      summary.sports[config.provider] = outcome.value;
      if (outcome.value.failed > 0) {
        summary.failures.push({ sport: config.sport, provider: config.provider, error: outcome.value.error ?? `${outcome.value.failed} fixture(s) failed to sync` });
      }
    } else {
      summary.failures.push({ sport: config.sport, provider: config.provider, error: errorMessage(outcome.reason) });
    }
  });
  return summary;
}
