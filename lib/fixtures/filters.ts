// Pure client-side filtering for the date-first fixture discovery
// results — extracted out of date-mode.tsx so the default-filter set and
// the matching logic (friendlies/youth/reserve exclusion, group
// inclusion, import status, etc.) are unit-testable without rendering
// the component. None of this ever triggers a provider request — see
// date-mode.tsx's effect dependency list, which deliberately excludes
// `filters` entirely.
import type { EnrichedFixture } from "./discovery";
import type { CompetitionGroup } from "@/lib/sports-data/supported-competitions";

export interface FixtureFilters {
  search: string;
  groups: Set<CompetitionGroup>;
  // Off by default — PollPools only supports a curated list of
  // competitions; this is the explicit debugging/future-expansion escape
  // hatch to inspect what the provider returned outside that list, never
  // the default view.
  includeUnsupported: boolean;
  country: string;
  competitionType: string;
  importStatus: "not_imported" | "imported" | "all";
  hasOddsOnly: boolean;
  excludeFriendlies: boolean;
  excludeYouth: boolean;
  excludeReserve: boolean;
}

const ALL_GROUPS: CompetitionGroup[] = ["GLOBAL", "COSTA_RICA"];

export function defaultFixtureFilters(): FixtureFilters {
  return {
    search: "",
    groups: new Set(ALL_GROUPS),
    includeUnsupported: false,
    country: "",
    competitionType: "",
    importStatus: "not_imported",
    hasOddsOnly: false,
    excludeFriendlies: true,
    excludeYouth: true,
    excludeReserve: true,
  };
}

export function isDefaultFixtureFilters(f: FixtureFilters): boolean {
  const d = defaultFixtureFilters();
  return (
    f.search === d.search &&
    f.groups.size === d.groups.size &&
    [...f.groups].every((g) => d.groups.has(g)) &&
    f.includeUnsupported === d.includeUnsupported &&
    f.country === d.country &&
    f.competitionType === d.competitionType &&
    f.importStatus === d.importStatus &&
    f.hasOddsOnly === d.hasOddsOnly &&
    f.excludeFriendlies === d.excludeFriendlies &&
    f.excludeYouth === d.excludeYouth &&
    f.excludeReserve === d.excludeReserve
  );
}

export function matchesFixtureFilters(f: EnrichedFixture, filters: FixtureFilters): boolean {
  // The application boundary, not a UI preference: an unsupported
  // competition is excluded unless the admin explicitly opts in — see
  // discovery.ts's own comment on why this is the cheapest place to
  // apply SUPPORTED_COMPETITIONS (the provider request itself can't be
  // narrowed any further without becoming more expensive).
  if (!filters.includeUnsupported && !f.isSupported) return false;
  // A non-empty group set is an inclusion filter: only fixtures with a
  // group in the set pass (an unsupported fixture, group: null, never
  // matches a non-empty set). Clearing both group buttons (empty set)
  // removes the filter entirely — the "clear defaults, inspect
  // everything currently visible" escape hatch.
  if (filters.groups.size > 0 && (!f.group || !filters.groups.has(f.group))) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const haystack = `${f.homeTeamName} ${f.awayTeamName} ${f.competitionName ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (filters.country && f.competitionCountry !== filters.country) return false;
  if (filters.competitionType && f.competitionType !== filters.competitionType) return false;
  if (filters.importStatus === "not_imported" && f.isImported) return false;
  if (filters.importStatus === "imported" && !f.isImported) return false;
  if (filters.hasOddsOnly && f.hasOdds !== true) return false;
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
