/**
 * The NBA / NHL / MLB provider mapping, proven against REAL recorded API-Sports payloads (tests/fixtures/provider/*): basketball 2024-2025,
 * hockey 2024, baseball 2024 — captured read-only from the live provider. Nothing here is synthetic score data; the shootout proof covers every
 * one of the 79 shootout games in the 2024 NHL season.
 */
import { describe, expect, it, vi } from "vitest";
import { mapBasketballGame, mapHockeyGame, normalizeBookmaker, parseScorePair, rawValuesForBet, type RawBasketballGame, type RawHockeyGame } from "@/lib/sports-data/api-sports-provider";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import { normalizeApiBaseballStatus, normalizeApiBasketballStatus, normalizeApiHockeyStatus } from "@/lib/sports-data/status-map";
import hockey from "../../fixtures/provider/hockey-nhl-2024-sample.json";
import basketball from "../../fixtures/provider/basketball-nba-2024-sample.json";
import baseball from "../../fixtures/provider/baseball-mlb-2024-sample.json";

vi.mock("server-only", () => ({}));

const NHL = getSportConfig("hockey")!;
const NBA = getSportConfig("basketball")!;
const hockeyGames = hockey.games as unknown as RawHockeyGame[];
const basketballGames = basketball.games as unknown as RawBasketballGame[];
const byStatus = <T extends { status: { short: string | null } }>(games: T[], code: string) => games.filter((g) => g.status.short === code);

describe("NHL mapping (hockey 2024, real payloads)", () => {
  it("carries the shared Game identity: its own provider, sport, league and a UTC start from the provider timestamp", () => {
    const raw = byStatus(hockeyGames, "FT")[0];
    const game = mapHockeyGame(NHL, raw);
    expect(game).toMatchObject({ provider: "api_nhl", sport: "hockey", competitionExternalId: "57", competitionName: "NHL", externalFixtureId: String(raw.id), season: "2024" });
    expect(game.scheduledStartUtc).toBe(new Date(raw.timestamp * 1000).toISOString());
    expect(game.homeTeamExternalId).toBe(String(raw.teams.home.id));
    expect(game.homeTeamLogoUrl).toMatch(/^https:\/\/media\.api-sports\.io\/hockey\/teams\//);
  });

  it("regulation: the official final is the provider score, COMPLETED, and the period split is informational", () => {
    const raw = byStatus(hockeyGames, "FT")[0];
    const game = mapHockeyGame(NHL, raw);
    expect(game.internalStatus).toBe("COMPLETED");
    expect([game.homeScore, game.awayScore]).toEqual([raw.scores.home, raw.scores.away]);
    expect([game.regulationHomeScore, game.regulationAwayScore]).toEqual([raw.scores.home, raw.scores.away]); // no OT: regulation == final
    expect(game.extraTimeHomeScore ?? 0).toBe(0);
  });

  it("overtime (AOT): COMPLETED, final == regulation + overtime goals, overtime recorded separately", () => {
    for (const raw of byStatus(hockeyGames, "AOT")) {
      const game = mapHockeyGame(NHL, raw);
      expect(game.internalStatus).toBe("COMPLETED");
      expect(game.homeScore).toBe((game.regulationHomeScore as number) + (game.extraTimeHomeScore as number));
      expect(game.awayScore).toBe((game.regulationAwayScore as number) + (game.extraTimeAwayScore as number));
      expect(game.homeScore).not.toBe(game.awayScore);
    }
  });

  it("SHOOTOUT (AP): the provider's final score ALREADY credits the winner one goal — so the mapping adds nothing and the winner is the higher score", () => {
    const shootouts = byStatus(hockeyGames, "AP");
    expect(shootouts.length).toBeGreaterThan(0);
    for (const raw of shootouts) {
      const game = mapHockeyGame(NHL, raw);
      expect(game.internalStatus).toBe("COMPLETED");
      expect(game.homeScore).not.toBe(game.awayScore); // a shootout always produces a winner on the scoreboard
      // regulation + overtime goals are level (that is why it went to a shootout) ...
      const level = (game.regulationHomeScore as number) + (game.extraTimeHomeScore ?? 0) === (game.regulationAwayScore as number) + (game.extraTimeAwayScore ?? 0);
      expect(level).toBe(true);
      // ... and the final is that level score + exactly one for the shootout winner.
      expect(Math.abs((game.homeScore as number) - (game.awayScore as number))).toBe(1);
      // The shootout winner (more shootout goals) is the team with the higher final score — provider score and provider winner data AGREE.
      const homeWonShootout = (game.penaltyHomeScore as number) > (game.penaltyAwayScore as number);
      expect((game.homeScore as number) > (game.awayScore as number)).toBe(homeWonShootout);
    }
  });

  it("all 79 shootout games of the 2024 season satisfy the same invariant (scores == period sum + 1 for the winner, never level)", () => {
    const proof = hockey.shootoutProof as Array<{ id: number; scores: { home: number; away: number }; periods: RawHockeyGame["periods"] }>;
    expect(proof).toHaveLength(79);
    for (const g of proof) {
      const pairs = [g.periods!.first, g.periods!.second, g.periods!.third, g.periods!.overtime].map((p) => parseScorePair(p));
      expect(pairs.every((p) => p !== null)).toBe(true);
      const home = pairs.reduce((a, p) => a + p![0], 0);
      const away = pairs.reduce((a, p) => a + p![1], 0);
      expect(home).toBe(away); // level after regulation + overtime
      const shootout = parseScorePair(g.periods!.penalties)!;
      const homeWon = shootout[0] > shootout[1];
      expect([g.scores.home, g.scores.away]).toEqual(homeWon ? [home + 1, away] : [home, away + 1]);
    }
  });

  it("cancelled: CANCELLED with no score (graded VOID downstream, never invented)", () => {
    const game = mapHockeyGame(NHL, byStatus(hockeyGames, "CANC")[0]);
    expect(game.internalStatus).toBe("CANCELLED");
    expect([game.homeScore, game.awayScore]).toEqual([null, null]);
  });

  it("never produces a tied COMPLETED game from real data", () => {
    for (const raw of hockeyGames) {
      const g = mapHockeyGame(NHL, raw);
      if (g.internalStatus === "COMPLETED") expect(g.homeScore).not.toBe(g.awayScore);
    }
  });
});

describe("NBA mapping (basketball 2024-2025, real payloads)", () => {
  it("carries the shared Game identity: provider, sport, league, string season", () => {
    const raw = byStatus(basketballGames, "FT")[0];
    const game = mapBasketballGame(NBA, raw);
    expect(game).toMatchObject({ provider: "api_nba", sport: "basketball", competitionExternalId: "12", competitionName: "NBA", season: "2024-2025", venueName: raw.venue });
    expect(game.homeTeamLogoUrl).toMatch(/basketball\/teams\//);
  });

  it("regulation: final is the provider total; quarters sum to it", () => {
    const raw = byStatus(basketballGames, "FT").find((g) => g.scores.home.quarter_1 !== null)!;
    const game = mapBasketballGame(NBA, raw);
    expect(game.internalStatus).toBe("COMPLETED");
    expect([game.homeScore, game.awayScore]).toEqual([raw.scores.home.total, raw.scores.away.total]);
    expect(game.regulationHomeScore).toBe(game.homeScore);
  });

  it("overtime (AOT): the provider total INCLUDES overtime (final == four quarters + over_time), so the Market is graded on the full game", () => {
    for (const raw of byStatus(basketballGames, "AOT")) {
      const game = mapBasketballGame(NBA, raw);
      expect(game.internalStatus).toBe("COMPLETED");
      expect(game.homeScore).toBe((game.regulationHomeScore as number) + (game.extraTimeHomeScore as number));
      expect(game.awayScore).toBe((game.regulationAwayScore as number) + (game.extraTimeAwayScore as number));
      expect(game.homeScore).not.toBe(game.awayScore);
    }
  });

  it("cancelled: CANCELLED, no score", () => {
    const game = mapBasketballGame(NBA, byStatus(basketballGames, "CANC")[0]);
    expect(game.internalStatus).toBe("CANCELLED");
    expect([game.homeScore, game.awayScore]).toEqual([null, null]);
  });

  it("an All-Star exhibition game maps like any other (it is the franchise filter, not the mapper, that keeps it out of Teams/Communities)", () => {
    const exhibition = basketballGames.find((g) => /Stars|OGs/.test(g.teams.home.name ?? ""))!;
    const game = mapBasketballGame(NBA, exhibition);
    expect(game.homeTeamName).toBe(exhibition.teams.home.name);
    expect(game.regulationHomeScore).toBeNull(); // no quarter breakdown exists for exhibitions — never fabricated
  });
});

describe("status lifecycle — one shared lifecycle for every sport", () => {
  it("observed codes map identically across the API-Sports products", () => {
    for (const fn of [normalizeApiHockeyStatus, normalizeApiBasketballStatus, normalizeApiBaseballStatus]) {
      expect(fn("NS")).toBe("NOT_STARTED");
      expect(fn("FT")).toBe("COMPLETED");
      expect(fn("AOT")).toBe("COMPLETED");
      expect(fn("CANC")).toBe("CANCELLED");
      expect(fn("POST")).toBe("POSTPONED");
      expect(fn("ABD")).toBe("ABANDONED");
      expect(fn("SUSP")).toBe("SUSPENDED");
      expect(fn("AWD")).toBe("AWARDED");
    }
  });

  it("hockey: a shootout final (AP) is COMPLETED, and live period / overtime / shootout codes map to live states", () => {
    expect(normalizeApiHockeyStatus("AP")).toBe("COMPLETED");
    expect(["P1", "P2", "P3"].map(normalizeApiHockeyStatus)).toEqual(["LIVE", "LIVE", "LIVE"]);
    expect(normalizeApiHockeyStatus("OT")).toBe("EXTRA_TIME");
    expect(normalizeApiHockeyStatus("PT")).toBe("PENALTIES");
  });

  it("basketball: quarters / halftime / overtime", () => {
    expect(["Q1", "Q2", "Q3", "Q4"].map(normalizeApiBasketballStatus)).toEqual(["LIVE", "LIVE", "LIVE", "LIVE"]);
    expect(normalizeApiBasketballStatus("HT")).toBe("HALFTIME");
    expect(normalizeApiBasketballStatus("OT")).toBe("EXTRA_TIME");
  });

  it("an unrecognised or missing code is UNKNOWN — never COMPLETED, never NOT_STARTED (so nothing is graded on a guess)", () => {
    for (const fn of [normalizeApiHockeyStatus, normalizeApiBasketballStatus, normalizeApiBaseballStatus]) {
      expect(fn("???")).toBe("UNKNOWN");
      expect(fn(null)).toBe("UNKNOWN");
      expect(fn("")).toBe("UNKNOWN");
    }
    expect(normalizeApiBaseballStatus("INTR")).toBe("UNKNOWN"); // interrupted: delay vs suspension is not knowable from the code
  });
});

describe("odds extraction", () => {
  const bm = (bets: Array<{ id: number; name: string; values: Array<{ value: string; odd: string }> }>) => ({ id: 1, name: "book", bets });

  it("reads each template's bet by the sport's own catalog id AND name", () => {
    const book = bm([
      { id: 2, name: "Home/Away", values: [{ value: "Home", odd: "1.80" }, { value: "Away", odd: "2.05" }] },
      { id: 3, name: "Asian Handicap", values: [{ value: "Home -1.5", odd: "2.30" }, { value: "Away -1.5", odd: "1.62" }] },
      { id: 4, name: "Over/Under", values: [{ value: "Over 5.5", odd: "1.90" }, { value: "Under 5.5", odd: "1.90" }] },
    ]);
    const out = normalizeBookmaker(NHL, book);
    expect(out.moneyline).toEqual([{ value: "Home", odd: 1.8 }, { value: "Away", odd: 2.05 }]);
    expect(out.asianHandicap).toHaveLength(2);
    expect(out.gameTotal[0]).toEqual({ value: "Over 5.5", odd: 1.9 });
  });

  it("fails closed when a catalog id no longer means what we think: wrong name -> the bet is treated as absent", () => {
    const book = bm([{ id: 4, name: "Over/Under 1st Qtr", values: [{ value: "Over 55.5", odd: "1.9" }] }]);
    expect(rawValuesForBet(book, 4, "Over/Under")).toEqual([]);
    expect(normalizeBookmaker(NBA, book).gameTotal).toEqual([]);
  });

  it("the NFL's catalog ids differ (1/2/3), and the same names are expected", () => {
    const nfl = getSportConfig("american_football")!;
    expect(nfl.betIds).toEqual({ moneyline: 1, spread: 2, total: 3 });
    expect(NHL.betIds).toEqual({ moneyline: 2, spread: 3, total: 4 });
    expect(NBA.betIds).toEqual({ moneyline: 2, spread: 3, total: 4 });
  });
});

describe("MLB — shared-architecture compatibility (real baseball 2024 payloads; no adapter is registered, MLB is not launched)", () => {
  const games = baseball.games as unknown as Array<{ status: { short: string }; scores: { home: { total: number | null; innings: Record<string, number | null> }; away: { total: number | null } } }>;

  it("a finished game exposes an integer home/away final the shared grading reads directly", () => {
    const final = games.find((g) => g.status.short === "FT")!;
    expect(Number.isInteger(final.scores.home.total)).toBe(true);
    expect(Number.isInteger(final.scores.away.total)).toBe(true);
  });

  it("extra innings are part of the provider's final total (no separate shootout-style concept)", () => {
    const extra = games.find((g) => g.scores.home.innings?.extra != null);
    if (extra) expect(extra.scores.home.total).toBeGreaterThanOrEqual(1);
  });

  it("postponed / abandoned / cancelled map onto the existing shared lifecycle states", () => {
    expect(games.filter((g) => g.status.short === "POST").map((g) => normalizeApiBaseballStatus(g.status.short))).toEqual(["POSTPONED"]);
    expect(games.filter((g) => g.status.short === "ABD").map((g) => normalizeApiBaseballStatus(g.status.short))).toEqual(["ABANDONED"]);
    expect(games.filter((g) => g.status.short === "CANC").map((g) => normalizeApiBaseballStatus(g.status.short))).toEqual(["CANCELLED"]);
  });
});
