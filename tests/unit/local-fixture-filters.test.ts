import { describe, expect, it } from "vitest";
import {
  canCreatePool,
  defaultLocalFixtureFilters,
  filterLocalFixtures,
  isDefaultLocalFixtureFilters,
} from "@/lib/fixtures/local-filters";
import type { LocalFixture } from "@/lib/fixtures/local-browse";
import type { CompetitionGroup } from "@/lib/sports-data/supported-competitions";

function fixture(overrides: Partial<LocalFixture>): LocalFixture {
  return {
    id: "fixture-1",
    externalFixtureId: "1",
    provider: "api_football",
    sport: "football",
    competitionExternalId: "39",
    competitionName: "Premier League",
    competitionCountry: "England",
    competitionType: "LEAGUE",
    season: "2026",
    round: "Round 1",
    homeTeamName: "Arsenal",
    awayTeamName: "Chelsea",
    scheduledStartUtc: "2026-08-04T18:00:00.000Z",
    internalStatus: "NOT_STARTED",
    statusBucket: "UPCOMING",
    hiddenFromPoolCreation: false,
    isSupported: true,
    group: "GLOBAL",
    hasWorkspace: false,
    hasOdds: null,
    poolCount: 0,
    eligibility: "ELIGIBLE",
    localDateKey: "2026-08-04",
    ...overrides,
  };
}

describe("filterLocalFixtures", () => {
  it("matches search against team names and competition name", () => {
    const f = fixture({});
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), search: "arsenal" })).toHaveLength(1);
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), search: "premier" })).toHaveLength(1);
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), search: "nonexistent" })).toHaveLength(0);
  });

  it("filters by group — an empty group set removes the filter entirely", () => {
    const global = fixture({ group: "GLOBAL" });
    const costaRica = fixture({ externalFixtureId: "2", group: "COSTA_RICA" });
    const onlyGlobal = { ...defaultLocalFixtureFilters(), groups: new Set<CompetitionGroup>(["GLOBAL"]) };
    expect(filterLocalFixtures([global, costaRica], onlyGlobal)).toEqual([global]);

    const noGroupFilter = { ...defaultLocalFixtureFilters(), groups: new Set<CompetitionGroup>() };
    expect(filterLocalFixtures([global, costaRica], noGroupFilter)).toHaveLength(2);
  });

  it("filters by country and competition type", () => {
    const f = fixture({ competitionCountry: "England", competitionType: "LEAGUE" });
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), country: "England" })).toHaveLength(1);
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), country: "Spain" })).toHaveLength(0);
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), competitionType: "CUP" })).toHaveLength(0);
  });

  it("filters by round", () => {
    const f = fixture({ round: "Round 5" });
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), round: "Round 5" })).toHaveLength(1);
    expect(filterLocalFixtures([f], { ...defaultLocalFixtureFilters(), round: "Round 1" })).toHaveLength(0);
  });

  it("filters by status bucket", () => {
    const live = fixture({ statusBucket: "LIVE" });
    const completed = fixture({ externalFixtureId: "2", statusBucket: "COMPLETED" });
    expect(filterLocalFixtures([live, completed], { ...defaultLocalFixtureFilters(), status: "LIVE" })).toEqual([live]);
    expect(filterLocalFixtures([live, completed], { ...defaultLocalFixtureFilters(), status: "all" })).toHaveLength(2);
  });

  it("filters by pool status", () => {
    const hasPool = fixture({ poolCount: 2 });
    const noPool = fixture({ externalFixtureId: "2", poolCount: 0 });
    const ineligible = fixture({ externalFixtureId: "3", eligibility: "INELIGIBLE", poolCount: 0 });

    expect(filterLocalFixtures([hasPool, noPool, ineligible], { ...defaultLocalFixtureFilters(), poolStatus: "has_pool" })).toEqual([hasPool]);
    expect(filterLocalFixtures([hasPool, noPool, ineligible], { ...defaultLocalFixtureFilters(), poolStatus: "no_pool" })).toEqual([noPool, ineligible]);
    expect(filterLocalFixtures([hasPool, noPool, ineligible], { ...defaultLocalFixtureFilters(), poolStatus: "eligible_only" })).toEqual([hasPool, noPool]);
  });
});

describe("isDefaultLocalFixtureFilters", () => {
  it("is true for the default filter set and false after any change", () => {
    expect(isDefaultLocalFixtureFilters(defaultLocalFixtureFilters())).toBe(true);
    expect(isDefaultLocalFixtureFilters({ ...defaultLocalFixtureFilters(), search: "x" })).toBe(false);
    expect(isDefaultLocalFixtureFilters({ ...defaultLocalFixtureFilters(), status: "LIVE" })).toBe(false);
  });
});

describe("canCreatePool", () => {
  it("is true only for ELIGIBLE — never for COMPLETED/LOCKED/INELIGIBLE (spec §15)", () => {
    expect(canCreatePool("ELIGIBLE")).toBe(true);
    expect(canCreatePool("COMPLETED")).toBe(false);
    expect(canCreatePool("LOCKED")).toBe(false);
    expect(canCreatePool("INELIGIBLE")).toBe(false);
  });
});
