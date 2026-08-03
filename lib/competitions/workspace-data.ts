import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import { getPriorityLeagueMap, type LeagueTier } from "@/lib/sports-data/priority-leagues";
import {
  computeOperationalStatus,
  getNeedsAttentionReasons,
  importStatusBadge,
  type ImportStatusBadge,
  type NeedsAttentionReason,
  type OperationalStatus,
} from "./status";
import { aggregateFixturesByCompetition } from "./manager-data";
import { DISCOVERY_SYNC_INTERVAL_HOURS } from "./constants";

export interface WorkspaceJob {
  id: string;
  status: string;
  includeHistorical: boolean;
  totalFixtures: number;
  processedFixtures: number;
  failedFixtures: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  chunkCounts: { pending: number; running: number; succeeded: number; failed: number };
}

export interface CompetitionWorkspaceData {
  id: string;
  externalLeagueId: string;
  season: string;
  provider: string;
  name: string;
  logoUrl: string | null;
  countryName: string | null;
  type: string | null;
  tier: LeagueTier | null;
  importStatus: ImportStatusBadge;
  operationalStatus: OperationalStatus | null;
  needsAttentionReasons: NeedsAttentionReason[];
  seasonStartDate: string | null;
  seasonEndDate: string | null;
  providerCurrent: boolean;
  coverageSnapshot: unknown;
  coverageCheckedAt: string | null;
  fixtureCountImported: number;
  upcomingFixtureCount: number;
  completedFixtureCount: number;
  providerFixtureCount: number | null;
  nextFixtureAt: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastFixtureDiscoveryAt: string | null;
  poolCreationEnabled: boolean;
  isActive: boolean;
  archivedAt: string | null;
  jobs: WorkspaceJob[];
}

/**
 * One competition's full workspace data — cache()-wrapped so the shared
 * layout (header/sub-nav) and whichever nested page is active both call
 * this and only hit the database once per request, same pattern as
 * getCurrentUser.
 */
export const getCompetitionWorkspaceData = cache(async (id: string): Promise<CompetitionWorkspaceData | null> => {
  const adminClient = createAdminClient();

  const { data: lsi } = await adminClient.from("league_season_imports").select("*").eq("id", id).maybeSingle();
  if (!lsi) return null;

  const { data: league } = await adminClient.from("leagues").select("name, logo_url").eq("id", lsi.league_id).maybeSingle();

  const [{ data: fixtureRows }, { data: jobRows }] = await Promise.all([
    adminClient
      .from("fixtures")
      .select("scheduled_start_utc, internal_status")
      .eq("provider", lsi.provider)
      .eq("competition_external_id", lsi.external_league_id)
      .eq("season", lsi.season),
    adminClient
      .from("competition_import_jobs")
      .select("*")
      .eq("league_season_import_id", id)
      .order("created_at", { ascending: false }),
  ]);

  const jobIds = (jobRows ?? []).map((j) => j.id);
  const { data: chunkRows } = jobIds.length > 0
    ? await adminClient.from("competition_import_job_chunks").select("job_id, status").in("job_id", jobIds)
    : { data: [] as Array<{ job_id: string; status: string }> };

  const chunkCountsByJob = new Map<string, WorkspaceJob["chunkCounts"]>();
  for (const chunk of chunkRows ?? []) {
    const counts = chunkCountsByJob.get(chunk.job_id) ?? { pending: 0, running: 0, succeeded: 0, failed: 0 };
    if (chunk.status === "PENDING") counts.pending += 1;
    else if (chunk.status === "RUNNING") counts.running += 1;
    else if (chunk.status === "SUCCEEDED") counts.succeeded += 1;
    else if (chunk.status === "FAILED") counts.failed += 1;
    chunkCountsByJob.set(chunk.job_id, counts);
  }

  const jobs: WorkspaceJob[] = (jobRows ?? []).map((j) => ({
    id: j.id,
    status: j.status,
    includeHistorical: j.include_historical,
    totalFixtures: j.total_fixtures,
    processedFixtures: j.processed_fixtures,
    failedFixtures: j.failed_fixtures,
    maxAttempts: j.max_attempts,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    lastError: j.last_error,
    createdAt: j.created_at,
    chunkCounts: chunkCountsByJob.get(j.id) ?? { pending: 0, running: 0, succeeded: 0, failed: 0 },
  }));

  const fixtureAggregate = aggregateFixturesByCompetition(
    (fixtureRows ?? []).map((f) => ({
      competitionExternalId: lsi.external_league_id,
      season: lsi.season,
      scheduledStartUtc: f.scheduled_start_utc,
      internalStatus: f.internal_status,
    })),
    TERMINAL_STATUSES,
  ).get(`${lsi.external_league_id}:${lsi.season}`);

  let isLatestKnownSeason = true;
  if (apiFootballProvider.isEnabled()) {
    const liveLeague = await apiFootballProvider.getLeagueById(lsi.external_league_id).catch(() => null);
    const currentSeason = liveLeague?.seasons.find((s) => s.current);
    if (currentSeason) isLatestKnownSeason = currentSeason.year === lsi.season;
  }

  const priorityMap = getPriorityLeagueMap();
  const tier = priorityMap.get(lsi.external_league_id)?.tier ?? null;

  const statusInput = {
    importStatus: lsi.import_status,
    syncStatus: lsi.sync_status,
    isActive: lsi.is_active,
    archivedAt: lsi.archived_at,
    seasonEndDate: lsi.season_end_date,
    lastFixtureDiscoveryAt: lsi.last_fixture_discovery_at,
    upcomingFixtureCount: lsi.upcoming_fixture_count,
    fixtureCountImported: lsi.fixture_count_imported,
    isLatestKnownSeason,
    discoverySyncIntervalHours: DISCOVERY_SYNC_INTERVAL_HOURS,
    hasFixtureWithinActivationWindow: fixtureAggregate?.hasFixtureWithinActivationWindow ?? false,
    allKnownFixturesAreTerminal: fixtureAggregate?.allKnownFixturesAreTerminal ?? false,
  };

  return {
    id: lsi.id,
    externalLeagueId: lsi.external_league_id,
    season: lsi.season,
    provider: lsi.provider,
    name: league?.name ?? "Unknown competition",
    logoUrl: league?.logo_url ?? null,
    countryName: null,
    type: null,
    tier,
    importStatus: importStatusBadge({ importStatus: lsi.import_status }),
    operationalStatus: computeOperationalStatus(statusInput),
    needsAttentionReasons: getNeedsAttentionReasons(statusInput),
    seasonStartDate: lsi.season_start_date,
    seasonEndDate: lsi.season_end_date,
    providerCurrent: lsi.provider_current,
    coverageSnapshot: lsi.coverage_snapshot,
    coverageCheckedAt: lsi.coverage_checked_at,
    fixtureCountImported: lsi.fixture_count_imported,
    upcomingFixtureCount: lsi.upcoming_fixture_count,
    completedFixtureCount: lsi.completed_fixture_count,
    providerFixtureCount: lsi.provider_fixture_count,
    nextFixtureAt: fixtureAggregate?.nextFixtureAt ?? null,
    lastSyncedAt: lsi.last_synced_at,
    lastSyncError: lsi.last_sync_error,
    lastFixtureDiscoveryAt: lsi.last_fixture_discovery_at,
    poolCreationEnabled: lsi.pool_creation_enabled,
    isActive: lsi.is_active,
    archivedAt: lsi.archived_at,
    jobs,
  };
});
