import { describe, expect, it } from "vitest";
import { groupAndSortLocalFixtures } from "@/lib/fixtures/local-grouping";
import type { LocalFixture } from "@/lib/fixtures/local-browse";

function fixture(overrides: Partial<LocalFixture>): LocalFixture {
  return {
    id: "fixture-1",
    externalFixtureId: "1",
    provider: "api_football",
    competitionExternalId: "39",
    competitionName: "Premier League",
    competitionCountry: "England",
    competitionType: "LEAGUE",
    season: "2026",
    round: null,
    homeTeamName: "Home",
    awayTeamName: "Away",
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

describe("groupAndSortLocalFixtures", () => {
  it("groups by local date ascending", () => {
    const groups = groupAndSortLocalFixtures([
      fixture({ id: "1", localDateKey: "2026-08-05" }),
      fixture({ id: "2", localDateKey: "2026-08-04" }),
    ]);
    expect(groups.map((g) => g.localDateKey)).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("groups fixtures within a date by competition (external id + season)", () => {
    const groups = groupAndSortLocalFixtures([
      fixture({ id: "1", competitionExternalId: "39", season: "2026" }),
      fixture({ id: "2", competitionExternalId: "39", season: "2026" }),
      fixture({ id: "3", competitionExternalId: "140", season: "2026", competitionName: "LaLiga" }),
    ]);
    expect(groups[0].competitions).toHaveLength(2);
    const pl = groups[0].competitions.find((c) => c.competitionExternalId === "39")!;
    expect(pl.fixtures).toHaveLength(2);
  });

  it("sorts fixtures within a competition group by kickoff time ascending", () => {
    const groups = groupAndSortLocalFixtures([
      fixture({ id: "1", scheduledStartUtc: "2026-08-04T20:00:00.000Z" }),
      fixture({ id: "2", scheduledStartUtc: "2026-08-04T14:00:00.000Z" }),
    ]);
    expect(groups[0].competitions[0].fixtures.map((f) => f.id)).toEqual(["2", "1"]);
  });

  it("ranks GLOBAL before COSTA_RICA before unsupported (null group)", () => {
    const groups = groupAndSortLocalFixtures([
      fixture({ id: "1", competitionExternalId: "163", group: "COSTA_RICA", competitionName: "Liga de Ascenso" }),
      fixture({ id: "2", competitionExternalId: "999", group: null, isSupported: false, competitionName: "Unlisted" }),
      fixture({ id: "3", competitionExternalId: "39", group: "GLOBAL", competitionName: "Premier League" }),
    ]);
    expect(groups[0].competitions.map((c) => c.group)).toEqual(["GLOBAL", "COSTA_RICA", null]);
  });

  it("within the same group, a managed workspace sorts before an unmanaged one", () => {
    const groups = groupAndSortLocalFixtures([
      fixture({ id: "1", competitionExternalId: "39", hasWorkspace: false, competitionName: "A League" }),
      fixture({ id: "2", competitionExternalId: "140", hasWorkspace: true, competitionName: "Z League" }),
    ]);
    expect(groups[0].competitions.map((c) => c.competitionExternalId)).toEqual(["140", "39"]);
  });
});
