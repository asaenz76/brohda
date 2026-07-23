import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEventDetail, normalizeEventType } from "@/lib/sports-data/events";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ data: null, error: null }) }),
  }),
}));

import { ApiFootballProvider } from "@/lib/sports-data/api-football-provider";

describe("normalizeEventDetail", () => {
  it.each([
    ["Goal", "Normal Goal", "GOAL_NORMAL"],
    ["Goal", "Own Goal", "GOAL_OWN"],
    ["Goal", "Penalty", "GOAL_PENALTY"],
    ["Goal", "Missed Penalty", "GOAL_PENALTY_MISSED"],
    ["Card", "Yellow Card", "CARD_YELLOW"],
    ["Card", "Red Card", "CARD_RED"],
    ["Card", "Second Yellow card", "CARD_SECOND_YELLOW"],
  ] as const)("maps (%s, %s) -> %s", (rawType, rawDetail, expected) => {
    expect(normalizeEventDetail(rawType, rawDetail)).toBe(expected);
  });

  it("falls back to SUBSTITUTION/VAR type strings without a detail pairing", () => {
    expect(normalizeEventDetail("subst", "Substitution 1")).toBe("SUBSTITUTION");
    expect(normalizeEventDetail("Var", "Goal Cancelled")).toBe("VAR");
  });

  it("returns UNKNOWN for an unrecognized pairing", () => {
    expect(normalizeEventDetail("Goal", "Some New Detail")).toBe("UNKNOWN");
  });

  it("returns UNKNOWN when type or detail is missing", () => {
    expect(normalizeEventDetail(null, "Normal Goal")).toBe("UNKNOWN");
    expect(normalizeEventDetail("Goal", undefined)).toBe("UNKNOWN");
  });
});

describe("normalizeEventType", () => {
  it.each([
    ["goal", "GOAL"],
    ["card", "CARD"],
    ["subst", "SUBSTITUTION"],
    ["var", "VAR"],
  ] as const)("maps raw type %s -> %s", (rawType, expected) => {
    expect(normalizeEventType(rawType)).toBe(expected);
  });

  it("falls back to VAR for an unrecognized or missing type", () => {
    expect(normalizeEventType("something-else")).toBe("VAR");
    expect(normalizeEventType(null)).toBe("VAR");
  });
});

describe("ApiFootballProvider.getFixtureEvents", () => {
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

  it("maps a real API-Football events response into NormalizedFixtureEvent[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            {
              time: { elapsed: 75, extra: null },
              team: { id: 42, name: "Arsenal" },
              player: { id: 999, name: "Bukayo Saka" },
              assist: { id: 888, name: "Martin Odegaard" },
              type: "Goal",
              detail: "Normal Goal",
            },
            {
              time: { elapsed: 90, extra: 4 },
              team: { id: 33, name: "Manchester United" },
              player: { id: 111, name: "Some Player" },
              assist: { id: null, name: null },
              type: "Card",
              detail: "Red Card",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const events = await provider.getFixtureEvents("215662");

    expect(events).toEqual([
      {
        effectiveMinute: 75,
        teamExternalId: "42",
        playerExternalId: "999",
        playerName: "Bukayo Saka",
        assistPlayerExternalId: "888",
        assistPlayerName: "Martin Odegaard",
        type: "GOAL",
        detail: "GOAL_NORMAL",
      },
      {
        effectiveMinute: 94,
        teamExternalId: "33",
        playerExternalId: "111",
        playerName: "Some Player",
        assistPlayerExternalId: null,
        assistPlayerName: null,
        type: "CARD",
        detail: "CARD_RED",
      },
    ]);

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toContain("/fixtures/events");
    expect(requestedUrl.searchParams.get("fixture")).toBe("215662");
  });

  it("returns an empty array without calling fetch when disabled", async () => {
    process.env.API_FOOTBALL_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    expect(await provider.getFixtureEvents("215662")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ApiFootballProvider.getTeamSquad", () => {
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

  it("maps a real API-Football squad response into NormalizedPlayer[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            {
              team: { id: 42, name: "Arsenal" },
              players: [
                { id: 999, name: "Bukayo Saka", position: "Attacker", number: 7 },
                { id: 111, name: "Aaron Ramsdale", position: "Goalkeeper", number: 1 },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    const squad = await provider.getTeamSquad("42");

    expect(squad).toEqual([
      { externalPlayerId: "999", name: "Bukayo Saka", position: "Attacker", jerseyNumber: 7 },
      { externalPlayerId: "111", name: "Aaron Ramsdale", position: "Goalkeeper", jerseyNumber: 1 },
    ]);

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toContain("/players/squads");
    expect(requestedUrl.searchParams.get("team")).toBe("42");
  });

  it("returns an empty array without calling fetch when disabled", async () => {
    process.env.API_FOOTBALL_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ApiFootballProvider();
    expect(await provider.getTeamSquad("42")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
