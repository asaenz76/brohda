import { describe, expect, it } from "vitest";
import { toFixtureRow } from "@/lib/sports-data/persist";
import type { NormalizedFixture } from "@/lib/sports-data/types";

const BASE_FIXTURE: NormalizedFixture = {
  provider: "api_football",
  externalFixtureId: "215662",
  sport: "football",
  competitionExternalId: "39",
  competitionName: "Premier League",
  competitionCountry: "England",
  competitionLogoUrl: null,
  season: "2020",
  round: "Regular Season - 34",
  homeTeamExternalId: "42",
  homeTeamName: "Arsenal",
  homeTeamLogoUrl: null,
  awayTeamExternalId: "33",
  awayTeamName: "Manchester United",
  awayTeamLogoUrl: null,
  venueName: null,
  venueCity: null,
  venueTimezone: null,
  scheduledStartUtc: "2021-04-25T14:00:00.000Z",
  providerTimezone: null,
  providerStatusCode: "FT",
  providerStatusDescription: "Match Finished",
  internalStatus: "COMPLETED",
  elapsedMinutes: 90,
  homeScore: 3,
  awayScore: 1,
  halftimeHomeScore: 1,
  halftimeAwayScore: 0,
  regulationHomeScore: 3,
  regulationAwayScore: 1,
  extraTimeHomeScore: null,
  extraTimeAwayScore: null,
  penaltyHomeScore: null,
  penaltyAwayScore: null,
  providerPayload: {},
};

describe("toFixtureRow competition_type handling", () => {
  it("omits competition_type entirely when the fixture was never enriched (sync-job path)", () => {
    // BASE_FIXTURE has no competitionType key at all, matching what
    // mapFixture always produces (the /fixtures endpoint never returns it).
    const row = toFixtureRow(BASE_FIXTURE);
    expect("competition_type" in row).toBe(false);
  });

  it("includes competition_type when the import path explicitly set it", () => {
    const row = toFixtureRow({ ...BASE_FIXTURE, competitionType: "Cup" });
    expect(row.competition_type).toBe("Cup");
  });

  it("includes an explicit null when the league lookup found nothing", () => {
    const row = toFixtureRow({ ...BASE_FIXTURE, competitionType: null });
    expect("competition_type" in row).toBe(true);
    expect(row.competition_type).toBeNull();
  });
});
