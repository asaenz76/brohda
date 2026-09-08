import { describe, expect, it } from "vitest";
import { groupAndSortLocalEvents } from "@/lib/fixtures/local-event-grouping";
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
    homeTeamName: "Home Team",
    awayTeamName: "Away Team",
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

describe("groupAndSortLocalEvents", () => {
  it("groups by date, then sport, then competition", () => {
    const groups = groupAndSortLocalEvents([
      fixture({ id: "a", localDateKey: "2026-08-15" }),
      fixture({
        id: "b",
        competitionExternalId: "2",
        competitionName: "NFL Preseason",
        localDateKey: "2026-08-15",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].localDateKey).toBe("2026-08-15");
    expect(groups[0].sports.map((s) => s.sport)).toEqual(["american_football"]);
    expect(groups[0].sports[0].competitions).toHaveLength(2);
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
    const groups = groupAndSortLocalEvents([fixture({ id: "a" })]);
    expect(groups[0].sports).toHaveLength(1);
    expect(groups[0].sports[0].sport).toBe("american_football");
  });
});
