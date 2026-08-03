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
  aggregateFixturesByCompetition,
  buildImportedCompetitionRows,
  type CompetitionRow,
  type LatestJobInfo,
  type LeagueSeasonImportRow,
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
    await adminClient
      .from("league_season_imports")
      .update({
        import_status: "IMPORTED",
        imported_at: new Date().toISOString(),
        fixture_count_imported: fixturesToImport.length,
        upcoming_fixture_count: upcoming,
        completed_fixture_count: fixturesToImport.length - upcoming,
        provider_fixture_count: allFixtures.length,
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

export interface RecommendedCompetition {
  externalLeagueId: string;
  season: string;
  name: string;
  countryName: string | null;
  type: string | null;
  tier: LeagueTier;
  logoUrl: string | null;
  upcomingFixtureCount: number;
  nextFixtureAt: string | null;
}

export interface CompetitionManagerData {
  recommended: RecommendedCompetition[];
  imported: CompetitionRow[];
  needsAttention: CompetitionRow[];
  allByCountry: Array<[string, NormalizedLeague[]]>;
  importedExternalLeagueIds: Set<string>; // for badging "All competitions" rows
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

  const [{ data: lsiRows }, catalog, { data: cacheRows }] = await Promise.all([
    adminClient.from("league_season_imports").select("*"),
    apiFootballProvider.isEnabled() ? apiFootballProvider.searchLeagues("") : Promise.resolve([]),
    adminClient.from("competition_availability_cache").select("external_league_id, season, upcoming_fixture_count, next_fixture_at"),
  ]);

  const catalogByExternalId = new Map(catalog.map((l) => [l.externalLeagueId, l]));
  const priorityMap = getPriorityLeagueMap();
  const latestSeasonByExternalId = new Map((cacheRows ?? []).map((r) => [r.external_league_id, r.season]));

  const rows = (lsiRows ?? []) as LeagueSeasonImportRow[];
  const leagueIds = [...new Set(rows.map((r) => r.league_id))];
  const externalLeagueIds = [...new Set(rows.map((r) => r.external_league_id))];

  const [{ data: leagueRows }, { data: fixtureRows }, { data: jobRows }] = await Promise.all([
    leagueIds.length > 0
      ? adminClient.from("leagues").select("id, name, logo_url").in("id", leagueIds)
      : Promise.resolve({ data: [] }),
    externalLeagueIds.length > 0
      ? adminClient
          .from("fixtures")
          .select("competition_external_id, season, scheduled_start_utc, internal_status")
          .in("competition_external_id", externalLeagueIds)
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

  const fixtureAggregates = aggregateFixturesByCompetition(
    (fixtureRows ?? []).map((f) => ({
      competitionExternalId: f.competition_external_id ?? "",
      season: f.season ?? "",
      scheduledStartUtc: f.scheduled_start_utc,
      internalStatus: f.internal_status,
    })),
    TERMINAL_STATUSES,
  );

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

  const recommended: RecommendedCompetition[] = [];
  for (const priority of PRIORITY_LEAGUES) {
    const league = catalogByExternalId.get(priority.externalLeagueId);
    const currentSeason = league?.seasons.find((s) => s.current);
    if (!league || !currentSeason) continue;
    if (importedKeys.has(`${priority.externalLeagueId}:${currentSeason.year}`)) continue;

    const cached = cacheRows?.find((r) => r.external_league_id === priority.externalLeagueId && r.season === currentSeason.year);
    if (!cached || cached.upcoming_fixture_count <= 0) continue; // not yet checked, or nothing in the recommendation window

    recommended.push({
      externalLeagueId: priority.externalLeagueId,
      season: currentSeason.year,
      name: league.name,
      countryName: league.countryName,
      type: league.type,
      tier: priority.tier,
      logoUrl: league.logoUrl,
      upcomingFixtureCount: cached.upcoming_fixture_count,
      nextFixtureAt: cached.next_fixture_at,
    });
  }
  recommended.sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));

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
    imported: importedRows,
    needsAttention: importedRows.filter((r) => r.needsAttentionReasons.length > 0),
    allByCountry,
    importedExternalLeagueIds,
  };
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
