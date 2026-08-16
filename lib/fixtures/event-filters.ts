// Pure client-side filtering for the Events browse result (Phase 4 spec
// §9/§10). Same discipline as local-filters.ts (Phase 2): one date-window
// query fetches the full result set once, every filter/search change
// after that is a plain in-memory filter — never a refetch, never a
// provider call (spec §6/§10). A sibling to local-filters.ts, not a
// replacement — /admin/fixtures keeps using that one unchanged.
import type { EventSport, LocalFixture, PoolEligibilityStatus, StatusBucket } from "./local-browse";

export type EventPoolStatusFilter = "all" | "has_pool" | "no_pool";

export interface EventFilters {
  search: string;
  sports: Set<EventSport>;
  competitionExternalId: string; // "" = every competition
  status: StatusBucket | "all";
  poolStatus: EventPoolStatusFilter;
}

export function defaultEventFilters(sports: EventSport[]): EventFilters {
  return {
    search: "",
    sports: new Set(sports),
    competitionExternalId: "",
    status: "all",
    poolStatus: "all",
  };
}

function matchesPoolStatus(f: LocalFixture, poolStatus: EventPoolStatusFilter): boolean {
  if (poolStatus === "has_pool") return f.poolCount > 0;
  if (poolStatus === "no_pool") return f.poolCount === 0;
  return true;
}

export function matchesEventFilters(f: LocalFixture, filters: EventFilters): boolean {
  if (!filters.sports.has(f.sport as EventSport)) return false;
  if (filters.competitionExternalId && f.competitionExternalId !== filters.competitionExternalId) return false;
  if (filters.status !== "all" && f.statusBucket !== filters.status) return false;
  if (!matchesPoolStatus(f, filters.poolStatus)) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const haystack = `${f.homeTeamName} ${f.awayTeamName} ${f.competitionName ?? ""} ${f.round ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export function filterEvents(fixtures: LocalFixture[], filters: EventFilters): LocalFixture[] {
  return fixtures.filter((f) => matchesEventFilters(f, filters));
}

/** Same rule as local-filters.ts's canCreatePool — never inferred from
 * status alone, always the canonical eligibility view's own answer. */
export function canCreatePool(eligibility: PoolEligibilityStatus): boolean {
  return eligibility === "ELIGIBLE";
}
