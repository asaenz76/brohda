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
import { PRIORITY_LEAGUES, getPriorityLeagueMap, type LeagueTier } from "@/lib/sports-data/priority-leagues";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import {
  ACTIVATION_WINDOW_DAYS,
  AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS,
  AVAILABILITY_CACHE_TTL_WITH_FIXTURES_HOURS,
  RECOMMENDATION_WINDOW_DAYS,
} from "@/lib/competitions/constants";
import { refreshRecommendationAvailabilityCache } from "@/lib/competitions/availability-cache";
import {
  buildImportedCompetitionRows,
  buildRecommendedCompetitions,
  fixtureAggregatesFromRpcRows,
  type CompetitionRow,
  type LatestJobInfo,
  type LeagueSeasonImportRow,
  type RecommendedCompetition,
} from "@/lib/competitions/manager-data";
import type { NormalizedLeague } from "@/lib/sports-data/types";

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

  const { data: existing } = await adminClient
    .from("league_season_imports")
    .select("id, import_status")
    .eq("provider", "api_football")
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

  const league = await apiFootballProvider.getLeagueById(externalLeagueId);
  if (!league) {
    return fail("Could not find this league with the sports data provider.");
  }
  const seasonMeta = league.seasons.find((s) => s.year === season) ?? null;

  const { data: leagueRow, error: leagueError } = await adminClient
    .from("leagues")
    .upsert(
      { provider: "api_football", external_id: externalLeagueId, name: league.name, logo_url: league.logoUrl },
      { onConflict: "provider,external_id" },
    )
    .select("id")
    .single();
  if (leagueError || !leagueRow) {
    return fail("Could not save league metadata.");
  }

  const lsiPayload = {
    provider: "api_football",
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

  const now = Date.now();
  const fixturesToImport = options.includeHistorical
    ? allFixtures
    : allFixtures.filter((f) => new Date(f.scheduledStartUtc).getTime() > now);

  const chunks = buildImportChunks(fixturesToImport);

  const { data: job, error: jobError } = await adminClient
    .from("competition_import_jobs")
    .insert({
      league_season_import_id: lsi.id,
      status: "PENDING",
      include_historical: options.includeHistorical ?? false,
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
    after: { externalLeagueId, season, totalFixtures: fixturesToImport.length, includeHistorical: options.includeHistorical ?? false },
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

export interface CompetitionManagerData {
  recommended: RecommendedCompetition[];
  recommendedCacheStatus: RecommendationCacheStatus;
  recommendedCacheCheckedAt: string | null; // oldest checked_at among priority leagues, for "last checked" display
  // How many PRIORITY_LEAGUES entries resolve to a real current season at
  // all (excludes ones the provider catalog doesn't return or that have no
  // current season) — the denominator for "all already imported."
  priorityLeaguesEligible: number;
  priorityLeaguesAlreadyImported: number;
  imported: CompetitionRow[];
  needsAttention: CompetitionRow[];
  allByCountry: Array<[string, NormalizedLeague[]]>;
  importedExternalLeagueIds: Set<string>; // for badging "All competitions" rows
  // Set when the live provider catalog fetch failed (e.g. a quota/rate
  // limit error) — distinct from a catalog that's just genuinely empty.
  // allByCountry/recommended are still returned (empty/degraded) so the
  // rest of the page (imported competitions, needs-attention) keeps
  // working; only the parts that depend on the live catalog degrade.
  catalogError: string | null;
}

/**
 * Assembles everything the /admin/competitions list needs, across its 4
 * tabs. One live provider catalog fetch (searchLeagues("")), reused for
 * every tab's country/type/season enrichment — the same pattern the
 * existing /admin/fixtures page already uses — plus whatever's already in
 * our own tables (league_season_imports, leagues, fixtures, the
 * availability cache, and the latest import job per competition).
 */
export async function getCompetitionManagerDataAction(): Promise<CompetitionManagerData> {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();

  let catalogError: string | null = null;
  const [{ data: lsiRows }, catalog, { data: cacheRows }] = await Promise.all([
    adminClient.from("league_season_imports").select("*"),
    // A page-load-time provider call — must never throw uncaught here, or
    // the entire Competitions page (imported competitions, needs
    // attention, everything) goes down with it. A real production
    // incident: this exact call, unguarded, took down /admin/competitions
    // with an unhandled ProviderApiError the moment quota exhaustion
    // started throwing instead of silently returning empty.
    apiFootballProvider.isEnabled()
      ? apiFootballProvider.searchLeagues("").catch((err) => {
          catalogError = err instanceof Error ? err.message : "The provider catalog could not be loaded.";
          return [] as NormalizedLeague[];
        })
      : Promise.resolve([]),
    adminClient
      .from("competition_availability_cache")
      .select("external_league_id, season, upcoming_fixture_count, next_fixture_at, checked_at"),
  ]);

  const catalogByExternalId = new Map(catalog.map((l) => [l.externalLeagueId, l]));
  const priorityMap = getPriorityLeagueMap();
  const latestSeasonByExternalId = new Map((cacheRows ?? []).map((r) => [r.external_league_id, r.season]));

  const rows = (lsiRows ?? []) as LeagueSeasonImportRow[];
  const leagueIds = [...new Set(rows.map((r) => r.league_id))];
  const externalLeagueIds = [...new Set(rows.map((r) => r.external_league_id))];

  const [{ data: leagueRows }, { data: fixtureAggregateRows }, { data: jobRows }] = await Promise.all([
    leagueIds.length > 0
      ? adminClient.from("leagues").select("id, name, logo_url").in("id", leagueIds)
      : Promise.resolve({ data: [] }),
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
      : Promise.resolve({ data: [] }),
    rows.length > 0
      ? adminClient
          .from("competition_import_jobs")
          .select("id, league_season_import_id, status, created_at")
          .in(
            "league_season_import_id",
            rows.map((r) => r.id),
          )
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  const leaguesById = new Map((leagueRows ?? []).map((l) => [l.id, l]));
  const tierByExternalId = new Map(externalLeagueIds.map((id) => [id, priorityMap.get(id)?.tier]).filter((e): e is [string, LeagueTier] => e[1] != null));
  const countryByExternalId = new Map(externalLeagueIds.map((id) => [id, catalogByExternalId.get(id)?.countryName ?? null]));
  const typeByExternalId = new Map(externalLeagueIds.map((id) => [id, catalogByExternalId.get(id)?.type ?? null]));

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
    tierByExternalId,
    countryByExternalId,
    typeByExternalId,
    fixtureAggregates,
    latestSeasonByExternalId,
    latestJobs,
  );

  const importedKeys = new Set(rows.map((r) => `${r.external_league_id}:${r.season}`));
  const importedExternalLeagueIds = new Set(rows.map((r) => r.external_league_id));

  const catalogRefByExternalId = new Map(
    [...catalogByExternalId.entries()].map(([id, league]) => [
      id,
      {
        name: league.name,
        countryName: league.countryName,
        type: league.type,
        logoUrl: league.logoUrl,
        currentSeasonYear: league.seasons.find((s) => s.current)?.year ?? null,
      },
    ]),
  );
  const availabilityCacheRows = (cacheRows ?? []).map((r) => ({
    externalLeagueId: r.external_league_id,
    season: r.season,
    upcomingFixtureCount: r.upcoming_fixture_count,
    nextFixtureAt: r.next_fixture_at,
    checkedAt: r.checked_at,
  }));

  const { recommended, priorityLeaguesEligible, priorityLeaguesAlreadyImported, oldestCheckedAt } = buildRecommendedCompetitions(
    PRIORITY_LEAGUES,
    catalogRefByExternalId,
    importedKeys,
    availabilityCacheRows,
  );

  const notYetImportedEligible = priorityLeaguesEligible - priorityLeaguesAlreadyImported;
  const recommendedCacheStatus: RecommendationCacheStatus =
    notYetImportedEligible > 0 && oldestCheckedAt == null
      ? "NOT_CHECKED"
      : oldestCheckedAt && Date.now() - new Date(oldestCheckedAt).getTime() > AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS * 3600_000
        ? "STALE"
        : "FRESH";

  const byCountry = new Map<string, NormalizedLeague[]>();
  for (const league of catalog) {
    const key = league.countryName ?? "Other";
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key)!.push(league);
  }
  const allByCountry: Array<[string, NormalizedLeague[]]> = [...byCountry.entries()]
    .map(([country, list]): [string, NormalizedLeague[]] => [country, [...list].sort((a, b) => a.name.localeCompare(b.name))])
    .sort(([a], [b]) => a.localeCompare(b));

  return {
    recommended,
    recommendedCacheStatus,
    recommendedCacheCheckedAt: oldestCheckedAt,
    priorityLeaguesEligible,
    priorityLeaguesAlreadyImported,
    imported: importedRows,
    // Kept in lockstep with the badge itself (operationalStatus), not a
    // separate reasons-based check — otherwise a normal Completed or
    // No-upcoming-fixtures competition (which still carries an advisory
    // reason, e.g. "consider archiving") would flood this tab despite its
    // badge saying something else entirely.
    needsAttention: importedRows.filter((r) => r.operationalStatus === "NEEDS_ATTENTION"),
    allByCountry,
    importedExternalLeagueIds,
    catalogError,
  };
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

export interface CatalogAvailability {
  upcomingFixtureCount: number; // within RECOMMENDATION_WINDOW_DAYS
  nextFixtureAt: string | null;
}

/** On-demand availability for the "All competitions" catalog — called
 * when a country accordion is expanded, never on initial page load (the
 * catalog can hold hundreds of competitions; fetching live fixture data
 * for all of them up front would be exactly the fan-out this feature's
 * design has always avoided). Reuses competition_availability_cache
 * itself — generalized here to any competition/season, not just
 * PRIORITY_LEAGUES — so re-expanding the same country later reads from
 * cache instead of hitting the provider again. */
export async function getCatalogAvailabilityAction(
  items: Array<{ externalLeagueId: string; season: string }>,
): Promise<Record<string, CatalogAvailability>> {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();
  const result: Record<string, CatalogAvailability> = {};
  if (!apiFootballProvider.isEnabled() || items.length === 0) return result;

  const { data: cachedRows } = await adminClient
    .from("competition_availability_cache")
    .select("external_league_id, season, upcoming_fixture_count, next_fixture_at, checked_at")
    .in(
      "external_league_id",
      items.map((i) => i.externalLeagueId),
    );
  const cacheByKey = new Map((cachedRows ?? []).map((r) => [`${r.external_league_id}:${r.season}`, r]));

  const now = Date.now();
  for (const item of items) {
    const key = `${item.externalLeagueId}:${item.season}`;
    const cached = cacheByKey.get(key);
    if (cached) {
      const ttlHours =
        cached.upcoming_fixture_count > 0 ? AVAILABILITY_CACHE_TTL_WITH_FIXTURES_HOURS : AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS;
      const age = now - new Date(cached.checked_at).getTime();
      if (age < ttlHours * 3600_000) {
        result[key] = { upcomingFixtureCount: cached.upcoming_fixture_count, nextFixtureAt: cached.next_fixture_at };
        continue;
      }
    }

    try {
      const fixtures = await apiFootballProvider.getSeasonFixtures(item.externalLeagueId, item.season);
      const windowEnd = now + RECOMMENDATION_WINDOW_DAYS * 86_400_000;
      const withinWindow = fixtures.filter((f) => {
        const t = new Date(f.scheduledStartUtc).getTime();
        return t > now && t <= windowEnd;
      });
      const nextFixtureAt = withinWindow.reduce<string | null>(
        (earliest, f) => (!earliest || f.scheduledStartUtc < earliest ? f.scheduledStartUtc : earliest),
        null,
      );
      await adminClient.from("competition_availability_cache").upsert(
        {
          provider: "api_football",
          external_league_id: item.externalLeagueId,
          season: item.season,
          upcoming_fixture_count: withinWindow.length,
          next_fixture_at: nextFixtureAt,
          window_days: RECOMMENDATION_WINDOW_DAYS,
          checked_at: new Date().toISOString(),
          check_error: null,
        },
        { onConflict: "provider,external_league_id,season" },
      );
      result[key] = { upcomingFixtureCount: withinWindow.length, nextFixtureAt };
    } catch {
      result[key] = cached
        ? { upcomingFixtureCount: cached.upcoming_fixture_count, nextFixtureAt: cached.next_fixture_at }
        : { upcomingFixtureCount: 0, nextFixtureAt: null };
    }
  }
  return result;
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
