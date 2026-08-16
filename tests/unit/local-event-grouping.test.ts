import { describe, expect, it } from "vitest";
import { groupAndSortLocalEvents } from "@/lib/fixtures/local-event-grouping";
import type { LocalFixture } from "@/lib/fixtures/local-browse";

function fixture(overrides: Partial<LocalFixture> = {}): LocalFixture {
  return {
    id: "id-1",
    externalFixtureId: "ext-1",
    provider: "api_football",
    sport: "football",
    competitionExternalId: "39",
    competitionName: "Premier League",
    competitionCountry: "England",
    competitionType: "LEAGUE",
    season: "2026",
    round: "Round 1",
    homeTeamName: "Home FC",
    awayTeamName: "Away FC",
    scheduledStartUtc: "2026-08-15T18:00:00.000Z",
    internalStatus: "NOT_STARTED",
    statusBucket: "UPCOMING",
    hiddenFromPoolCreation: false,
    isSupported: true,
    group: "GLOBAL",
    hasWorkspace: true,
    hasOdds: null,
    poolCount: 0,
    eligibility: "ELIGIBLE",
    localDateKey: "2026-08-15",
    ...overrides,
  };
}

describe("groupAndSortLocalEvents", () => {
  it("groups by date, then sport, then competition", () => {
    const groups = groupAndSortLocalEvents([
      fixture({ id: "fb-1", sport: "football", localDateKey: "2026-08-15" }),
      fixture({
        id: "nfl-1",
        sport: "american_football",
        provider: "api_nfl",
        competitionExternalId: "1",
        competitionName: "NFL",
        competitionCountry: null,
        group: null,
        localDateKey: "2026-08-15",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].localDateKey).toBe("2026-08-15");
    expect(groups[0].sports.map((s) => s.sport)).toEqual(["football", "american_football"]);
  });

  it("football always sorts before NFL within a date, regardless of insertion order", () => {
    const groups = groupAndSortLocalEvents([
      fixture({ id: "nfl-1", sport: "american_football", provider: "api_nfl", competitionExternalId: "1", group: null }),
      fixture({ id: "fb-1", sport: "football" }),
    ]);
    expect(groups[0].sports.map((s) => s.sport)).toEqual(["football", "american_football"]);
  });

  it("sorts dates ascending and fixtures within a competition by kickoff time", () => {
    const groups = groupAndSortLocalEvents([
      fixture({ id: "a", localDateKey: "2026-08-16", scheduledStartUtc: "2026-08-16T20:00:00.000Z" }),
      fixture({ id: "b", localDateKey: "2026-08-15", scheduledStartUtc: "2026-08-15T20:00:00.000Z" }),
      fixture({ id: "c", localDateKey: "2026-08-15", scheduledStartUtc: "2026-08-15T12:00:00.000Z" }),
    ]);
    expect(groups.map((g) => g.localDateKey)).toEqual(["2026-08-15", "2026-08-16"]);
    const day1Fixtures = groups[0].sports[0].competitions[0].fixtures.map((f) => f.id);
    expect(day1Fixtures).toEqual(["c", "b"]);
  });

  it("a sport with zero events on a given date contributes no empty group", () => {
    const groups = groupAndSortLocalEvents([fixture({ id: "fb-1", sport: "football" })]);
    expect(groups[0].sports).toHaveLength(1);
    expect(groups[0].sports[0].sport).toBe("football");
  });
});
