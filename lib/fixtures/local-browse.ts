// The DB-only local browse layer backing the Events admin surface. Every
// function here queries only the local `fixtures` table (plus `pools`,
// `fixtures_available_for_pool_creation`, and `league_season_imports` for
// enrichment) — never a live provider call. Normal admin browsing (page
// load, date/preset/competition/filter changes) must never call the
// provider; this module is the boundary that guarantees that by
// construction — it has no dependency on SportsDataProvider at all.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupportedNflCompetition } from "@/lib/sports-data/supported-nfl-competitions";
import { isTerminalStatus } from "@/lib/sports-data/status-map";
import type { FixtureInternalStatus } from "@/lib/sports-data/types";
import { localDateKeyFor, type FixtureDateWindow } from "./date-window";
import { ALL_EVENT_SPORTS } from "./sport-meta";

/** The sports currently backed by real provider data — see
 * lib/sports-data/api-nfl-provider.ts. Not a generic "every sport" union;
 * adding another sport means adding a value here deliberately, not
 * something this type accepts implicitly. */
export type EventSport = "american_football";

const IN_CLAUSE_CHUNK_SIZE = 300;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Paginates a PostgREST query past the client's default 1000-row cap — a
 * real past production incident (get_competition_fixture_aggregates' own
 * comment documents it: 1852 rows silently truncated to 1000, making a
 * whole competition's future fixtures vanish from an aggregate). Every
 * local-browse query here goes through this rather than a single
 * unbounded `.select()`, regardless of how unlikely a given date window or
 * competition-season is to exceed 1000 rows today — do not assume fewer
 * than 1000 rows forever.
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

/** The four states the UI needs to distinguish. Derived, never duplicated:
 * "ELIGIBLE" comes straight from membership in
 * fixtures_available_for_pool_creation (the one canonical eligibility
 * view — no rule from that view's WHERE clause is reimplemented here),
 * "COMPLETED"/"LOCKED" are read directly off columns already on the
 * fixture row. */
export type PoolEligibilityStatus = "ELIGIBLE" | "COMPLETED" | "LOCKED" | "INELIGIBLE";

export interface LocalFixture {
  id: string;
  externalFixtureId: string;
  provider: string;
  sport: string;
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
  "id, external_fixture_id, provider, sport, competition_external_id, competition_name, competition_country, competition_type, season, round, home_team_name, away_team_name, scheduled_start_utc, internal_status, hidden_from_pool_creation";

interface RawFixtureRow {
  id: string;
  external_fixture_id: string;
  provider: string;
  sport: string;
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
 * batched (chunked) query, never N+1. */
function isRowSupported(row: Pick<RawFixtureRow, "sport" | "competition_external_id">): boolean {
  return isSupportedNflCompetition(row.competition_external_id);
}

async function enrichLocalRows(rows: RawFixtureRow[], timeZone: string): Promise<LocalFixture[]> {
  const adminClient = createAdminClient();
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
      sport: row.sport,
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
      isSupported: isRowSupported(row),
      hasWorkspace: matchingWorkspace != null,
      hasOdds,
      poolCount: poolCountById.get(row.id) ?? 0,
      eligibility,
      localDateKey: localDateKeyFor(row.scheduled_start_utc, timeZone),
    };
  });
}

/**
 * The Events admin surface's one query: by date window, across every
 * currently-implemented sport in one round trip, local-DB-only — same
 * `fetchAllRows` 1000-row-cap protection and the same chunked-lookup
 * `enrichLocalRows` enrichment used throughout this module. The supported-
 * competition filter is applied per-row via `isRowSupported`, not a single
 * `.in()` id list, so a future second sport's supported-id space is never
 * accidentally merged with another's (small numeric ids can coincide
 * between providers).
 */
export async function queryLocalEventsByDateWindow(
  window: FixtureDateWindow,
  options: { sports?: EventSport[]; competitionExternalId?: string; includeUnsupported?: boolean } = {},
): Promise<LocalFixtureBrowseResult> {
  const adminClient = createAdminClient();
  const sports = options.sports && options.sports.length > 0 ? options.sports : ALL_EVENT_SPORTS;

  const rows = await fetchAllRows<RawFixtureRow>((from, to) => {
    let query = adminClient
      .from("fixtures")
      .select(RAW_FIXTURE_COLUMNS)
      .in("sport", sports)
      .gte("scheduled_start_utc", window.utcWindowStart)
      .lt("scheduled_start_utc", window.utcWindowEnd)
      .order("scheduled_start_utc", { ascending: true })
      .range(from, to);
    if (options.competitionExternalId) query = query.eq("competition_external_id", options.competitionExternalId);
    return query;
  });

  const scoped = options.includeUnsupported ? rows : rows.filter(isRowSupported);
  const fixtures = await enrichLocalRows(scoped, window.timeZone);
  return { fixtures, counts: computeCounts(fixtures) };
}
