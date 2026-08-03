import type { LeagueTier } from "@/lib/sports-data/priority-leagues";
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
import { ACTIVATION_WINDOW_DAYS, DISCOVERY_SYNC_INTERVAL_HOURS, RECOMMENDATION_WINDOW_DAYS } from "./constants";

export interface CompetitionRow {
  externalLeagueId: string;
  season: string;
  name: string;
  countryName: string | null;
  type: string | null;
  tier: LeagueTier | null;
  logoUrl: string | null;
  leagueSeasonImportId: string | null;
  importStatus: ImportStatusBadge;
  operationalStatus: OperationalStatus | null;
  needsAttentionReasons: NeedsAttentionReason[];
  needsAttentionDetails: NeedsAttentionDetail[];
  fixtureCountImported: number;
  providerFixtureCount: number | null;
  nextFixtureAt: string | null;
  fixturesWithinRecommendationWindow: number;
  lastSyncedAt: string | null;
  seasonEndDate: string | null;
  poolCreationEnabled: boolean;
  isActive: boolean;
  latestJobId: string | null;
  latestJobStatus: string | null;
}

export interface LeagueSeasonImportRow {
  id: string;
  external_league_id: string;
  season: string;
  league_id: string;
  import_status: "IMPORTING" | "IMPORTED" | "IMPORT_FAILED";
  sync_status: "IDLE" | "SYNCING" | "STALE" | "FAILED";
  season_end_date: string | null;
  last_fixture_discovery_at: string | null;
  last_synced_at: string | null;
  fixture_count_imported: number;
  upcoming_fixture_count: number;
  provider_fixture_count: number | null;
  latest_provider_fixture_at: string | null;
  pool_creation_enabled: boolean;
  is_active: boolean;
}

export interface LeagueRow {
  id: string;
  name: string;
  logo_url: string | null;
}

export interface FixtureAggregate {
  externalLeagueId: string;
  season: string;
  nextFixtureAt: string | null;
  hasFixtureWithinActivationWindow: boolean;
  allKnownFixturesAreTerminal: boolean;
  fixturesWithinRecommendationWindow: number;
}

export interface LatestJobInfo {
  leagueSeasonImportId: string;
  jobId: string;
  status: string;
}

/** Groups raw fixture rows (id, competition_external_id, season,
 * scheduled_start_utc, internal_status) by (league, season) into the
 * aggregate values computeOperationalStatus needs — a pure function so
 * the grouping logic is testable without a database. */
export function aggregateFixturesByCompetition(
  fixtures: Array<{ competitionExternalId: string; season: string; scheduledStartUtc: string; internalStatus: string }>,
  terminalStatuses: readonly string[],
  now: number = Date.now(),
): Map<string, FixtureAggregate> {
  const byKey = new Map<
    string,
    FixtureAggregate & { _hasAny: boolean; _allTerminal: boolean; _recommendationCount: number }
  >();
  const activationWindowEnd = now + ACTIVATION_WINDOW_DAYS * 86_400_000;
  const recommendationWindowEnd = now + RECOMMENDATION_WINDOW_DAYS * 86_400_000;

  for (const f of fixtures) {
    const key = `${f.competitionExternalId}:${f.season}`;
    const entry = byKey.get(key) ?? {
      externalLeagueId: f.competitionExternalId,
      season: f.season,
      nextFixtureAt: null,
      hasFixtureWithinActivationWindow: false,
      allKnownFixturesAreTerminal: true,
      fixturesWithinRecommendationWindow: 0,
      _hasAny: false,
      _allTerminal: true,
      _recommendationCount: 0,
    };
    entry._hasAny = true;
    const t = new Date(f.scheduledStartUtc).getTime();
    const isTerminal = terminalStatuses.includes(f.internalStatus);
    if (!isTerminal) entry._allTerminal = false;

    if (t > now) {
      if (!entry.nextFixtureAt || f.scheduledStartUtc < entry.nextFixtureAt) entry.nextFixtureAt = f.scheduledStartUtc;
      if (t <= activationWindowEnd) entry.hasFixtureWithinActivationWindow = true;
      if (t <= recommendationWindowEnd) entry._recommendationCount += 1;
    }
    byKey.set(key, entry);
  }

  const result = new Map<string, FixtureAggregate>();
  for (const [key, entry] of byKey) {
    result.set(key, {
      externalLeagueId: entry.externalLeagueId,
      season: entry.season,
      nextFixtureAt: entry.nextFixtureAt,
      hasFixtureWithinActivationWindow: entry.hasFixtureWithinActivationWindow,
      allKnownFixturesAreTerminal: entry._hasAny && entry._allTerminal,
      fixturesWithinRecommendationWindow: entry._recommendationCount,
    });
  }
  return result;
}

/** Converts get_competition_fixture_aggregates RPC rows into the same
 * Map<string, FixtureAggregate> shape aggregateFixturesByCompetition
 * produces — the bulk list-page path aggregates server-side (see the RPC's
 * own comment for why: PostgREST's default row cap silently truncated the
 * old raw-row-transfer approach once total fixtures crossed 1000), but
 * every downstream consumer keeps consuming the same shape either way. */
export function fixtureAggregatesFromRpcRows(
  rows: Array<{
    external_league_id: string;
    season: string;
    next_fixture_at: string | null;
    has_fixture_within_activation_window: boolean;
    all_known_fixtures_terminal: boolean;
    fixtures_within_recommendation_window: number;
  }>,
): Map<string, FixtureAggregate> {
  const result = new Map<string, FixtureAggregate>();
  for (const r of rows) {
    result.set(`${r.external_league_id}:${r.season}`, {
      externalLeagueId: r.external_league_id,
      season: r.season,
      nextFixtureAt: r.next_fixture_at,
      hasFixtureWithinActivationWindow: r.has_fixture_within_activation_window,
      allKnownFixturesAreTerminal: r.all_known_fixtures_terminal,
      fixturesWithinRecommendationWindow: r.fixtures_within_recommendation_window,
    });
  }
  return result;
}

/** Assembles the final CompetitionRow[] for every imported competition —
 * pure function over already-fetched rows, so the join/status-derivation
 * logic is unit-testable without a database. */
export function buildImportedCompetitionRows(
  lsiRows: LeagueSeasonImportRow[],
  leaguesById: Map<string, LeagueRow>,
  tierByExternalId: Map<string, LeagueTier>,
  countryByExternalId: Map<string, string | null>,
  typeByExternalId: Map<string, string | null>,
  fixtureAggregates: Map<string, FixtureAggregate>,
  latestSeasonByExternalId: Map<string, string>, // from the availability cache — the provider's current season, if known
  latestJobs: Map<string, LatestJobInfo>,
): CompetitionRow[] {
  return lsiRows.map((lsi) => {
    const league = leaguesById.get(lsi.league_id);
    const aggregate = fixtureAggregates.get(`${lsi.external_league_id}:${lsi.season}`);
    const latestJob = latestJobs.get(lsi.id);
    const latestKnownSeason = latestSeasonByExternalId.get(lsi.external_league_id);

    const statusInput = {
      importStatus: lsi.import_status,
      syncStatus: lsi.sync_status,
      isActive: lsi.is_active,
      archivedAt: null,
      seasonEndDate: lsi.season_end_date,
      lastFixtureDiscoveryAt: lsi.last_fixture_discovery_at,
      upcomingFixtureCount: lsi.upcoming_fixture_count,
      fixtureCountImported: lsi.fixture_count_imported,
      providerFixtureCount: lsi.provider_fixture_count,
      latestProviderFixtureAt: lsi.latest_provider_fixture_at,
      isLatestKnownSeason: latestKnownSeason == null || latestKnownSeason === lsi.season,
      discoverySyncIntervalHours: DISCOVERY_SYNC_INTERVAL_HOURS,
      hasFixtureWithinActivationWindow: aggregate?.hasFixtureWithinActivationWindow ?? false,
      allKnownFixturesAreTerminal: aggregate?.allKnownFixturesAreTerminal ?? false,
    };

    return {
      externalLeagueId: lsi.external_league_id,
      season: lsi.season,
      name: league?.name ?? "Unknown competition",
      countryName: countryByExternalId.get(lsi.external_league_id) ?? null,
      type: typeByExternalId.get(lsi.external_league_id) ?? null,
      tier: tierByExternalId.get(lsi.external_league_id) ?? null,
      logoUrl: league?.logo_url ?? null,
      leagueSeasonImportId: lsi.id,
      importStatus: importStatusBadge({ importStatus: lsi.import_status }),
      operationalStatus: computeOperationalStatus(statusInput),
      needsAttentionReasons: getNeedsAttentionReasons(statusInput),
      needsAttentionDetails: getNeedsAttentionDetails(statusInput),
      fixtureCountImported: lsi.fixture_count_imported,
      providerFixtureCount: lsi.provider_fixture_count,
      nextFixtureAt: aggregate?.nextFixtureAt ?? null,
      fixturesWithinRecommendationWindow: aggregate?.fixturesWithinRecommendationWindow ?? 0,
      lastSyncedAt: lsi.last_synced_at,
      seasonEndDate: lsi.season_end_date,
      poolCreationEnabled: lsi.pool_creation_enabled,
      isActive: lsi.is_active,
      latestJobId: latestJob?.jobId ?? null,
      latestJobStatus: latestJob?.status ?? null,
    };
  });
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

export interface PriorityLeagueRef {
  externalLeagueId: string;
  tier: LeagueTier;
}

export interface CatalogLeagueRef {
  name: string;
  countryName: string | null;
  type: string | null;
  logoUrl: string | null;
  currentSeasonYear: string | null; // the provider's own current:true season, if any
}

export interface AvailabilityCacheRow {
  externalLeagueId: string;
  season: string;
  upcomingFixtureCount: number;
  nextFixtureAt: string | null;
  checkedAt: string;
}

export interface RecommendedBuildResult {
  recommended: RecommendedCompetition[];
  priorityLeaguesEligible: number;
  priorityLeaguesAlreadyImported: number;
  oldestCheckedAt: string | null;
}

/**
 * The Recommended tab's core eligibility logic — a priority league
 * appears only once it (a) resolves to a real current season in the
 * provider catalog, (b) isn't already imported for that season, and (c)
 * has a fresh-enough availability-cache row reporting at least one
 * fixture inside the recommendation window. Pure so the "does the cache
 * actually drive Recommended correctly" question is testable without a
 * database or a live provider call — see the diagnostic regression test
 * for the real production bug (the cache was simply never populated).
 */
export function buildRecommendedCompetitions(
  priorityLeagues: PriorityLeagueRef[],
  catalogByExternalId: Map<string, CatalogLeagueRef>,
  importedKeys: Set<string>,
  cacheRows: AvailabilityCacheRow[],
): RecommendedBuildResult {
  const recommended: RecommendedCompetition[] = [];
  let priorityLeaguesEligible = 0;
  let priorityLeaguesAlreadyImported = 0;
  let oldestCheckedAt: string | null = null;

  for (const priority of priorityLeagues) {
    const league = catalogByExternalId.get(priority.externalLeagueId);
    if (!league || !league.currentSeasonYear) continue;
    priorityLeaguesEligible += 1;

    if (importedKeys.has(`${priority.externalLeagueId}:${league.currentSeasonYear}`)) {
      priorityLeaguesAlreadyImported += 1;
      continue;
    }

    const cached = cacheRows.find(
      (r) => r.externalLeagueId === priority.externalLeagueId && r.season === league.currentSeasonYear,
    );
    if (cached && (!oldestCheckedAt || cached.checkedAt < oldestCheckedAt)) oldestCheckedAt = cached.checkedAt;
    if (!cached || cached.upcomingFixtureCount <= 0) continue; // not yet checked, or nothing in the recommendation window

    recommended.push({
      externalLeagueId: priority.externalLeagueId,
      season: league.currentSeasonYear,
      name: league.name,
      countryName: league.countryName,
      type: league.type,
      tier: priority.tier,
      logoUrl: league.logoUrl,
      upcomingFixtureCount: cached.upcomingFixtureCount,
      nextFixtureAt: cached.nextFixtureAt,
    });
  }
  recommended.sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));

  return { recommended, priorityLeaguesEligible, priorityLeaguesAlreadyImported, oldestCheckedAt };
}
