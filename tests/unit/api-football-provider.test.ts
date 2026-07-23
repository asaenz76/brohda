import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ data: null, error: null }) }),
  }),
}));

import { ApiFootballProvider } from "@/lib/sports-data/api-football-provider";

const SAMPLE_RESPONSE = {
  response: [
    {
      fixture: {
        id: 215662,
        date: "2021-04-25T14:00:00+00:00",
        timezone: "UTC",
        status: { long: "Match Finished", short: "FT", elapsed: 90 },
        venue: { name: "Emirates Stadium", city: "London" },
      },
      league: {
        id: 39,
        name: "Premier League",
        logo: "https://example.com/premier-league.png",
        season: 2020,
        round: "Regular Season - 34",
      },
      teams: {
        home: { id: 42, name: "Arsenal", logo: "https://example.com/arsenal.png" },
        away: { id: 33, name: "Manchester United", logo: "https://example.com/manutd.png" },
      },
      goals: { home: 3, away: 1 },
      score: {
        halftime: { home: 1, away: 0 },
        fulltime: { home: 3, away: 1 },
        extratime: { home: null, away: null },
        penalty: { home: null, away: null },
      },
    },
  ],
};

describe("ApiFootballProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.API_FOOTBALL_ENABLED = "true";
    process.env.API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";
    process.env.API_FOOTBALL_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports enabled/disabled based on the env var", () => {
    const provider = new ApiFootballProvider();
    expect(provider.isEnabled()).toBe(true);

    process.env.API_FOOTBALL_ENABLED = "false";
    expect(provider.isEnabled()).toBe(false);
  });

  it("returns an empty result without calling fetch when disabled", async () => {
    process.env.API_FOOTBALL_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const results = await provider.searchFixtures({ competitionExternalId: "39", season: "2020" });

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a real API-Football fixture response into NormalizedFixture", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const [fixture] = await provider.searchFixtures({
      competitionExternalId: "39",
      season: "2020",
      date: "2021-04-25",
    });

    expect(fixture).toMatchObject({
      provider: "api_football",
      externalFixtureId: "215662",
      competitionExternalId: "39",
      competitionName: "Premier League",
      competitionLogoUrl: "https://example.com/premier-league.png",
      season: "2020",
      round: "Regular Season - 34",
      homeTeamExternalId: "42",
      homeTeamName: "Arsenal",
      awayTeamExternalId: "33",
      awayTeamName: "Manchester United",
      venueName: "Emirates Stadium",
      venueCity: "London",
      venueTimezone: "Europe/London",
      providerStatusCode: "FT",
      internalStatus: "COMPLETED",
      elapsedMinutes: 90,
      homeScore: 3,
      awayScore: 1,
      halftimeHomeScore: 1,
      halftimeAwayScore: 0,
      regulationHomeScore: 3,
      regulationAwayScore: 1,
      extraTimeHomeScore: null,
      penaltyHomeScore: null,
    });

    // Request construction: league/season/date all forwarded correctly.
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("league")).toBe("39");
    expect(requestedUrl.searchParams.get("season")).toBe("2020");
    expect(requestedUrl.searchParams.get("date")).toBe("2021-04-25");
  });

  it("fetches a single fixture by external id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const fixture = await provider.getFixtureById("215662");

    expect(fixture?.externalFixtureId).toBe("215662");
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("id")).toBe("215662");
  });

  it("looks up a league's type via the /leagues endpoint, not /fixtures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            {
              league: { id: 39, name: "Premier League", type: "League", logo: null },
              country: { name: "England", code: "GB", flag: null },
              seasons: [{ year: 2020 }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const type = await provider.getLeagueType("39");

    expect(type).toBe("League");
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toContain("/leagues");
    expect(requestedUrl.searchParams.get("id")).toBe("39");
  });

  it("returns null when the league lookup finds nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    expect(await provider.getLeagueType("999999")).toBeNull();
  });

  it("returns null without calling fetch when disabled", async () => {
    process.env.API_FOOTBALL_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    expect(await provider.getLeagueType("39")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
