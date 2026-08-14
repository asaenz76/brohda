// Pure client-side filtering for the local-first fixture browsing results
// (By date and By competition, Phase 2). No DB/network here — a full
// competition-season or date-window result set is fetched once (see
// lib/fixtures/local-browse.ts), and every further filter change is a
// plain in-memory filter, never a refetch. This is what makes filter
// changes instant (spec §20) instead of another server round trip.
import type { CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import type { LocalFixture, PoolEligibilityStatus, StatusBucket } from "./local-browse";

export type PoolStatusFilter = "all" | "has_pool" | "no_pool" | "eligible_only";

export interface LocalFixtureFilters {
  search: string;
  // Relevant to By date (Global vs Costa Rica); harmless no-op in By
  // competition, where every result already shares one group.
  groups: Set<CompetitionGroup>;
  country: string;
  competitionType: string;
  round: string;
  status: StatusBucket | "all";
  poolStatus: PoolStatusFilter;
}

const ALL_GROUPS: CompetitionGroup[] = ["GLOBAL", "COSTA_RICA"];

export function defaultLocalFixtureFilters(): LocalFixtureFilters {
  return {
    search: "",
    groups: new Set(ALL_GROUPS),
    country: "",
    competitionType: "",
    round: "",
    status: "all",
    poolStatus: "all",
  };
}

export function isDefaultLocalFixtureFilters(f: LocalFixtureFilters): boolean {
  const d = defaultLocalFixtureFilters();
  return (
    f.search === d.search &&
    f.groups.size === d.groups.size &&
    [...f.groups].every((g) => d.groups.has(g)) &&
    f.country === d.country &&
    f.competitionType === d.competitionType &&
    f.round === d.round &&
    f.status === d.status &&
    f.poolStatus === d.poolStatus
  );
}

function matchesPoolStatus(f: LocalFixture, poolStatus: PoolStatusFilter): boolean {
  switch (poolStatus) {
    case "has_pool":
      return f.poolCount > 0;
    case "no_pool":
      return f.poolCount === 0;
    case "eligible_only":
      return f.eligibility === "ELIGIBLE";
    default:
      return true;
  }
}

export function matchesLocalFixtureFilters(f: LocalFixture, filters: LocalFixtureFilters): boolean {
  if (filters.groups.size > 0 && (!f.group || !filters.groups.has(f.group))) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const haystack = `${f.homeTeamName} ${f.awayTeamName} ${f.competitionName ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (filters.country && f.competitionCountry !== filters.country) return false;
  if (filters.competitionType && f.competitionType !== filters.competitionType) return false;
  if (filters.round && f.round !== filters.round) return false;
  if (filters.status !== "all" && f.statusBucket !== filters.status) return false;
  if (!matchesPoolStatus(f, filters.poolStatus)) return false;
  return true;
}

export function filterLocalFixtures(fixtures: LocalFixture[], filters: LocalFixtureFilters): LocalFixture[] {
  return fixtures.filter((f) => matchesLocalFixtureFilters(f, filters));
}

/** A fixture only ever gets a "Create Pool" action when the eligibility
 * view itself says so — never inferred from status alone, so a completed
 * fixture visible through a custom range can never present it (spec §15). */
export function canCreatePool(eligibility: PoolEligibilityStatus): boolean {
  return eligibility === "ELIGIBLE";
}
