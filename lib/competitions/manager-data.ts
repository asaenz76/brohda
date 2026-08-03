import type { LeagueTier } from "@/lib/sports-data/priority-leagues";
import {
  computeOperationalStatus,
  getNeedsAttentionReasons,
  importStatusBadge,
  type ImportStatusBadge,
  type NeedsAttentionReason,
  type OperationalStatus,
} from "./status";
import { ACTIVATION_WINDOW_DAYS, DISCOVERY_SYNC_INTERVAL_HOURS } from "./constants";

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
  fixtureCountImported: number;
  providerFixtureCount: number | null;
  nextFixtureAt: string | null;
  lastSyncedAt: string | null;
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
  const byKey = new Map<string, FixtureAggregate & { _hasAny: boolean; _allTerminal: boolean }>();
  const windowEnd = now + ACTIVATION_WINDOW_DAYS * 86_400_000;

  for (const f of fixtures) {
    const key = `${f.competitionExternalId}:${f.season}`;
    const entry = byKey.get(key) ?? {
      externalLeagueId: f.competitionExternalId,
      season: f.season,
      nextFixtureAt: null,
      hasFixtureWithinActivationWindow: false,
      allKnownFixturesAreTerminal: true,
      _hasAny: false,
      _allTerminal: true,
    };
    entry._hasAny = true;
    const t = new Date(f.scheduledStartUtc).getTime();
    const isTerminal = terminalStatuses.includes(f.internalStatus);
    if (!isTerminal) entry._allTerminal = false;

    if (t > now) {
      if (!entry.nextFixtureAt || f.scheduledStartUtc < entry.nextFixtureAt) entry.nextFixtureAt = f.scheduledStartUtc;
      if (t <= windowEnd) entry.hasFixtureWithinActivationWindow = true;
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
      fixtureCountImported: lsi.fixture_count_imported,
      providerFixtureCount: lsi.provider_fixture_count,
      nextFixtureAt: aggregate?.nextFixtureAt ?? null,
      lastSyncedAt: lsi.last_synced_at,
      poolCreationEnabled: lsi.pool_creation_enabled,
      isActive: lsi.is_active,
      latestJobId: latestJob?.jobId ?? null,
      latestJobStatus: latestJob?.status ?? null,
    };
  });
}
