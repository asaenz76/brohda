"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { buildImportChunks, chunkPayloadBytes } from "@/lib/competitions/import-chunks";
import { processImportChunk } from "@/lib/competitions/process-chunk";
import { syncOneCompetition } from "@/lib/competitions/discovery-sync";
import { IMPORT_JOB_MAX_ATTEMPTS } from "@/lib/competitions/constants";
import { SUPPORTED_COMPETITIONS, isSupportedCompetition, type SupportedCompetition } from "@/lib/sports-data/supported-competitions";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import {
  ACTIVATION_WINDOW_DAYS,
  AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS,
  RECOMMENDATION_WINDOW_DAYS,
} from "@/lib/competitions/constants";
import { refreshRecommendationAvailabilityCache } from "@/lib/competitions/availability-cache";
import { isQuotaExhaustedError } from "@/lib/sports-data/provider-gateway";
import { API_FOOTBALL_PROVIDER } from "@/lib/sports-data/provider-names";
import {
  buildImportedCompetitionRows,
  buildRecommendedCompetitions,
  fixtureAggregatesFromRpcRows,
  type CompetitionRow,
  type LatestJobInfo,
  type LeagueSeasonImportRow,
  type RecommendedCompetition,
} from "@/lib/competitions/manager-data";

export interface StartCompetitionImportResult {
  success: boolean;
  error: string | null;
  leagueSeasonImportId: string | null;
  jobId: string | null;
}

/**
 * Starts a brand-new competition import — resolves league metadata,
 * fetches the whole season once (past+future, see getSeasonFixtures),
 * filters to upcoming fixtures only unless includeHistorical is set,
 * stages the result as job/chunk rows, and processes the first chunk
 * synchronously so small imports finish without waiting for the next cron
 * tick. Only for a competition with no existing tracking row — retrying a
 * failed import goes through retryCompetitionImportAction instead, which
 * resumes the existing job's chunks rather than re-fetching from scratch.
 */
export async function startCompetitionImportAction(
  externalLeagueId: string,
  season: string,
  options: { includeHistorical?: boolean } = {},
): Promise<StartCompetitionImportResult> {
  const admin = await requireAdminOrAbove();
  const adminClient = createAdminClient();
  const fail = (error: string, leagueSeasonImportId: string | null = null): StartCompetitionImportResult => ({
    success: false,
    error,
    leagueSeasonImportId,
    jobId: null,
  });

  if (!apiFootballProvider.isEnabled()) {
    return fail("The sports data provider is not enabled.");
  }
  if (!externalLeagueId.trim() || !season.trim()) {
    return fail("A league and season are required.");
  }
  // PollPools is a curated platform, not a generic browser over every
  // competition API-Football knows about — importing (and therefore
  // synchronizing, recommending, tracking) a competition outside
  // SUPPORTED_COMPETITIONS would silently reopen exactly the unbounded
  // provider-quota surface this boundary exists to close.
  if (!isSupportedCompetition(externalLeagueId)) {
    return fail("This competition isn't in PollPools' supported list.");
  }

  const { data: existing } = await adminClient
    .from("league_season_imports")
    .select("id, import_status")
    .eq("provider", API_FOOTBALL_PROVIDER)
    .eq("external_league_id", externalLeagueId)
    .eq("season", season)
    .maybeSingle();

  // Anything other than "no row" or "a previously failed attempt" already
  // has (or is getting) its own tracking record — re-importing it here
  // would just race the existing job/duplicate the unique constraint;
  // Sync/Retry are the right actions for those instead.
  if (existing && existing.import_status !== "IMPORT_FAILED") {
    return fail("This competition has already been imported or is currently importing.", existing.id);
  }

  // Caught explicitly (not left to throw uncaught out of this server
  // action) so a provider quota/rate-limit hit — a known, expected
  // operational condition, not a bug — surfaces as a clean admin-facing
  // message instead of an unhandled exception. isQuotaExhaustedError's own
  // circuit-breaker read is still what prevents this action from being
  // retried into a further-exhausted quota; this catch is purely about
  // this one request's error not crashing the action.
  let league;
  try {
    league = await apiFootballProvider.getLeagueById(externalLeagueId);
  } catch (err) {
    return fail(
      isQuotaExhaustedError(err)
        ? "The sports data provider's request quota is exhausted right now. Try again later."
        : "Could not reach the sports data provider.",
    );
  }
  if (!league) {
    return fail("Could not find this league with the sports data provider.");
  }
  const seasonMeta = league.seasons.find((s) => s.year === season) ?? null;

  const { data: leagueRow, error: leagueError } = await adminClient
    .from("leagues")
    .upsert(
      { provider: API_FOOTBALL_PROVIDER, external_id: externalLeagueId, name: league.name, logo_url: league.logoUrl },
      { onConflict: "provider,external_id" },
    )
    .select("id")
    .single();
  if (leagueError || !leagueRow) {
    return fail("Could not save league metadata.");
  }

  const lsiPayload = {
    provider: API_FOOTBALL_PROVIDER,
    external_league_id: externalLeagueId,
    season,
    league_id: leagueRow.id,
    import_status: "IMPORTING",
    season_start_date: seasonMeta?.startDate ?? null,
    season_end_date: seasonMeta?.endDate ?? null,
    provider_current: seasonMeta?.current ?? false,
    coverage_snapshot: seasonMeta?.coverage ?? null,
    coverage_checked_at: new Date().toISOString(),
  };

  const { data: lsi, error: lsiError } = existing
    ? await adminClient.from("league_season_imports").update(lsiPayload).eq("id", existing.id).select("id").single()
    : await adminClient.from("league_season_imports").insert(lsiPayload).select("id").single();
  if (lsiError || !lsi) {
    return fail("Could not create the competition tracking record.");
  }

  let allFixtures;
  try {
    allFixtures = await apiFootballProvider.getSeasonFixtures(externalLeagueId, season);
  } catch (err) {
    await adminClient
      .from("league_season_imports")
      .update({ import_status: "IMPORT_FAILED", last_sync_error: err instanceof Error ? err.message : "Fetch failed" })
      .eq("id", lsi.id);
    return fail("Could not fetch fixtures for this competition from the sports data provider.", lsi.id);
  }

  // Complete-season storage is the normal behavior for a supported
  // competition (Phase 1 of the universal sports architecture proposal,
  // 2026-08): the provider already returns the whole season — past,
  // current, and future — in the one getSeasonFixtures call above, so
  // storing all of it costs no extra provider requests, only a filter
  // decision on what to do with a response already in hand. No caller in
  // the admin UI ever passes `options.includeHistorical` explicitly today
  // (confirmed: every "Import"/"Import selected"/"Import all recommended"
  // call site omits it) — flipping the default here is the entire change
  // needed for every normal import to become complete-season, with no UI
  // changes. The option itself stays available as an explicit override for
  // any future caller that genuinely wants future-only.
  const includeHistorical = options.includeHistorical ?? true;
  const now = Date.now();
  const fixturesToImport = includeHistorical
    ? allFixtures
    : allFixtures.filter((f) => new Date(f.scheduledStartUtc).getTime() > now);

  const chunks = buildImportChunks(fixturesToImport);

  const { data: job, error: jobError } = await adminClient
    .from("competition_import_jobs")
    .insert({
      league_season_import_id: lsi.id,
      status: "PENDING",
      include_historical: includeHistorical,
      total_fixtures: fixturesToImport.length,
      max_attempts: IMPORT_JOB_MAX_ATTEMPTS,
      started_at: new Date().toISOString(),
    })
    .select("id, max_attempts")
    .single();

  if (jobError || !job) {
    // 23505 = unique_violation — the partial unique index caught a
    // concurrent second import start for the same competition.
    if (jobError?.code === "23505") {
      return fail("An import is already in progress for this competition.", lsi.id);
    }
    return fail("Could not start the import job.", lsi.id);
  }

  if (chunks.length > 0) {
    const chunkRows = chunks.map((fixturesInChunk, index) => ({
      job_id: job.id,
      chunk_index: index,
      fixtures_payload: fixturesInChunk,
      fixture_count: fixturesInChunk.length,
      payload_bytes: chunkPayloadBytes(fixturesInChunk),
    }));
    const { error: chunksError } = await adminClient.from("competition_import_job_chunks").insert(chunkRows);
    if (chunksError) {
      await adminClient
        .from("competition_import_jobs")
        .update({ status: "FAILED", last_error: "Could not create import chunks." })
        .eq("id", job.id);
      await adminClient.from("league_season_imports").update({ import_status: "IMPORT_FAILED" }).eq("id", lsi.id);
      return fail("Could not stage fixtures for import.", lsi.id);
    }
  }

  // Process the first chunk right away so a small import (most
  // competitions realistically fit in one chunk) finishes without waiting
  // for the next cron tick — everything after this is the cron's job.
  const { data: claimed } = await adminClient.rpc("claim_import_job_chunks", {
    p_limit: 1,
    p_max_attempts: job.max_attempts,
  });
  if (claimed && claimed.length > 0) {
    const chunk = claimed[0];
    const result = await processImportChunk(adminClient, chunk);
    await adminClient
      .from("competition_import_job_chunks")
      .update(
        result.success
          ? { status: "SUCCEEDED", processed_at: new Date().toISOString() }
          : { status: "FAILED", last_error: result.error },
      )
      .eq("id", chunk.id);
    await adminClient.rpc("recalculate_import_job_progress", { p_job_id: job.id, p_max_attempts: job.max_attempts });
  }

  const { data: finalJob } = await adminClient
    .from("competition_import_jobs")
    .select("status")
    .eq("id", job.id)
    .single();

  if (finalJob?.status === "SUCCEEDED") {
    const upcoming = fixturesToImport.filter((f) => new Date(f.scheduledStartUtc).getTime() > now).length;
    const latestProviderFixtureAt = allFixtures.reduce<string | null>(
      (latest, f) => (!latest || f.scheduledStartUtc > latest ? f.scheduledStartUtc : latest),
      null,
    );
    await adminClient
      .from("league_season_imports")
      .update({
        import_status: "IMPORTED",
        imported_at: new Date().toISOString(),
        fixture_count_imported: fixturesToImport.length,
        upcoming_fixture_count: upcoming,
        completed_fixture_count: fixturesToImport.length - upcoming,
        provider_fixture_count: allFixtures.length,
        latest_provider_fixture_at: latestProviderFixtureAt,
        last_synced_at: new Date().toISOString(),
        last_fixture_discovery_at: new Date().toISOString(),
        sync_status: "IDLE",
      })
      .eq("id", lsi.id);
  } else if (finalJob?.status === "FAILED") {
    await adminClient.from("league_season_imports").update({ import_status: "IMPORT_FAILED" }).eq("id", lsi.id);
  }
  // If neither SUCCEEDED nor FAILED yet (still RUNNING — more chunks left
  // for the cron), league_season_imports stays IMPORTING until a later
  // cron tick finalizes it.

  await writeAuditLog({
    actorId: admin.id,
    action: "competition.import_started",
    entityType: "league_season_import",
    entityId: lsi.id,
    after: { externalLeagueId, season, totalFixtures: fixturesToImport.length, includeHistorical },
  });

  revalidatePath("/admin/competitions");

  return { success: true, error: null, leagueSeasonImportId: lsi.id, jobId: job.id };
}

export interface RetryCompetitionImportResult {
  success: boolean;
  error: string | null;
}

/**
 * Resumes a FAILED import job — no new provider call, no new job row.
 * Every chunk that exhausted its attempts gets a fresh attempt budget
 * (its fixtures_payload is still there; only a SUCCEEDED chunk's payload
 * is ever reclaimed), then the job is recalculated so the cron (or an
 * immediate synchronous pass here) picks it back up.
 */
export async function retryCompetitionImportAction(jobId: string): Promise<RetryCompetitionImportResult> {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { data: job } = await adminClient
    .from("competition_import_jobs")
    .select("id, status, max_attempts, league_season_import_id")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return { success: false, error: "Import job not found." };
  if (job.status !== "FAILED") return { success: false, error: "Only a failed import can be retried." };

  const { error: resetError } = await adminClient
    .from("competition_import_job_chunks")
    .update({ status: "PENDING", attempt_count: 0, last_error: null })
    .eq("job_id", jobId)
    .eq("status", "FAILED");
  if (resetError) return { success: false, error: "Could not reset failed chunks." };

  await adminClient.from("league_season_imports").update({ import_status: "IMPORTING" }).eq("id", job.league_season_import_id);

  // Process one chunk synchronously for responsiveness, same as the start
  // action — the cron picks up whatever's left.
  const { data: claimed } = await adminClient.rpc("claim_import_job_chunks", {
    p_limit: 1,
    p_max_attempts: job.max_attempts,
  });
  if (claimed && claimed.length > 0) {
    const chunk = claimed[0];
    const result = await processImportChunk(adminClient, chunk);
    await adminClient
      .from("competition_import_job_chunks")
      .update(
        result.success
          ? { status: "SUCCEEDED", processed_at: new Date().toISOString() }
          : { status: "FAILED", last_error: result.error },
      )
      .eq("id", chunk.id);
  }
  await adminClient.rpc("recalculate_import_job_progress", { p_job_id: jobId, p_max_attempts: job.max_attempts });

  const { data: finalJob } = await adminClient.from("competition_import_jobs").select("status").eq("id", jobId).single();
  if (finalJob?.status === "SUCCEEDED") {
    await adminClient
      .from("league_season_imports")
      .update({ import_status: "IMPORTED", imported_at: new Date().toISOString() })
      .eq("id", job.league_season_import_id);
  } else if (finalJob?.status === "FAILED") {
    await adminClient.from("league_season_imports").update({ import_status: "IMPORT_FAILED" }).eq("id", job.league_season_import_id);
  }

  revalidatePath("/admin/competitions");
  return { success: true, error: null };
}

export type { RecommendedCompetition } from "@/lib/competitions/manager-data";

// Distinguishes "the cache genuinely has no recommendations right now"
// from "we don't actually know yet" — see the Recommended tab's empty
// states, which must never silently render the two the same way.
export type RecommendationCacheStatus = "NOT_CHECKED" | "STALE" | "FRESH";

export interface AllCompetitionsRow {
  competition: SupportedCompetition & { externalLeagueId: string }; // only resolved+enabled entries ever appear here
  importedRow: CompetitionRow | null;
}

export interface CompetitionManagerData {
  recommended: RecommendedCompetition[];
  recommendedCacheStatus: RecommendationCacheStatus;
  recommendedCacheCheckedAt: string | null; // oldest checked_at among supported competitions, for "last checked" display
  // How many SUPPORTED_COMPETITIONS entries have a resolved current
  // season on record at all (via the availability cache) — the
  // denominator for "all already imported."
  supportedCompetitionsEligible: number;
  supportedCompetitionsAlreadyImported: number;
  // Every imported (league, season) row, supported or not — an
  // already-imported competition that later fell out of the supported
  // list keeps its data and stays visible here (tagged Unsupported), per
  // the "data must remain intact" requirement; it's just excluded from
  // Needs attention and Recommended, and never synchronized again.
  imported: CompetitionRow[];
  needsAttention: CompetitionRow[];
  // The full supported catalog (enabled, resolved entries only) joined
  // against import state — this is what "All competitions" now shows,
  // never a live provider catalog. A not-yet-imported entry has no
  // season/coverage/logo data here (that would need a live call) — only
  // what SUPPORTED_COMPETITIONS itself carries; clicking Import resolves
  // the rest live, as an explicit action.
  allSupported: AllCompetitionsRow[];
}

// Phase 4.1: getCompetitionManagerDataAction used to return
// CompetitionManagerData directly, with every query's `error` destructured
// away and discarded (`{ data: lsiRows }`) — a DB failure silently
// degraded to `[]`, which the UI then rendered as "no competitions" /
// "no imports," indistinguishable from a genuinely empty, healthy state.
// This discriminated result makes that distinction explicit at the type
// level: every caller must now handle `success: false` before it can even
// read `.data`.
export type CompetitionManagerDataResult = { success: true; data: CompetitionManagerData } | { success: false; error: string };

const COMPETITION_DATA_LOAD_ERROR = "Competition data could not be loaded.";

/**
 * Assembles everything the /admin/competitions list needs, across its 4
 * tabs — entirely from the database and the static SUPPORTED_COMPETITIONS
 * config, zero provider calls. This used to fetch the full live provider
 * catalog (searchLeagues("")) on every page load; that call is exactly
 * what took the whole page down during a quota-exhaustion incident (see
 * git history) and, more fundamentally, fetched hundreds of leagues
 * PollPools will never support just to enrich country/type metadata this
 * config now supplies directly.
 *
 * All 5 underlying queries are treated as required, not independently
 * partial-renderable: the second round (leagues/aggregates/jobs) is
 * derived from IDs read out of the first round's rows, so a silently
 * degraded first round would also silently starve the second round of
 * anything to look up — there's no safe "show what we have" split here
 * without risking exactly the kind of misleading partial state (e.g. a
 * real competition rendered with no fixture counts, indistinguishable
 * from one that genuinely has none) this fix exists to prevent. Any
 * query failure fails the whole action; the real Postgrest error is
 * logged server-side (never sent to the client) via console.error, which
 * this deployment's error monitoring picks up.
 */
export async function getCompetitionManagerDataAction(): Promise<CompetitionManagerDataResult> {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const [lsiResult, cacheResult] = await Promise.all([
    adminClient.from("league_season_imports").select("*"),
    adminClient
      .from("competition_availability_cache")
      .select("external_league_id, season, upcoming_fixture_count, next_fixture_at, checked_at"),
  ]);
  if (lsiResult.error || cacheResult.error) {
    console.error("[getCompetitionManagerDataAction] failed to load league_season_imports/competition_availability_cache", {
      lsiError: lsiResult.error,
      cacheError: cacheResult.error,
    });
    return { success: false, error: COMPETITION_DATA_LOAD_ERROR };
  }
  const lsiRows = lsiResult.data;
  const cacheRows = cacheResult.data;

  const latestSeasonByExternalId = new Map((cacheRows ?? []).map((r) => [r.external_league_id, r.season]));

  const rows = (lsiRows ?? []) as LeagueSeasonImportRow[];
  const leagueIds = [...new Set(rows.map((r) => r.league_id))];
  const externalLeagueIds = [...new Set(rows.map((r) => r.external_league_id))];

  const [leaguesResult, aggregatesResult, jobsResult] = await Promise.all([
    leagueIds.length > 0
      ? adminClient.from("leagues").select("id, name, logo_url").in("id", leagueIds)
      : Promise.resolve({ data: [], error: null }),
    // Aggregated server-side, not fetched as raw rows — see
    // get_competition_fixture_aggregates's own comment: an unordered
    // `.in()` select over every fixture across every imported competition
    // silently truncates past PostgREST's default 1000-row cap once the
    // total crosses that (a real production incident, not hypothetical),
    // making an arbitrary competition's future fixtures vanish from the
    // aggregate while its past ones remain.
    externalLeagueIds.length > 0
      ? adminClient.rpc("get_competition_fixture_aggregates", {
          p_external_league_ids: externalLeagueIds,
          p_terminal_statuses: [...TERMINAL_STATUSES],
          p_activation_window_days: ACTIVATION_WINDOW_DAYS,
          p_recommendation_window_days: RECOMMENDATION_WINDOW_DAYS,
        })
      : Promise.resolve({ data: [], error: null }),
    rows.length > 0
      ? adminClient
          .from("competition_import_jobs")
          .select("id, league_season_import_id, status, created_at")
          .in(
            "league_season_import_id",
            rows.map((r) => r.id),
          )
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (leaguesResult.error || aggregatesResult.error || jobsResult.error) {
    console.error("[getCompetitionManagerDataAction] failed to load leagues/fixture-aggregates/import-jobs", {
      leaguesError: leaguesResult.error,
      aggregatesError: aggregatesResult.error,
      jobsError: jobsResult.error,
    });
    return { success: false, error: COMPETITION_DATA_LOAD_ERROR };
  }
  const leagueRows = leaguesResult.data;
  const fixtureAggregateRows = aggregatesResult.data;
  const jobRows = jobsResult.data;

  const leaguesById = new Map((leagueRows ?? []).map((l) => [l.id, l]));
  // countryName/type now come from SUPPORTED_COMPETITIONS via
  // buildImportedCompetitionRows itself for supported rows; an
  // already-imported-but-now-unsupported row has no config entry to read
  // from, so it falls back to whatever it was last known as — there's no
  // live source to re-resolve it from anymore, and none should be spent
  // on a competition PollPools deliberately stopped tracking.
  const countryByExternalId = new Map<string, string | null>();
  const typeByExternalId = new Map<string, string | null>();

  const fixtureAggregates = fixtureAggregatesFromRpcRows(fixtureAggregateRows ?? []);

  const latestJobs = new Map<string, LatestJobInfo>();
  for (const job of jobRows ?? []) {
    if (!latestJobs.has(job.league_season_import_id)) {
      latestJobs.set(job.league_season_import_id, {
        leagueSeasonImportId: job.league_season_import_id,
        jobId: job.id,
        status: job.status,
      });
    }
  }

  const importedRows = buildImportedCompetitionRows(
    rows,
    leaguesById,
    countryByExternalId,
    typeByExternalId,
    fixtureAggregates,
    latestSeasonByExternalId,
    latestJobs,
  );

  const importedKeys = new Set(rows.map((r) => `${r.external_league_id}:${r.season}`));
  const importedByExternalLeagueId = new Map(importedRows.map((r) => [r.externalLeagueId, r]));

  const availabilityCacheRows = (cacheRows ?? []).map((r) => ({
    externalLeagueId: r.external_league_id,
    season: r.season,
    upcomingFixtureCount: r.upcoming_fixture_count,
    nextFixtureAt: r.next_fixture_at,
    checkedAt: r.checked_at,
  }));

  const { recommended, supportedCompetitionsEligible, supportedCompetitionsAlreadyImported, oldestCheckedAt } = buildRecommendedCompetitions(
    SUPPORTED_COMPETITIONS,
    importedKeys,
    availabilityCacheRows,
  );

  const notYetImportedEligible = supportedCompetitionsEligible - supportedCompetitionsAlreadyImported;
  const recommendedCacheStatus: RecommendationCacheStatus =
    notYetImportedEligible > 0 && oldestCheckedAt == null
      ? "NOT_CHECKED"
      : oldestCheckedAt && Date.now() - new Date(oldestCheckedAt).getTime() > AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS * 3600_000
        ? "STALE"
        : "FRESH";

  const allSupported: AllCompetitionsRow[] = SUPPORTED_COMPETITIONS.filter(
    (c): c is SupportedCompetition & { externalLeagueId: string } => c.enabled && c.externalLeagueId != null,
  ).map((competition) => ({
    competition,
    importedRow: importedByExternalLeagueId.get(competition.externalLeagueId) ?? null,
  }));

  return {
    success: true,
    data: {
      recommended,
      recommendedCacheStatus,
      recommendedCacheCheckedAt: oldestCheckedAt,
      supportedCompetitionsEligible,
      supportedCompetitionsAlreadyImported,
      imported: importedRows,
      // Kept in lockstep with the badge itself (operationalStatus), not a
      // separate reasons-based check — otherwise a normal Completed or
      // No-upcoming-fixtures competition (which still carries an advisory
      // reason, e.g. "consider archiving") would flood this tab despite its
      // badge saying something else entirely. UNSUPPORTED rows never carry
      // any needs-attention reason (see status.ts), so they're naturally
      // excluded here too.
      needsAttention: importedRows.filter((r) => r.operationalStatus === "NEEDS_ATTENTION"),
      allSupported,
    },
  };
}

/**
 * "All competitions" tab's Import action — resolves the competition's
 * current season live (a real, but explicit and admin-initiated, provider
 * call) and hands off to startCompetitionImportAction. Kept separate from
 * that function because every other caller already knows the season
 * (picked from a live-fetched league in by-competition search, or read
 * back from an existing tracking row) — this is the only path that needs
 * to resolve "current season" itself first.
 */
export async function importSupportedCompetitionAction(externalLeagueId: string): Promise<StartCompetitionImportResult> {
  await requireAdminOrAbove();
  const fail = (error: string): StartCompetitionImportResult => ({ success: false, error, leagueSeasonImportId: null, jobId: null });

  if (!isSupportedCompetition(externalLeagueId)) {
    return fail("This competition isn't in PollPools' supported list.");
  }
  if (!apiFootballProvider.isEnabled()) {
    return fail("The sports data provider is not enabled.");
  }

  // Caught explicitly for the same reason as startCompetitionImportAction's
  // own getLeagueById call — a quota/rate-limit hit is an expected
  // operational condition, not a bug, and should surface as a clean
  // message rather than an unhandled exception out of this server action.
  let league;
  try {
    league = await apiFootballProvider.getLeagueById(externalLeagueId);
  } catch (err) {
    return fail(
      isQuotaExhaustedError(err)
        ? "The sports data provider's request quota is exhausted right now. Try again later."
        : "Could not reach the sports data provider.",
    );
  }
  const currentSeason = league?.seasons.find((s) => s.current);
  if (!currentSeason) {
    return fail("The provider has no current season for this competition right now.");
  }

  return startCompetitionImportAction(externalLeagueId, currentSeason.year);
}

export interface RefreshRecommendationsResult {
  success: boolean;
  error: string | null;
  checked: number;
  refreshed: number;
  errors: number;
}

/** Manual "Refresh recommendations" — the Recommended tab's only way to
 * populate/update the availability cache today, since no scheduler is
 * currently configured to call the refresh-recommendation-cache cron on
 * its own (confirmed: no crons are registered anywhere in this project).
 * Forces a real check of every priority league regardless of its own
 * per-row TTL, since an admin clicking this explicitly wants fresh data
 * now, not whatever happens to already be due. */
export async function refreshRecommendationsNowAction(): Promise<RefreshRecommendationsResult> {
  await requireAdminOrAbove();

  if (!apiFootballProvider.isEnabled()) {
    return { success: false, error: "The sports data provider is not enabled.", checked: 0, refreshed: 0, errors: 0 };
  }

  const result = await refreshRecommendationAvailabilityCache({ force: true });
  revalidatePath("/admin/competitions");
  return { success: true, error: null, ...result };
}


export interface WorkspaceActionResult {
  success: boolean;
  error: string | null;
}

/** On-demand discovery sync for one competition — the Workspace's "Sync
 * now," independent of the discovery cron's own schedule. */
export async function syncCompetitionNowAction(leagueSeasonImportId: string): Promise<WorkspaceActionResult> {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { data: lsi } = await adminClient
    .from("league_season_imports")
    .select("id, external_league_id, season")
    .eq("id", leagueSeasonImportId)
    .maybeSingle();
  if (!lsi) return { success: false, error: "Competition not found." };

  const outcome = await syncOneCompetition(adminClient, lsi);

  revalidatePath(`/admin/competitions/${leagueSeasonImportId}`);
  revalidatePath("/admin/competitions");
  return { success: outcome.success, error: outcome.error };
}

/** Archives (or un-archives) a competition — independent of
 * pool_creation_enabled, matching the plan's distinction between
 * lifecycle state and admin-intent eligibility. */
export async function setCompetitionArchivedAction(
  leagueSeasonImportId: string,
  archived: boolean,
): Promise<WorkspaceActionResult> {
  const admin = await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from("league_season_imports")
    .update({ is_active: !archived, archived_at: archived ? new Date().toISOString() : null })
    .eq("id", leagueSeasonImportId);
  if (error) return { success: false, error: "Could not update this competition." };

  await writeAuditLog({
    actorId: admin.id,
    action: archived ? "competition.archived" : "competition.unarchived",
    entityType: "league_season_import",
    entityId: leagueSeasonImportId,
    after: { archived },
  });

  revalidatePath(`/admin/competitions/${leagueSeasonImportId}`);
  revalidatePath("/admin/competitions");
  return { success: true, error: null };
}

/** Pool-creation eligibility toggle — deliberately independent of
 * is_active/archived_at (an admin can pull a healthy, active competition
 * out of the pool creator without archiving it). */
export async function setPoolCreationEnabledAction(
  leagueSeasonImportId: string,
  enabled: boolean,
): Promise<WorkspaceActionResult> {
  const admin = await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from("league_season_imports")
    .update({ pool_creation_enabled: enabled })
    .eq("id", leagueSeasonImportId);
  if (error) return { success: false, error: "Could not update this competition." };

  await writeAuditLog({
    actorId: admin.id,
    action: "competition.pool_creation_enabled_changed",
    entityType: "league_season_import",
    entityId: leagueSeasonImportId,
    after: { poolCreationEnabled: enabled },
  });

  revalidatePath(`/admin/competitions/${leagueSeasonImportId}`);
  revalidatePath("/admin/pools/new");
  return { success: true, error: null };
}

/** Starts a new import job for an already-imported competition, this time
 * including historical (already-played) fixtures — reuses
 * startCompetitionImportAction's full pipeline via the same external
 * league id/season, since the historical-inclusive fetch is identical
 * except for what gets written afterward. */
export async function importHistoricalFixturesAction(leagueSeasonImportId: string): Promise<StartCompetitionImportResult> {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { data: lsi } = await adminClient
    .from("league_season_imports")
    .select("external_league_id, season, import_status")
    .eq("id", leagueSeasonImportId)
    .maybeSingle();
  if (!lsi) return { success: false, error: "Competition not found.", leagueSeasonImportId: null, jobId: null };
  if (lsi.import_status === "IMPORTING") {
    return { success: false, error: "An import is already in progress for this competition.", leagueSeasonImportId, jobId: null };
  }

  // startCompetitionImportAction only proceeds against an existing row
  // when its status is IMPORT_FAILED (the "retry" case) — flip to that
  // state deliberately so this intentional re-import (not a duplicate)
  // reuses the exact same tested pipeline instead of a parallel one.
  await adminClient.from("league_season_imports").update({ import_status: "IMPORT_FAILED" }).eq("id", leagueSeasonImportId);

  return startCompetitionImportAction(lsi.external_league_id, lsi.season, { includeHistorical: true });
}
