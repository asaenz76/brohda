import type { NormalizedLeague } from "./types";
import { compareLeagueTier, getPriorityLeagueMap } from "./priority-leagues";

export interface CategorizedLeagues {
  inSeason: NormalizedLeague[];
  otherPriority: NormalizedLeague[];
  countries: Array<[string, NormalizedLeague[]]>;
}

// Pure categorization for the fixture-import league picker
// (app/(admin)/admin/fixtures/league-select.tsx) — pulled out of that
// "use client" component so it's unit-testable directly (mirrors
// lib/pools/fetch.ts's groupPoolTotalsByPoolId/groupPoolParticipantsByPoolId
// pattern).
//
// Only PRIORITY_LEAGUES entries are eligible for "in season now" — a
// non-curated league or cup that happens to have a `current: true` season
// right now still falls through to its per-country group. Surfacing every
// currently-active competition worldwide would flood the top of the list
// with hundreds of youth/qualifier/regional cups; the curated list keeps
// that group meaningful, at the cost of needing a competition (like a new
// cup) added here once someone notices it's missing.
export function categorizeLeaguesForPicker(leagues: NormalizedLeague[]): CategorizedLeagues {
  const priorityMap = getPriorityLeagueMap();

  const inSeason: NormalizedLeague[] = [];
  const otherPriority: NormalizedLeague[] = [];
  const rest: NormalizedLeague[] = [];

  for (const league of leagues) {
    const priority = priorityMap.get(league.externalLeagueId);
    if (!priority) {
      rest.push(league);
    } else if (league.seasons.some((s) => s.current)) {
      inSeason.push(league);
    } else {
      otherPriority.push(league);
    }
  }

  const byTier = (a: NormalizedLeague, b: NormalizedLeague) => {
    const tierA = priorityMap.get(a.externalLeagueId)?.tier ?? "C";
    const tierB = priorityMap.get(b.externalLeagueId)?.tier ?? "C";
    return compareLeagueTier(tierA, tierB) || a.name.localeCompare(b.name);
  };
  inSeason.sort(byTier);
  otherPriority.sort(byTier);

  const byCountry = new Map<string, NormalizedLeague[]>();
  for (const league of rest) {
    const key = league.countryName ?? "Other";
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key)!.push(league);
  }
  const countries = [...byCountry.entries()]
    .map(([country, list]): [string, NormalizedLeague[]] => [
      country,
      [...list].sort((a, b) => a.name.localeCompare(b.name)),
    ])
    .sort(([a], [b]) => a.localeCompare(b));

  return { inSeason, otherPriority, countries };
}
