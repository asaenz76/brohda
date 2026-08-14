// Phase 2 (local-first football browsing): the DB-only replacement for the
// old provider-backed date/competition search pipeline in discovery.ts.
// Every function here queries only the local `fixtures` table (plus
// `pools`, `fixtures_available_for_pool_creation`, and
// `league_season_imports` for enrichment) — never the provider. Normal
// admin browsing (page load, date/preset/competition/filter changes) must
// never call the provider (spec §1); this module is the boundary that
// guarantees that by construction — it has no dependency on
// SportsDataProvider at all.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSupportedCompetitionMap, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import { isTerminalStatus } from "@/lib/sports-data/status-map";
import type { FixtureInternalStatus } from "@/lib/sports-data/types";
import { localDateKeyFor, type FixtureDateWindow } from "./date-window";

const IN_CLAUSE_CHUNK_SIZE = 300;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Paginates a PostgREST query past the client's default 1000-row cap — the
 * exact failure mode that already caused one real production incident
 * (get_competition_fixture_aggregates' own comment documents it: 1852 rows
 * silently truncated to 1000, making a whole competition's future fixtures
 * vanish from an aggregate). Every local-browse query here goes through
 * this rather than a single unbounded `.select()`, regardless of how
 * unlikely a given date window or competition-season is to exceed 1000
 * rows today — Phase 2 spec §12 is explicit: "do not assume fewer than
 * 1000 rows forever."
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

export type StatusBucket = "UPCOMING" | "LIVE" | "COMPLETED" | "OTHER";

const LIVE_STATUSES: ReadonlySet<FixtureInternalStatus> = new Set(["LIVE", "HALFTIME", "EXTRA_TIME", "PENALTIES"]);

export function statusBucketFor(status: FixtureInternalStatus): StatusBucket {
  if (status === "NOT_STARTED") return "UPCOMING";
  if (isTerminalStatus(status)) return "COMPLETED";
  if (LIVE_STATUSES.has(status)) return "LIVE";
  return "OTHER"; // POSTPONED, SUSPENDED, UNKNOWN
}

/** Mirrors the four states spec §15 requires the UI to distinguish.
 * Derived, never duplicated: "ELIGIBLE" comes straight from membership in
 * fixtures_available_for_pool_creation (the one canonical eligibility
 * view — see lib/pools; no rule from that view's WHERE clause is
 * reimplemented here), "COMPLETED"/"LOCKED" are read directly off columns
 * already on the fixture row. */
export type PoolEligibilityStatus = "ELIGIBLE" | "COMPLETED" | "LOCKED" | "INELIGIBLE";

export interface LocalFixture {
  id: string;
  externalFixtureId: string;
  provider: string;
  competitionExternalId: string | null;
  competitionName: string | null;
  competitionCountry: string | null;
  competitionType: string | null;
  season: string | null;
  round: string | null;
  homeTeamName: string;
  awayTeamName: string;
  scheduledStartUtc: string;
  internalStatus: FixtureInternalStatus;
  statusBucket: StatusBucket;
  hiddenFromPoolCreation: boolean;
  isSupported: boolean;
  group: CompetitionGroup | null;
  hasWorkspace: boolean;
  hasOdds: boolean | null;
  poolCount: number;
  eligibility: PoolEligibilityStatus;
  localDateKey: string;
}

export interface LocalFixtureBrowseCounts {
  total: number;
  competitions: number;
  withPools: number;
  upcoming: number;
  live: number;
  completed: number;
}

export interface LocalFixtureBrowseResult {
  fixtures: LocalFixture[];
  counts: LocalFixtureBrowseCounts;
}

const RAW_FIXTURE_COLUMNS =
  "id, external_fixture_id, provider, competition_external_id, competition_name, competition_country, competition_type, season, round, home_team_name, away_team_name, scheduled_start_utc, internal_status, hidden_from_pool_creation";

interface RawFixtureRow {
  id: string;
  external_fixture_id: string;
  provider: string;
  competition_external_id: string | null;
  competition_name: string | null;
  competition_country: string | null;
  competition_type: string | null;
  season: string | null;
  round: string | null;
  home_team_name: string;
  away_team_name: string;
  scheduled_start_utc: string;
  internal_status: FixtureInternalStatus;
  hidden_from_pool_creation: boolean;
}

function computeCounts(fixtures: LocalFixture[]): LocalFixtureBrowseCounts {
  return {
    total: fixtures.length,
    competitions: new Set(fixtures.map((f) => f.competitionExternalId)).size,
    withPools: fixtures.filter((f) => f.poolCount > 0).length,
    upcoming: fixtures.filter((f) => f.statusBucket === "UPCOMING").length,
    live: fixtures.filter((f) => f.statusBucket === "LIVE").length,
    completed: fixtures.filter((f) => f.statusBucket === "COMPLETED").length,
  };
}

/** Cross-references an already-fetched, bounded batch of local fixture rows
 * against pools/eligibility/workspace state — every lookup here is one
 * batched (chunked) query, never N+1, matching the same discipline
 * enrichFixtures (the old provider-result enricher) already established. */
async function enrichLocalRows(rows: RawFixtureRow[], timeZone: string): Promise<LocalFixture[]> {
  const adminClient = createAdminClient();
  const supportedMap = getSupportedCompetitionMap();
  const ids = rows.map((r) => r.id);

  const poolCountById = new Map<string, number>();
  for (const idChunk of chunk(ids, IN_CLAUSE_CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const { data } = await adminClient.from("pools").select("fixture_id").in("fixture_id", idChunk);
    for (const row of data ?? []) {
      const fixtureId = row.fixture_id as string;
      poolCountById.set(fixtureId, (poolCountById.get(fixtureId) ?? 0) + 1);
    }
  }

  const eligibleIds = new Set<string>();
  for (const idChunk of chunk(ids, IN_CLAUSE_CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const { data } = await adminClient.from("fixtures_available_for_pool_creation").select("id").in("id", idChunk);
    for (const row of data ?? []) eligibleIds.add(row.id as string);
  }

  const competitionExternalIds = [...new Set(rows.map((r) => r.competition_external_id).filter((id): id is string => Boolean(id)))];
  const workspaceByCompetition = new Map<string, { season: string; coverageSnapshot: unknown }[]>();
  for (const idChunk of chunk(competitionExternalIds, IN_CLAUSE_CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const { data } = await adminClient
      .from("league_season_imports")
      .select("external_league_id, season, coverage_snapshot")
      .in("external_league_id", idChunk);
    for (const row of data ?? []) {
      const list = workspaceByCompetition.get(row.external_league_id as string) ?? [];
      list.push({ season: row.season as string, coverageSnapshot: row.coverage_snapshot });
      workspaceByCompetition.set(row.external_league_id as string, list);
    }
  }

  return rows.map((row): LocalFixture => {
    const supported = row.competition_external_id ? supportedMap.get(row.competition_external_id) : undefined;
    const workspaces = row.competition_external_id ? (workspaceByCompetition.get(row.competition_external_id) ?? []) : [];
    const matchingWorkspace = workspaces.find((w) => w.season === row.season);
    let hasOdds: boolean | null = null;
    const coverage = matchingWorkspace?.coverageSnapshot as { odds?: boolean } | null | undefined;
    if (coverage && typeof coverage.odds === "boolean") hasOdds = coverage.odds;

    const isEligible = eligibleIds.has(row.id);
    const eligibility: PoolEligibilityStatus = isEligible
      ? "ELIGIBLE"
      : isTerminalStatus(row.internal_status)
        ? "COMPLETED"
        : row.hidden_from_pool_creation
          ? "LOCKED"
          : "INELIGIBLE";

    return {
      id: row.id,
      externalFixtureId: row.external_fixture_id,
      provider: row.provider,
      competitionExternalId: row.competition_external_id,
      competitionName: row.competition_name,
      competitionCountry: row.competition_country,
      competitionType: row.competition_type,
      season: row.season,
      round: row.round,
      homeTeamName: row.home_team_name,
      awayTeamName: row.away_team_name,
      scheduledStartUtc: row.scheduled_start_utc,
      internalStatus: row.internal_status,
      statusBucket: statusBucketFor(row.internal_status),
      hiddenFromPoolCreation: row.hidden_from_pool_creation,
      isSupported: supported != null,
      group: supported?.group ?? null,
      hasWorkspace: matchingWorkspace != null,
      hasOdds,
      poolCount: poolCountById.get(row.id) ?? 0,
      eligibility,
      localDateKey: localDateKeyFor(row.scheduled_start_utc, timeZone),
    };
  });
}

/**
 * By-date local browse (spec §2/§3). Scoped to `sport = 'football'` (the
 * `fixtures` table also holds NFL rows — see spec §22) and, by default, to
 * currently enabled SUPPORTED_COMPETITIONS — never a client-side filter
 * over a broader fetch, so the unsupported rows never even leave the
 * database on the default path. `includeUnsupported: true` is an explicit
 * opt-in (still zero provider calls, still local) for inspecting what
 * else exists in the window.
 */
export async function queryLocalFixturesByDateWindow(
  window: FixtureDateWindow,
  options: { competitionExternalId?: string; includeUnsupported?: boolean } = {},
): Promise<LocalFixtureBrowseResult> {
  const adminClient = createAdminClient();
  const supportedIds = [...getSupportedCompetitionMap().keys()];

  const rows = await fetchAllRows<RawFixtureRow>((from, to) => {
    let query = adminClient
      .from("fixtures")
      .select(RAW_FIXTURE_COLUMNS)
      .eq("sport", "football")
      .gte("scheduled_start_utc", window.utcWindowStart)
      .lt("scheduled_start_utc", window.utcWindowEnd)
      .order("scheduled_start_utc", { ascending: true })
      .range(from, to);
    if (options.competitionExternalId) query = query.eq("competition_external_id", options.competitionExternalId);
    if (!options.includeUnsupported) query = query.in("competition_external_id", supportedIds);
    return query;
  });

  const fixtures = await enrichLocalRows(rows, window.timeZone);
  return { fixtures, counts: computeCounts(fixtures) };
}

/**
 * By-competition local browse (spec §6/§7). Always scoped to one
 * competition+season chosen from the supported-and-imported selector, so
 * there's no separate supported-competition gate to apply here (the
 * caller can only ever pass an id/season pair the selector already
 * restricted to SUPPORTED_COMPETITIONS ∩ league_season_imports). Returns
 * the full season in one shot (bounded by fetchAllRows's pagination, not
 * PostgREST's 1000-row cap) — every further filter (round/status/team/
 * date/pool status) is then applied client-side, matching spec §20's
 * "no provider loading spinner, local query" performance target: picking
 * a competition/season costs one round trip, every filter change after
 * that costs zero.
 */
export async function queryLocalFixturesByCompetitionSeason(
  externalLeagueId: string,
  season: string,
  timeZone: string,
): Promise<LocalFixtureBrowseResult> {
  const adminClient = createAdminClient();

  const rows = await fetchAllRows<RawFixtureRow>((from, to) =>
    adminClient
      .from("fixtures")
      .select(RAW_FIXTURE_COLUMNS)
      .eq("sport", "football")
      .eq("competition_external_id", externalLeagueId)
      .eq("season", season)
      .order("scheduled_start_utc", { ascending: true })
      .range(from, to),
  );

  const fixtures = await enrichLocalRows(rows, timeZone);
  return { fixtures, counts: computeCounts(fixtures) };
}
