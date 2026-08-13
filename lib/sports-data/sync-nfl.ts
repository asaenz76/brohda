import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { apiNflProvider } from "./api-nfl-provider";
import { upsertFixturesBatch } from "./persist";
import { TERMINAL_STATUSES } from "./status-map";
import type { FixtureInternalStatus } from "./types";
import { SUPPORTED_NFL_COMPETITIONS } from "./supported-nfl-competitions";

// Deliberately much simpler than football's runFixtureSync (lib/sports-
// data/sync.ts): that job polls each of hundreds of individually-tracked
// fixtures at an adaptive per-fixture interval, because API-Football
// charges one request per fixture. API-NFL's getSeasonFixtures returns the
// ENTIRE season (confirmed live: 328 games for 2026, one request, no
// pagination) — there's nothing to gain from tracking per-fixture refresh
// timing here, and real gain (much less code, one code path instead of an
// adaptive-interval state machine) in not building one. The one thing
// still worth skipping is re-writing a fixture whose *stored* status is
// already terminal — a finished/cancelled game's score never changes
// again, so there's no reason to re-upsert it every tick.
export interface NflSyncResult {
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
  // Preseason/postseason games API-NFL includes in the same season-wide
  // response — deliberately excluded from *new* imports (see the
  // isNewRegularSeasonGame check below) per product scope: regular
  // season only, backend-enforced (never surfaced as a wizard toggle).
  // Only applies to fixtures this sync has never seen before — a fixture
  // already tracked (e.g. a preseason game with a pool already created
  // on it before this filter existed) keeps syncing normally so it can
  // finish its lifecycle and settle correctly, rather than freezing
  // mid-flight.
  outOfScope: number;
  failed: number;
  // Confirmed-result reconciliation (lib/pools/templates/nfl-confirmed-
  // result.ts is what actually reads these rows for grading) — counted
  // separately from refreshed/skipped since they measure a different pass.
  resultsConfirmed: number;
  resultsCorrected: number;
  resultsFailed: number;
}

// mapGame (api-nfl-provider.ts) joins the provider's raw `stage` field
// ("Pre Season" | "Regular Season" | "Post Season", confirmed live) with
// `week` into this single string — e.g. "Regular Season - Week 5",
// "Pre Season - Week 1", "Post Season - Super Bowl". Checking the prefix
// here avoids threading a second raw field through NormalizedFixture (a
// type shared with football, which has no equivalent stage concept) just
// for this one scope check.
function isRegularSeasonGame(fixture: { round: string | null }): boolean {
  return fixture.round?.startsWith("Regular Season") ?? false;
}

export async function runNflFixtureSync(): Promise<NflSyncResult> {
  const result: NflSyncResult = {
    checked: 0,
    refreshed: 0,
    skipped: 0,
    pendingMatchup: 0,
    outOfScope: 0,
    failed: 0,
    resultsConfirmed: 0,
    resultsCorrected: 0,
    resultsFailed: 0,
  };

  if (!apiNflProvider.isEnabled()) return result;

  const nfl = SUPPORTED_NFL_COMPETITIONS.find((c) => c.enabled);
  if (!nfl?.externalLeagueId) return result;

  const admin = createAdminClient();
  // The NFL league year runs Aug-Feb; API-NFL's `season` param is the
  // calendar year the season STARTS in (confirmed live: the 2026 season,
  // Aug 2026-Feb 2027, is season=2026) — plain UTC year is correct here
  // even in the Jan/Feb tail of a season, unlike a naive "current year"
  // guess for a Jan-Dec league.
  const currentSeason = String(new Date().getUTCFullYear());

  let fixtures;
  try {
    fixtures = await apiNflProvider.getSeasonFixtures(nfl.externalLeagueId, currentSeason);
  } catch {
    result.failed = 1;
    return result;
  }

  const { data: existingRows } = await admin
    .from("fixtures")
    .select("id, external_fixture_id, internal_status")
    .eq("provider", "api_nfl");
  const storedTerminal = new Set(
    (existingRows ?? [])
      .filter((row) => TERMINAL_STATUSES.includes(row.internal_status as FixtureInternalStatus))
      .map((row) => row.external_fixture_id),
  );
  // Every fixture this sync has ever tracked before, regardless of stage
  // — the regular-season-only scope filter below only ever blocks a
  // fixture NOT already in this set (a brand-new preseason/postseason
  // game), never one we're already tracking.
  const knownExternalIds = new Set((existingRows ?? []).map((row) => row.external_fixture_id));
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
    if (!knownExternalIds.has(fixture.externalFixtureId) && !isRegularSeasonGame(fixture)) {
      result.outOfScope++;
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
      await admin
        .from("fixtures")
        .update({ sync_error: error instanceof Error ? error.message : "unknown error" })
        .eq("provider", "api_nfl")
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

  // fixtures_available_for_pool_creation (the view every pool-creation
  // wizard query reads) requires a matching league_season_imports row
  // with import_status = 'IMPORTED' and pool_creation_enabled = true —
  // without this, upsertFixture above already wrote correct fixtures/
  // teams/leagues rows, but none of them would ever be selectable for a
  // pool. Football maintains this via the full competition-import job
  // system; NFL's equivalent is this one small upsert, since there's
  // only ever one row to maintain (a single competition, no import-job
  // queue needed for it).
  const { data: leagueRow } = await admin
    .from("leagues")
    .select("id")
    .eq("provider", "api_nfl")
    .eq("external_id", nfl.externalLeagueId)
    .maybeSingle();

  if (leagueRow) {
    const league = await apiNflProvider.getLeagueById(nfl.externalLeagueId);
    const currentSeasonInfo = league?.seasons.find((s) => s.year === currentSeason);

    await admin.from("league_season_imports").upsert(
      {
        provider: "api_nfl",
        external_league_id: nfl.externalLeagueId,
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
        pool_creation_enabled: true,
        is_active: true,
      },
      { onConflict: "provider,external_league_id,season" },
    );
  }

  return result;
}
