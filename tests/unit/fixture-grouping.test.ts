import { describe, expect, it } from "vitest";
import { groupAndSortFixtures } from "@/lib/fixtures/grouping";
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
    homeTeamName: "Home",
    awayTeamExternalId: null,
    awayTeamName: "Away",
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

describe("groupAndSortFixtures", () => {
  it("groups by local date ascending", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "1", localDateKey: "2026-08-05" }),
      fixture({ externalFixtureId: "2", localDateKey: "2026-08-04" }),
    ]);
    expect(groups.map((g) => g.localDateKey)).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("groups fixtures within a date by competition (external id + season)", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "1", competitionExternalId: "39", season: "2026" }),
      fixture({ externalFixtureId: "2", competitionExternalId: "39", season: "2026" }),
      fixture({ externalFixtureId: "3", competitionExternalId: "140", season: "2026", competitionName: "LaLiga" }),
    ]);
    expect(groups[0].competitions).toHaveLength(2);
    const pl = groups[0].competitions.find((c) => c.competitionExternalId === "39")!;
    expect(pl.fixtures).toHaveLength(2);
  });

  it("sorts fixtures within a competition group by kickoff time ascending", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "1", scheduledStartUtc: "2026-08-04T21:00:00.000Z" }),
      fixture({ externalFixtureId: "2", scheduledStartUtc: "2026-08-04T18:00:00.000Z" }),
    ]);
    expect(groups[0].competitions[0].fixtures.map((f) => f.externalFixtureId)).toEqual(["2", "1"]);
  });

  it("orders competition groups by tier: A before B before C before untiered", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "1", competitionExternalId: "1", competitionName: "Untiered", tier: null, isPriority: false }),
      fixture({ externalFixtureId: "2", competitionExternalId: "2", competitionName: "TierC", tier: "C" }),
      fixture({ externalFixtureId: "3", competitionExternalId: "3", competitionName: "TierB", tier: "B" }),
      fixture({ externalFixtureId: "4", competitionExternalId: "4", competitionName: "TierA", tier: "A" }),
    ]);
    expect(groups[0].competitions.map((c) => c.competitionName)).toEqual(["TierA", "TierB", "TierC", "Untiered"]);
  });

  it("within the same tier, an imported Workspace competition sorts before one without", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "1", competitionExternalId: "1", competitionName: "NoWorkspace", tier: "A", hasWorkspace: false }),
      fixture({ externalFixtureId: "2", competitionExternalId: "2", competitionName: "HasWorkspace", tier: "A", hasWorkspace: true }),
    ]);
    expect(groups[0].competitions.map((c) => c.competitionName)).toEqual(["HasWorkspace", "NoWorkspace"]);
  });

  it("within the same tier and workspace status, odds-available sorts before odds-unavailable/unknown", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "1", competitionExternalId: "1", competitionName: "NoOdds", tier: "A", hasWorkspace: false, hasOdds: null }),
      fixture({ externalFixtureId: "2", competitionExternalId: "2", competitionName: "HasOdds", tier: "A", hasWorkspace: false, hasOdds: true }),
    ]);
    expect(groups[0].competitions.map((c) => c.competitionName)).toEqual(["HasOdds", "NoOdds"]);
  });

  it("falls back to alphabetical competition name within the same tier/workspace/odds standing", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "1", competitionExternalId: "1", competitionName: "Zeta League", tier: "A" }),
      fixture({ externalFixtureId: "2", competitionExternalId: "2", competitionName: "Alpha League", tier: "A" }),
    ]);
    expect(groups[0].competitions.map((c) => c.competitionName)).toEqual(["Alpha League", "Zeta League"]);
  });

  it("never leaves the result in raw input order when it doesn't already match the sort", () => {
    const groups = groupAndSortFixtures([
      fixture({ externalFixtureId: "3", competitionExternalId: "3", competitionName: "TierC", tier: "C", localDateKey: "2026-08-04" }),
      fixture({ externalFixtureId: "1", competitionExternalId: "1", competitionName: "TierA", tier: "A", localDateKey: "2026-08-04" }),
      fixture({ externalFixtureId: "2", competitionExternalId: "2", competitionName: "TierB", tier: "B", localDateKey: "2026-08-04" }),
    ]);
    expect(groups[0].competitions.map((c) => c.competitionName)).toEqual(["TierA", "TierB", "TierC"]);
  });
});
