import { describe, expect, it } from "vitest";
import {
  defaultFixtureFilters,
  eligibleFixtureIds,
  filterFixtures,
  isDefaultFixtureFilters,
  pruneSelectionToResultSet,
} from "@/lib/fixtures/filters";
import type { EnrichedFixture } from "@/lib/fixtures/discovery";

function fixture(overrides: Partial<EnrichedFixture>): EnrichedFixture {
  return {
    externalFixtureId: "1",
    competitionExternalId: "39",
    competitionName: "Premier League",
    competitionCountry: "England",
    competitionType: "League",
    season: "2026",
    round: null,
    homeTeamExternalId: null,
    homeTeamName: "Arsenal",
    awayTeamExternalId: null,
    awayTeamName: "Chelsea",
    scheduledStartUtc: "2026-08-04T18:00:00.000Z",
    internalStatus: "NOT_STARTED",
    venueName: null,
    isImported: false,
    importedFixtureId: null,
    isPriority: true,
    tier: "A",
    hasWorkspace: false,
    hasOdds: null,
    classification: { isFriendly: false, isYouth: false, isReserve: false },
    localDateKey: "2026-08-04",
    ...overrides,
  };
}

describe("default filters", () => {
  it("excludes friendlies by default", () => {
    const friendly = fixture({ competitionName: "Friendlies", classification: { isFriendly: true, isYouth: false, isReserve: false } });
    expect(filterFixtures([friendly], defaultFixtureFilters())).toHaveLength(0);
  });

  it("excludes youth competitions by default", () => {
    const youth = fixture({ competitionName: "UEFA U19 Championship", classification: { isFriendly: false, isYouth: true, isReserve: false } });
    expect(filterFixtures([youth], defaultFixtureFilters())).toHaveLength(0);
  });

  it("excludes reserve competitions by default", () => {
    const reserve = fixture({ classification: { isFriendly: false, isYouth: false, isReserve: true } });
    expect(filterFixtures([reserve], defaultFixtureFilters())).toHaveLength(0);
  });

  it("clearing filters reveals excluded competition types", () => {
    const friendly = fixture({ classification: { isFriendly: true, isYouth: false, isReserve: false } });
    const youth = fixture({ externalFixtureId: "2", classification: { isFriendly: false, isYouth: true, isReserve: false } });
    const reserve = fixture({ externalFixtureId: "3", classification: { isFriendly: false, isYouth: false, isReserve: true } });
    const cleared = { ...defaultFixtureFilters(), tiers: new Set<string>(), excludeFriendlies: false, excludeYouth: false, excludeReserve: false };
    expect(filterFixtures([friendly, youth, reserve], cleared)).toHaveLength(3);
  });

  it("excludes already-imported fixtures by default (importStatus: not_imported)", () => {
    const imported = fixture({ isImported: true });
    expect(filterFixtures([imported], defaultFixtureFilters())).toHaveLength(0);
  });

  it("defaults to Tier A + Tier B only", () => {
    const tierC = fixture({ tier: "C" });
    const untiered = fixture({ externalFixtureId: "2", tier: null, isPriority: false });
    expect(filterFixtures([tierC, untiered], defaultFixtureFilters())).toHaveLength(0);
  });

  it("isDefaultFixtureFilters correctly identifies the default set and detects any change", () => {
    expect(isDefaultFixtureFilters(defaultFixtureFilters())).toBe(true);
    expect(isDefaultFixtureFilters({ ...defaultFixtureFilters(), search: "arsenal" })).toBe(false);
    expect(isDefaultFixtureFilters({ ...defaultFixtureFilters(), excludeFriendlies: false })).toBe(false);
  });
});

describe("filterFixtures — individual filter dimensions", () => {
  it("filters by tier as an inclusion set — clearing all tiers removes the filter entirely", () => {
    const tierA = fixture({ tier: "A" });
    const tierC = fixture({ externalFixtureId: "2", tier: "C" });
    const noTierFilter = { ...defaultFixtureFilters(), tiers: new Set<string>() };
    expect(filterFixtures([tierA, tierC], noTierFilter)).toHaveLength(2);
  });

  it("filters by country", () => {
    const england = fixture({ competitionCountry: "England" });
    const spain = fixture({ externalFixtureId: "2", competitionCountry: "Spain" });
    const filters = { ...defaultFixtureFilters(), tiers: new Set<string>(), country: "Spain" };
    expect(filterFixtures([england, spain], filters)).toEqual([spain]);
  });

  it("filters by search text across team and competition names", () => {
    const arsenal = fixture({ homeTeamName: "Arsenal", awayTeamName: "Chelsea" });
    const other = fixture({ externalFixtureId: "2", homeTeamName: "Flamengo", awayTeamName: "Palmeiras" });
    const filters = { ...defaultFixtureFilters(), tiers: new Set<string>(), search: "arsenal" };
    expect(filterFixtures([arsenal, other], filters)).toEqual([arsenal]);
  });

  it("filters by hasOdds when requested", () => {
    const withOdds = fixture({ hasOdds: true });
    const withoutOdds = fixture({ externalFixtureId: "2", hasOdds: false });
    const unknown = fixture({ externalFixtureId: "3", hasOdds: null });
    const filters = { ...defaultFixtureFilters(), tiers: new Set<string>(), hasOddsOnly: true };
    expect(filterFixtures([withOdds, withoutOdds, unknown], filters)).toEqual([withOdds]);
  });
});

describe("eligibleFixtureIds", () => {
  it("excludes already-imported fixtures", () => {
    const a = fixture({ externalFixtureId: "1", isImported: false });
    const b = fixture({ externalFixtureId: "2", isImported: true });
    expect(eligibleFixtureIds([a, b])).toEqual(["1"]);
  });
});

describe("pruneSelectionToResultSet", () => {
  it("drops selected ids no longer present in a fresh result set (a changed query invalidates the old selection)", () => {
    const selected = new Set(["1", "2", "3"]);
    const freshResults = [fixture({ externalFixtureId: "2" }), fixture({ externalFixtureId: "4" })];
    expect(pruneSelectionToResultSet(selected, freshResults)).toEqual(new Set(["2"]));
  });

  it("keeps the full selection when every id is still present", () => {
    const selected = new Set(["1", "2"]);
    const freshResults = [fixture({ externalFixtureId: "1" }), fixture({ externalFixtureId: "2" })];
    expect(pruneSelectionToResultSet(selected, freshResults)).toEqual(new Set(["1", "2"]));
  });
});
