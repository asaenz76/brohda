import { describe, expect, it } from "vitest";
import { canCreatePool, defaultEventFilters, filterEvents, matchesEventFilters } from "@/lib/fixtures/event-filters";
import type { LocalFixture } from "@/lib/fixtures/local-browse";

function fixture(overrides: Partial<LocalFixture> = {}): LocalFixture {
  return {
    id: "id-1",
    externalFixtureId: "ext-1",
    provider: "api_nfl",
    sport: "american_football",
    competitionExternalId: "1",
    competitionName: "NFL",
    competitionCountry: "USA",
    competitionType: "LEAGUE",
    season: "2026",
    round: "Regular Season - 1",
    homeTeamName: "Arsenal",
    awayTeamName: "Chelsea",
    scheduledStartUtc: "2026-08-15T18:00:00.000Z",
    internalStatus: "NOT_STARTED",
    statusBucket: "UPCOMING",
    hiddenFromPoolCreation: false,
    isSupported: true,
    hasWorkspace: true,
    hasOdds: null,
    poolCount: 0,
    eligibility: "ELIGIBLE",
    localDateKey: "2026-08-15",
    ...overrides,
  };
}

describe("matchesEventFilters", () => {
  it("filters by sport", () => {
    const f = fixture({ sport: "american_football" });
    const filters = { ...defaultEventFilters(["american_football"]), sports: new Set<"american_football">() };
    expect(matchesEventFilters(f, filters)).toBe(false);
    expect(matchesEventFilters(f, { ...filters, sports: new Set(["american_football"]) })).toBe(true);
  });

  it("filters by competition", () => {
    const f = fixture({ competitionExternalId: "1" });
    const filters = { ...defaultEventFilters(["american_football"]), competitionExternalId: "2" };
    expect(matchesEventFilters(f, filters)).toBe(false);
    expect(matchesEventFilters(f, { ...filters, competitionExternalId: "1" })).toBe(true);
  });

  it("filters by status bucket", () => {
    const f = fixture({ statusBucket: "LIVE" });
    const filters = { ...defaultEventFilters(["american_football"]), status: "UPCOMING" as const };
    expect(matchesEventFilters(f, filters)).toBe(false);
    expect(matchesEventFilters(f, { ...filters, status: "LIVE" as const })).toBe(true);
  });

  it("filters by pool status: has_pool / no_pool", () => {
    const withPool = fixture({ poolCount: 2 });
    const withoutPool = fixture({ poolCount: 0 });
    const hasPoolFilters = { ...defaultEventFilters(["american_football"]), poolStatus: "has_pool" as const };
    expect(matchesEventFilters(withPool, hasPoolFilters)).toBe(true);
    expect(matchesEventFilters(withoutPool, hasPoolFilters)).toBe(false);

    const noPoolFilters = { ...defaultEventFilters(["american_football"]), poolStatus: "no_pool" as const };
    expect(matchesEventFilters(withPool, noPoolFilters)).toBe(false);
    expect(matchesEventFilters(withoutPool, noPoolFilters)).toBe(true);
  });

  it("search matches home team, away team, competition name, and round — case-insensitive", () => {
    const f = fixture({ homeTeamName: "Arsenal", awayTeamName: "Chelsea", competitionName: "NFL", round: "Round 3" });
    const filters = defaultEventFilters(["american_football"]);
    expect(matchesEventFilters(f, { ...filters, search: "arsenal" })).toBe(true);
    expect(matchesEventFilters(f, { ...filters, search: "CHELSEA" })).toBe(true);
    expect(matchesEventFilters(f, { ...filters, search: "nfl" })).toBe(true);
    expect(matchesEventFilters(f, { ...filters, search: "round 3" })).toBe(true);
    expect(matchesEventFilters(f, { ...filters, search: "liverpool" })).toBe(false);
  });
});

describe("filterEvents", () => {
  it("applies all active filters together", () => {
    const events = [
      fixture({ id: "a", poolCount: 1 }),
      fixture({ id: "b", poolCount: 0 }),
      fixture({ id: "c", poolCount: 0 }),
    ];
    const result = filterEvents(events, { ...defaultEventFilters(["american_football"]), poolStatus: "has_pool" });
    expect(result.map((f) => f.id)).toEqual(["a"]);
  });
});

describe("canCreatePool", () => {
  it("is true only for ELIGIBLE", () => {
    expect(canCreatePool("ELIGIBLE")).toBe(true);
    expect(canCreatePool("COMPLETED")).toBe(false);
    expect(canCreatePool("LOCKED")).toBe(false);
    expect(canCreatePool("INELIGIBLE")).toBe(false);
  });
});
