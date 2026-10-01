// Pure client-side filtering for the Events browse result (Phase 4 spec
// §9/§10). Same discipline as local-filters.ts (Phase 2): one date-window
// query fetches the full result set once, every filter/search change
// after that is a plain in-memory filter — never a refetch, never a
// provider call (spec §6/§10). A sibling to local-filters.ts, not a
// replacement — /admin/fixtures keeps using that one unchanged.
import type { EventSport, LocalFixture, StatusBucket } from "./local-browse";

export interface EventFilters {
  search: string;
  sports: Set<EventSport>;
  competitionExternalId: string; // "" = every competition
  status: StatusBucket | "all";
}

export function defaultEventFilters(sports: EventSport[]): EventFilters {
  return {
    search: "",
    sports: new Set(sports),
    competitionExternalId: "",
    status: "all",
  };
}

export function matchesEventFilters(f: LocalFixture, filters: EventFilters): boolean {
  if (!filters.sports.has(f.sport as EventSport)) return false;
  if (filters.competitionExternalId && f.competitionExternalId !== filters.competitionExternalId) return false;
  if (filters.status !== "all" && f.statusBucket !== filters.status) return false;
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
