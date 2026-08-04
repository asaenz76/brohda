// Pure client-side filtering for the date-first fixture discovery
// results — extracted out of date-mode.tsx so the default-filter set and
// the matching logic (friendlies/youth/reserve exclusion, tier
// inclusion, import status, etc.) are unit-testable without rendering
// the component. None of this ever triggers a provider request — see
// date-mode.tsx's effect dependency list, which deliberately excludes
// `filters` entirely.
import type { EnrichedFixture } from "./discovery";

export interface FixtureFilters {
  search: string;
  tiers: Set<string>;
  country: string;
  competitionType: string;
  importStatus: "not_imported" | "imported" | "all";
  hasOddsOnly: boolean;
  priorityOnly: boolean;
  excludeFriendlies: boolean;
  excludeYouth: boolean;
  excludeReserve: boolean;
}

export function defaultFixtureFilters(): FixtureFilters {
  return {
    search: "",
    tiers: new Set(["A", "B"]),
    country: "",
    competitionType: "",
    importStatus: "not_imported",
    hasOddsOnly: false,
    priorityOnly: false,
    excludeFriendlies: true,
    excludeYouth: true,
    excludeReserve: true,
  };
}

export function isDefaultFixtureFilters(f: FixtureFilters): boolean {
  const d = defaultFixtureFilters();
  return (
    f.search === d.search &&
    f.tiers.size === d.tiers.size &&
    [...f.tiers].every((t) => d.tiers.has(t)) &&
    f.country === d.country &&
    f.competitionType === d.competitionType &&
    f.importStatus === d.importStatus &&
    f.hasOddsOnly === d.hasOddsOnly &&
    f.priorityOnly === d.priorityOnly &&
    f.excludeFriendlies === d.excludeFriendlies &&
    f.excludeYouth === d.excludeYouth &&
    f.excludeReserve === d.excludeReserve
  );
}

export function matchesFixtureFilters(f: EnrichedFixture, filters: FixtureFilters): boolean {
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const haystack = `${f.homeTeamName} ${f.awayTeamName} ${f.competitionName ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  // A non-empty tier set is an inclusion filter: only fixtures with a
  // tier in the set pass (an untiered fixture never matches a non-empty
  // set). Clearing all three tier buttons (empty set) removes the filter
  // entirely — the "clear defaults, inspect every provider fixture"
  // escape hatch the spec calls for.
  if (filters.tiers.size > 0 && (!f.tier || !filters.tiers.has(f.tier))) return false;
  if (filters.country && f.competitionCountry !== filters.country) return false;
  if (filters.competitionType && f.competitionType !== filters.competitionType) return false;
  if (filters.importStatus === "not_imported" && f.isImported) return false;
  if (filters.importStatus === "imported" && !f.isImported) return false;
  if (filters.hasOddsOnly && f.hasOdds !== true) return false;
  if (filters.priorityOnly && !f.isPriority) return false;
  if (filters.excludeFriendlies && f.classification.isFriendly) return false;
  if (filters.excludeYouth && f.classification.isYouth) return false;
  if (filters.excludeReserve && f.classification.isReserve) return false;
  return true;
}

export function filterFixtures(fixtures: EnrichedFixture[], filters: FixtureFilters): EnrichedFixture[] {
  return fixtures.filter((f) => matchesFixtureFilters(f, filters));
}

/** A fixture can be selected only if it's currently visible under the
 * active filters AND not already imported — the shared eligibility rule
 * behind every selection action (single fixture, whole date, whole
 * competition, select-all-visible). */
export function eligibleFixtureIds(fixtures: EnrichedFixture[]): string[] {
  return fixtures.filter((f) => !f.isImported).map((f) => f.externalFixtureId);
}

/** Drops any selected id that no longer exists in a fresh result set — a
 * changed provider query (new date range, new competition filter, a
 * forced refresh) invalidates the previous selection rather than
 * silently carrying it forward onto different fixtures. */
export function pruneSelectionToResultSet(selected: Set<string>, fixtures: EnrichedFixture[]): Set<string> {
  const validIds = new Set(fixtures.map((f) => f.externalFixtureId));
  return new Set([...selected].filter((id) => validIds.has(id)));
}
