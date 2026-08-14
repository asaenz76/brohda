import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import { getSupportedCompetitionGroup, isSupportedCompetition, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import {
  computeOperationalStatus,
  getNeedsAttentionDetails,
  getNeedsAttentionReasons,
  importStatusBadge,
  type ImportStatusBadge,
  type NeedsAttentionDetail,
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
  group: CompetitionGroup | null;
  isSupported: boolean;
  importStatus: ImportStatusBadge;
  operationalStatus: OperationalStatus | null;
  needsAttentionReasons: NeedsAttentionReason[];
  needsAttentionDetails: NeedsAttentionDetail[];
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

  const [{ data: fixtureRows }, { data: jobRows }, { data: availabilityCacheRow }] = await Promise.all([
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
    // Read-only: whether this is still the provider's current season
    // comes from the availability cache (populated by an explicit
    // refresh/sync, never here) rather than a live getLeagueById call on
    // every Workspace page view — this page render must never itself
    // spend provider quota.
    // Scoped by provider too, not just external_league_id — this function
    // is generic over any league_season_imports row (football or NFL, see
    // sync-nfl.ts's own write to this same table's league_season_imports),
    // and competition_availability_cache's real key is (provider,
    // external_league_id, season). Not currently exploitable (NFL never
    // writes competition_availability_cache and its one league id, "1",
    // has no football collision today), but the query itself shouldn't
    // depend on that non-collision holding forever.
    adminClient
      .from("competition_availability_cache")
      .select("season")
      .eq("provider", lsi.provider)
      .eq("external_league_id", lsi.external_league_id)
      .maybeSingle(),
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

  // No cache row yet means "never checked" — treated as latest-known
  // rather than flagging NEWER_SEASON_AVAILABLE on a competition that's
  // simply never been through a recommendation-cache refresh.
  const isLatestKnownSeason = !availabilityCacheRow || availabilityCacheRow.season === lsi.season;
  const isSupported = isSupportedCompetition(lsi.external_league_id);

  const statusInput = {
    isSupported,
    importStatus: lsi.import_status,
    syncStatus: lsi.sync_status,
    isActive: lsi.is_active,
    archivedAt: lsi.archived_at,
    seasonEndDate: lsi.season_end_date,
    lastFixtureDiscoveryAt: lsi.last_fixture_discovery_at,
    upcomingFixtureCount: lsi.upcoming_fixture_count,
    fixtureCountImported: lsi.fixture_count_imported,
    providerFixtureCount: lsi.provider_fixture_count,
    latestProviderFixtureAt: lsi.latest_provider_fixture_at,
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
    group: getSupportedCompetitionGroup(lsi.external_league_id),
    isSupported,
    importStatus: importStatusBadge({ importStatus: lsi.import_status }),
    operationalStatus: computeOperationalStatus(statusInput),
    needsAttentionReasons: getNeedsAttentionReasons(statusInput),
    needsAttentionDetails: getNeedsAttentionDetails(statusInput),
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
