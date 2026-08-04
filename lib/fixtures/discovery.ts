import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SportsDataProvider, NormalizedFixture } from "@/lib/sports-data/types";
import { getPriorityLeagueMap, type LeagueTier } from "@/lib/sports-data/priority-leagues";
import { classifyCompetition, type CompetitionClassification } from "./competition-classification";
import { getCachedFixtureSearch, setCachedFixtureSearch } from "./cache";
import { isWithinDateWindow, localDateKeyFor, type FixtureDateWindow } from "./date-window";

const IN_CLAUSE_CHUNK_SIZE = 300;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export interface EnrichedFixture {
  externalFixtureId: string;
  competitionExternalId: string | null;
  competitionName: string | null;
  competitionCountry: string | null;
  competitionType: string | null;
  season: string | null;
  round: string | null;
  homeTeamExternalId: string | null;
  homeTeamName: string;
  awayTeamExternalId: string | null;
  awayTeamName: string;
  scheduledStartUtc: string;
  internalStatus: string;
  venueName: string | null;
  isImported: boolean;
  importedFixtureId: string | null;
  isPriority: boolean;
  tier: LeagueTier | null;
  hasWorkspace: boolean;
  // null = unknown (not determinable without a per-fixture/per-competition
  // provider fan-out this workflow deliberately avoids) — only ever a real
  // true/false when the competition already has a Workspace whose
  // coverage_snapshot we already hold, at zero extra provider cost.
  hasOdds: boolean | null;
  classification: CompetitionClassification;
  localDateKey: string;
}

/** Cross-references already-fetched, provider-normalized fixtures against
 * our own tables — never a per-fixture provider call. Every lookup here
 * is one batched query (chunked for very large result sets) rather than
 * N+1, matching the same discipline the Competitions-page fixes earlier
 * required. */
export async function enrichFixtures(fixtures: NormalizedFixture[], timeZone: string): Promise<EnrichedFixture[]> {
  const adminClient = createAdminClient();
  const priorityMap = getPriorityLeagueMap();

  const externalFixtureIds = [...new Set(fixtures.map((f) => f.externalFixtureId))];
  const importedByExternalId = new Map<string, string>(); // externalFixtureId -> our fixtures.id
  for (const idChunk of chunk(externalFixtureIds, IN_CLAUSE_CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const { data } = await adminClient.from("fixtures").select("id, external_fixture_id").in("external_fixture_id", idChunk);
    for (const row of data ?? []) importedByExternalId.set(row.external_fixture_id as string, row.id as string);
  }

  const competitionExternalIds = [...new Set(fixtures.map((f) => f.competitionExternalId).filter((id): id is string => Boolean(id)))];
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

  return fixtures.map((f): EnrichedFixture => {
    const priority = f.competitionExternalId ? priorityMap.get(f.competitionExternalId) : undefined;
    const workspaces = f.competitionExternalId ? (workspaceByCompetition.get(f.competitionExternalId) ?? []) : [];
    const matchingWorkspace = workspaces.find((w) => w.season === f.season);
    const importedFixtureId = importedByExternalId.get(f.externalFixtureId) ?? null;

    let hasOdds: boolean | null = null;
    const coverage = matchingWorkspace?.coverageSnapshot as { odds?: boolean } | null | undefined;
    if (coverage && typeof coverage.odds === "boolean") hasOdds = coverage.odds;

    return {
      externalFixtureId: f.externalFixtureId,
      competitionExternalId: f.competitionExternalId,
      competitionName: f.competitionName,
      competitionCountry: f.competitionCountry,
      competitionType: f.competitionType ?? null,
      season: f.season,
      round: f.round,
      homeTeamExternalId: f.homeTeamExternalId,
      homeTeamName: f.homeTeamName,
      awayTeamExternalId: f.awayTeamExternalId,
      awayTeamName: f.awayTeamName,
      scheduledStartUtc: f.scheduledStartUtc,
      internalStatus: f.internalStatus,
      venueName: f.venueName,
      isImported: importedFixtureId != null,
      importedFixtureId,
      isPriority: priority != null,
      tier: priority?.tier ?? null,
      hasWorkspace: matchingWorkspace != null,
      hasOdds,
      classification: classifyCompetition(f.competitionName, [f.homeTeamName, f.awayTeamName]),
      localDateKey: localDateKeyFor(f.scheduledStartUtc, timeZone),
    };
  });
}

export interface FixtureDiscoveryResult {
  window: FixtureDateWindow;
  fixtures: EnrichedFixture[];
  fetchedAt: string;
  fromCache: boolean;
  error: string | null;
}

/**
 * The full date-first search pipeline: cache lookup, provider fetch on a
 * miss (never both — a hit skips the network entirely), exact-window
 * trim, enrichment. A provider failure is returned as `error`, never as
 * an empty `fixtures` array with no explanation — callers (the UI) must
 * render those two outcomes differently (see the distinct empty states
 * in the Fixtures page).
 */
export async function searchFixturesForDateWindow(
  provider: SportsDataProvider,
  window: FixtureDateWindow,
  options: { competitionExternalId?: string; forceRefresh?: boolean } = {},
): Promise<FixtureDiscoveryResult> {
  const cacheKey = {
    provider: provider.name,
    timeZone: window.timeZone,
    utcFrom: window.utcWindowStart,
    utcTo: window.utcWindowEnd,
    competitionExternalId: options.competitionExternalId ?? null,
  };

  let raw: NormalizedFixture[] | null = null;
  let fromCache = false;

  if (!options.forceRefresh) {
    raw = await getCachedFixtureSearch(cacheKey);
    if (raw) fromCache = true;
  }

  if (raw === null) {
    if (!provider.isEnabled()) {
      return { window, fixtures: [], fetchedAt: new Date().toISOString(), fromCache: false, error: "The sports data provider is not enabled." };
    }
    try {
      const merged = await provider.searchFixturesByDateRange({
        fromDate: window.utcQueryDates[0],
        toDate: window.utcQueryDates[window.utcQueryDates.length - 1],
        competitionExternalId: options.competitionExternalId,
      });
      raw = merged.filter((f) => isWithinDateWindow(f.scheduledStartUtc, window));
      await setCachedFixtureSearch(cacheKey, window.preset, raw);
    } catch (err) {
      return {
        window,
        fixtures: [],
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        error: err instanceof Error ? err.message : "The provider search failed.",
      };
    }
  }

  const enriched = await enrichFixtures(raw, window.timeZone);
  return { window, fixtures: enriched, fetchedAt: new Date().toISOString(), fromCache, error: null };
}
