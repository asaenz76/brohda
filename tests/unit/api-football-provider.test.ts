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

  it("throws on a soft provider error (200 status, populated `errors`) shared across every endpoint, not just date-range search", async () => {
    // Proves the fix lives in the shared parseApiFootballBody choke
    // point, not duplicated (or missed) per call site — searchFixtures
    // goes through callFixturesEndpoint, a different function from
    // searchFixturesByDateRange's callFixturesByDateRangeEndpoint.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: { plan: "This endpoint is not available for this subscription." }, response: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    await expect(provider.searchFixtures({ competitionExternalId: "39", season: "2020", date: "2021-04-25" })).rejects.toThrow(/subscription/);
  });

  it("searches a league+season with no date using a from/to range starting today, not just season", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    await provider.searchFixtures({ competitionExternalId: "39", season: "2020" });

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("league")).toBe("39");
    expect(requestedUrl.searchParams.get("season")).toBe("2020");
    expect(requestedUrl.searchParams.has("date")).toBe(false);
    // Without this, a league+season search returns every fixture ever
    // played in that season, past included — the actual bug reported.
    expect(requestedUrl.searchParams.get("from")).toBe("2026-08-01");
    expect(requestedUrl.searchParams.get("to")).toBe("2028-08-01");

    vi.useRealTimers();
  });

  it("does not add a from/to range when an explicit date is given alongside league+season", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    await provider.searchFixtures({ competitionExternalId: "39", season: "2020", date: "2020-05-01" });

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("date")).toBe("2020-05-01");
    expect(requestedUrl.searchParams.has("from")).toBe(false);
    expect(requestedUrl.searchParams.has("to")).toBe(false);
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

  it("getLeagueById returns the full NormalizedLeague, seasons and coverage included", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            {
              league: { id: 39, name: "Premier League", type: "League", logo: null },
              country: { name: "England", code: "GB", flag: null },
              seasons: [
                {
                  year: 2025,
                  start: "2025-08-15",
                  end: "2026-05-24",
                  current: true,
                  coverage: {
                    fixtures: { events: true, lineups: true, statistics_fixtures: true, statistics_players: true },
                    standings: true,
                    players: true,
                    top_scorers: true,
                    top_assists: true,
                    top_cards: true,
                    injuries: true,
                    predictions: true,
                    odds: false,
                  },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const league = await provider.getLeagueById("39");

    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("id")).toBe("39");
    expect(league?.externalLeagueId).toBe("39");
    expect(league?.seasons[0].current).toBe(true);
    expect(league?.seasons[0].coverage?.odds).toBe(false);
    expect(league?.seasons[0].coverage?.fixtures.events).toBe(true);
  });

  it("getLeagueById returns null when nothing is found", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    expect(await provider.getLeagueById("999999")).toBeNull();
  });

  it("getLeagueById returns null without calling fetch when disabled", async () => {
    process.env.API_FOOTBALL_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    expect(await provider.getLeagueById("39")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches leagues and carries each season's real current flag through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            {
              league: { id: 1028, name: "CONCACAF Central American Cup", type: "Cup", logo: null },
              country: { name: "World", code: null, flag: null },
              seasons: [
                { year: 2024, start: "2024-06-01", end: "2024-08-01", current: false },
                { year: 2026, start: "2026-06-01", end: "2026-08-01", current: true },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const [league] = await provider.searchLeagues("Central American Cup");

    expect(league).toMatchObject({
      externalLeagueId: "1028",
      name: "CONCACAF Central American Cup",
      type: "Cup",
    });
    expect(league.seasons).toEqual([
      { year: "2024", startDate: "2024-06-01", endDate: "2024-08-01", current: false, coverage: null },
      { year: "2026", startDate: "2026-06-01", endDate: "2026-08-01", current: true, coverage: null },
    ]);
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toContain("/leagues");
    expect(requestedUrl.searchParams.get("search")).toBe("Central American Cup");
  });

  it("defaults a season's current flag to false when the provider omits it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            {
              league: { id: 39, name: "Premier League", type: "League", logo: null },
              country: { name: "England", code: "GB", flag: null },
              seasons: [{ year: 2020, start: "2020-08-01", end: "2021-05-01" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const [league] = await provider.searchLeagues("Premier League");

    expect(league.seasons[0].current).toBe(false);
  });

  it("searches teams by name via the /teams endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            { team: { id: 42, name: "Arsenal", logo: "https://example.com/arsenal.png", country: "England" } },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const teams = await provider.searchTeams("Arsenal");

    expect(teams).toEqual([
      {
        provider: "api_football",
        externalTeamId: "42",
        name: "Arsenal",
        countryName: "England",
        logoUrl: "https://example.com/arsenal.png",
      },
    ]);
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toContain("/teams");
    expect(requestedUrl.searchParams.get("search")).toBe("Arsenal");
  });

  it("returns an empty result without calling fetch for a blank team query", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    expect(await provider.searchTeams("   ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches fixtures by team, defaulting to the next 10 when no season/date is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    await provider.searchFixtures({ teamExternalId: "42" });

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toContain("/fixtures");
    expect(requestedUrl.searchParams.get("team")).toBe("42");
    expect(requestedUrl.searchParams.get("next")).toBe("10");
    expect(requestedUrl.searchParams.has("season")).toBe(false);
  });

  it("searches fixtures by team and season/date without the next-10 default when given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    await provider.searchFixtures({ teamExternalId: "42", season: "2024", date: "2024-05-01" });

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("team")).toBe("42");
    expect(requestedUrl.searchParams.get("season")).toBe("2024");
    expect(requestedUrl.searchParams.get("date")).toBe("2024-05-01");
    expect(requestedUrl.searchParams.has("next")).toBe(false);
  });

  describe("getSeasonFixtures", () => {
    it("requests league+season with no date/from/to restriction", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...SAMPLE_RESPONSE, paging: { current: 1, total: 1 } }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      const results = await provider.getSeasonFixtures("39", "2025");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(requestedUrl.searchParams.get("league")).toBe("39");
      expect(requestedUrl.searchParams.get("season")).toBe("2025");
      expect(requestedUrl.searchParams.has("date")).toBe(false);
      expect(requestedUrl.searchParams.has("from")).toBe(false);
      expect(requestedUrl.searchParams.has("to")).toBe(false);
      expect(results).toHaveLength(1);
    });

    it("loops through every page and concatenates results", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...SAMPLE_RESPONSE, paging: { current: 1, total: 3 } }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...SAMPLE_RESPONSE, paging: { current: 2, total: 3 } }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...SAMPLE_RESPONSE, paging: { current: 3, total: 3 } }), { status: 200 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      const results = await provider.getSeasonFixtures("39", "2025");

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("page")).toBe("2");
      expect(new URL(fetchMock.mock.calls[2][0] as string).searchParams.get("page")).toBe("3");
      expect(results).toHaveLength(3); // one SAMPLE_RESPONSE fixture per page
    });

    it("aborts once results exceed the defensive max-response-size cap", async () => {
      // 1 fixture per page — with the real cap this would take thousands of
      // pages, so this only proves the guard fires, not the exact count. A
      // fresh Response per call, since a Response body can only be read once.
      const fetchMock = vi
        .fn()
        .mockImplementation(
          () => new Response(JSON.stringify({ ...SAMPLE_RESPONSE, paging: { current: 1, total: 5000 } }), { status: 200 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      await expect(provider.getSeasonFixtures("39", "2025")).rejects.toThrow(/exceeded the defensive cap/);
    });

    it("returns an empty result without calling fetch when disabled", async () => {
      process.env.API_FOOTBALL_ENABLED = "false";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      const results = await provider.getSeasonFixtures("39", "2025");

      expect(results).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("searchFixturesByDateRange", () => {
    it("requests one bare `date=` call per UTC calendar date in the range, no league/season/from/to", async () => {
      // A fresh Response per call — a Response body can only be read once,
      // and this test drives 3 real fetch calls (mockResolvedValue would
      // reuse one already-consumed Response instance across all of them).
      const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      await provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-06" });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const dates = fetchMock.mock.calls.map((call) => new URL(call[0] as string).searchParams.get("date"));
      expect(dates).toEqual(["2026-08-04", "2026-08-05", "2026-08-06"]);
      for (const call of fetchMock.mock.calls) {
        const url = new URL(call[0] as string);
        expect(url.searchParams.has("league")).toBe(false);
        expect(url.searchParams.has("season")).toBe(false);
        expect(url.searchParams.has("from")).toBe(false);
        expect(url.searchParams.has("to")).toBe(false);
      }
    });

    it("makes exactly one call for a single-day range", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      await provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-04" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("merges and de-duplicates fixtures appearing in more than one day's response by externalFixtureId", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })); // same fixture id 215662 again
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      const results = await provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-05" });

      expect(results).toHaveLength(1);
      expect(results[0].externalFixtureId).toBe("215662");
    });

    it("adds league=X to every per-date call when a competition filter is given", async () => {
      const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      await provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-05", competitionExternalId: "262" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) {
        expect(new URL(call[0] as string).searchParams.get("league")).toBe("262");
      }
    });

    it("omits league entirely when no competition filter is given", async () => {
      const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      await provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-04" });

      expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has("league")).toBe(false);
    });

    it("propagates a provider failure rather than returning an empty result", async () => {
      // 400 is a permanent (non-retried) error in fetchWithRetry, so this
      // fails fast instead of exercising the real exponential-backoff delay.
      const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      await expect(provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-04" })).rejects.toThrow();
    });

    it("throws on a 200 response carrying a populated `errors` object (e.g. daily quota exhausted) instead of treating it as zero fixtures", async () => {
      // API-Football's real quota-exhaustion shape, confirmed live: HTTP
      // 200, `errors.requests` populated, `response: []`. Before the fix
      // this was indistinguishable from a genuine empty day.
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: { requests: "You have reached the request limit for the day, Go to https://dashboard.api-football.com to upgrade your plan." },
            results: 0,
            paging: { current: 1, total: 1 },
            response: [],
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      await expect(provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-04" })).rejects.toThrow(/request limit/);
    });

    it("treats a 200 response with an empty `errors` object as a genuine success, not a failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: {}, results: 0, response: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      const results = await provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-04" });
      expect(results).toEqual([]);
    });

    it("returns an empty result without calling fetch when disabled", async () => {
      process.env.API_FOOTBALL_ENABLED = "false";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const provider = new ApiFootballProvider();
      const results = await provider.searchFixturesByDateRange({ fromDate: "2026-08-04", toDate: "2026-08-05" });

      expect(results).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
