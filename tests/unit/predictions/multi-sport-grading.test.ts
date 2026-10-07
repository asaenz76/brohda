/**
 * ONE grading function for every sport: MONEYLINE / SPREAD / TOTAL graded from a Game's official final score. This matrix runs the NFL, NBA and
 * NHL through it — the NBA/NHL fixtures are built from REAL recorded provider games (regulation, overtime, shootout) passed through the real
 * provider mapping, so the semantics under test are the provider's, not a hand-written guess. (The full job pipeline, Call BS and money are
 * proven in tests/integration/multi-sport-pipeline.test.ts.)
 */
import { describe, expect, it, vi } from "vitest";
import { computeSportsMarketOutcome, inconsistentFinalReason, type SportsMarketDefinition } from "@/lib/predictions/sports-resolution";
import { decideGradingForMarket } from "@/lib/predictions/grading";
import type { FixtureForGrading } from "@/lib/sports-data/fixture-lookup";
import { mapBasketballGame, mapHockeyGame, type RawBasketballGame, type RawHockeyGame } from "@/lib/sports-data/api-sports-provider";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import hockey from "../../fixtures/provider/hockey-nhl-2024-sample.json";
import basketball from "../../fixtures/provider/basketball-nba-2024-sample.json";

vi.mock("server-only", () => ({}));

const ML_HOME: SportsMarketDefinition = { marketTemplate: "MONEYLINE", lineValue: null, yesSide: "HOME" };
const ML_AWAY: SportsMarketDefinition = { marketTemplate: "MONEYLINE", lineValue: null, yesSide: "AWAY" };
const spread = (line: number, yesSide: "HOME" | "AWAY" = "HOME"): SportsMarketDefinition => ({ marketTemplate: "SPREAD", lineValue: line, yesSide });
const total = (line: number): SportsMarketDefinition => ({ marketTemplate: "TOTAL", lineValue: line, yesSide: null });

function fixtureFrom(sport: string, internalStatus: string, homeScore: number | null, awayScore: number | null, id = "g"): FixtureForGrading {
  return { id, sport, internalStatus, homeScore, awayScore };
}
const nhlConfig = getSportConfig("hockey")!;
const nbaConfig = getSportConfig("basketball")!;
const realHockey = (code: string, n = 0) => {
  const raw = (hockey.games as unknown as RawHockeyGame[]).filter((g) => g.status.short === code)[n];
  const m = mapHockeyGame(nhlConfig, raw);
  return fixtureFrom("hockey", m.internalStatus, m.homeScore, m.awayScore, String(raw.id));
};
const realBasketball = (code: string, n = 0) => {
  const raw = (basketball.games as unknown as RawBasketballGame[]).filter((g) => g.status.short === code && g.scores.home.quarter_1 !== null)[n] ?? (basketball.games as unknown as RawBasketballGame[]).filter((g) => g.status.short === code)[n];
  const m = mapBasketballGame(nbaConfig, raw);
  return fixtureFrom("basketball", m.internalStatus, m.homeScore, m.awayScore, String(raw.id));
};

describe("NHL — graded on the official final score, through the same function as the NFL", () => {
  it("regulation: the team with the higher final wins the Moneyline (YES = home)", () => {
    const home = realHockey("FT", 0); // real game, home won
    expect(home.homeScore).toBeGreaterThan(home.awayScore as number);
    expect(computeSportsMarketOutcome(ML_HOME, home)).toBe("YES");
    expect(computeSportsMarketOutcome(ML_AWAY, home)).toBe("NO");
    const away = realHockey("FT", 1); // real game, away won
    expect(away.awayScore).toBeGreaterThan(away.homeScore as number);
    expect(computeSportsMarketOutcome(ML_HOME, away)).toBe("NO");
    expect(computeSportsMarketOutcome(ML_AWAY, away)).toBe("YES");
  });

  it("OVERTIME win counts as a win (never the NFL's tie rule, never regulation-only)", () => {
    for (let i = 0; i < 2; i++) {
      const game = realHockey("AOT", i);
      const homeWon = (game.homeScore as number) > (game.awayScore as number);
      expect(computeSportsMarketOutcome(ML_HOME, game)).toBe(homeWon ? "YES" : "NO");
      expect(computeSportsMarketOutcome(ML_AWAY, game)).toBe(homeWon ? "NO" : "YES");
    }
  });

  it("SHOOTOUT win counts as a win: the provider's final already credits the winner, so the official winner wins the Moneyline", () => {
    for (let i = 0; i < 3; i++) {
      const game = realHockey("AP", i);
      expect(game.homeScore).not.toBe(game.awayScore);
      const homeWon = (game.homeScore as number) > (game.awayScore as number);
      expect(computeSportsMarketOutcome(ML_HOME, game)).toBe(homeWon ? "YES" : "NO");
    }
  });

  it("puck line (SPREAD): favourite -1.5 / underdog +1.5 against real margins — win by 1 does not cover -1.5, win by 2 does, an outright underdog win covers +1.5", () => {
    const winBy1 = fixtureFrom("hockey", "COMPLETED", 3, 2);
    const winBy2 = fixtureFrom("hockey", "COMPLETED", 4, 2);
    const underdogWins = fixtureFrom("hockey", "COMPLETED", 1, 3);
    expect(computeSportsMarketOutcome(spread(-1.5), winBy1)).toBe("NO");
    expect(computeSportsMarketOutcome(spread(-1.5), winBy2)).toBe("YES");
    expect(computeSportsMarketOutcome(spread(-1.5), underdogWins)).toBe("NO");
    // the same Game seen from the underdog (home +1.5 is the same line seen from the other side)
    expect(computeSportsMarketOutcome(spread(1.5), winBy1)).toBe("YES"); // lost by... no: home won by 1, +1.5 covers
    expect(computeSportsMarketOutcome(spread(1.5), fixtureFrom("hockey", "COMPLETED", 1, 3))).toBe("NO"); // lost by 2: +1.5 does not cover
    expect(computeSportsMarketOutcome(spread(1.5), fixtureFrom("hockey", "COMPLETED", 2, 3))).toBe("YES"); // lost by 1: +1.5 covers
    // a shootout game is decided by exactly one credited goal: the favourite -1.5 never covers after a shootout.
    const shootout = realHockey("AP", 0);
    expect(computeSportsMarketOutcome(spread(-1.5, (shootout.homeScore as number) > (shootout.awayScore as number) ? "HOME" : "AWAY"), shootout)).toBe("NO");
  });

  it("the line is read from the Market, never assumed: a whole-number line can push (VOID), and the opposite side is NEVER awarded on a push", () => {
    const margin2 = fixtureFrom("hockey", "COMPLETED", 5, 3);
    expect(computeSportsMarketOutcome(spread(-2), margin2)).toBe("VOID");
    expect(computeSportsMarketOutcome(spread(-2, "AWAY"), fixtureFrom("hockey", "COMPLETED", 3, 5))).toBe("VOID"); // away -2 vs a 2-goal away win
    expect(computeSportsMarketOutcome(spread(-2), fixtureFrom("hockey", "COMPLETED", 6, 3))).toBe("YES");
    expect(computeSportsMarketOutcome(spread(-2), fixtureFrom("hockey", "COMPLETED", 4, 3))).toBe("NO");
  });

  it("totals: Over / Under / integer push, on the official final including overtime", () => {
    const six = fixtureFrom("hockey", "COMPLETED", 4, 2);
    expect(computeSportsMarketOutcome(total(5.5), six)).toBe("YES");
    expect(computeSportsMarketOutcome(total(6.5), six)).toBe("NO");
    expect(computeSportsMarketOutcome(total(6), six)).toBe("VOID");
    const ot = realHockey("AOT", 0); // overtime goal is part of the total
    const sum = (ot.homeScore as number) + (ot.awayScore as number);
    expect(computeSportsMarketOutcome(total(sum - 0.5), ot)).toBe("YES");
    expect(computeSportsMarketOutcome(total(sum + 0.5), ot)).toBe("NO");
    expect(computeSportsMarketOutcome(total(sum), ot)).toBe("VOID");
  });

  it("SHOOTOUT total: graded on the official final, which includes the one credited shootout goal (sum = regulation+OT goals + 1) — flagged owner decision, pinned here", () => {
    const so = realHockey("AP", 0);
    const sum = (so.homeScore as number) + (so.awayScore as number);
    expect(sum % 2).toBe(1); // level + 1 is always odd
    expect(computeSportsMarketOutcome(total(sum - 0.5), so)).toBe("YES");
    expect(computeSportsMarketOutcome(total(sum + 0.5), so)).toBe("NO");
  });

  it("cancelled -> VOID for every template; postponed -> PENDING (and then graded from the later final, on the SAME Game identity)", () => {
    const cancelled = fixtureFrom("hockey", "CANCELLED", null, null);
    for (const def of [ML_HOME, spread(-1.5), total(5.5)]) expect(computeSportsMarketOutcome(def, cancelled)).toBe("VOID");
    const postponed = fixtureFrom("hockey", "POSTPONED", null, null, "same-game");
    for (const def of [ML_HOME, spread(-1.5), total(5.5)]) expect(computeSportsMarketOutcome(def, postponed)).toBe("PENDING");
    const later = { ...postponed, internalStatus: "COMPLETED", homeScore: 3, awayScore: 2 };
    expect(computeSportsMarketOutcome(ML_HOME, later)).toBe("YES");
  });

  it("no manufactured settlement: live, partial score, suspended, abandoned, awarded and unknown all stay PENDING", () => {
    for (const status of ["LIVE", "EXTRA_TIME", "PENALTIES", "HALFTIME", "SUSPENDED", "ABANDONED", "AWARDED", "UNKNOWN", "NOT_STARTED"]) {
      expect(computeSportsMarketOutcome(ML_HOME, fixtureFrom("hockey", status, 2, 1)), status).toBe("PENDING");
    }
    expect(computeSportsMarketOutcome(ML_HOME, fixtureFrom("hockey", "COMPLETED", null, null))).toBe("PENDING");
  });
});

describe("NBA — same function, overtime included in the official final", () => {
  it("regulation + overtime Moneyline from real games", () => {
    const reg = realBasketball("FT", 0);
    const regHomeWon = (reg.homeScore as number) > (reg.awayScore as number);
    expect(computeSportsMarketOutcome(ML_HOME, reg)).toBe(regHomeWon ? "YES" : "NO");
    for (let i = 0; i < 2; i++) {
      const ot = realBasketball("AOT", i);
      const homeWon = (ot.homeScore as number) > (ot.awayScore as number);
      expect(computeSportsMarketOutcome(ML_HOME, ot)).toBe(homeWon ? "YES" : "NO");
    }
  });

  it("spread: favourite covers, favourite wins but does not cover, underdog covers, underdog wins outright, exact push -> VOID", () => {
    const wins7 = fixtureFrom("basketball", "COMPLETED", 112, 105);
    expect(computeSportsMarketOutcome(spread(-4.5), wins7)).toBe("YES"); // favourite covers
    expect(computeSportsMarketOutcome(spread(-8.5), wins7)).toBe("NO"); // wins but does not cover
    expect(computeSportsMarketOutcome(spread(8.5), wins7)).toBe("YES"); // (home +8.5 is the same game from the underdog's side)
    expect(computeSportsMarketOutcome(spread(-7), wins7)).toBe("VOID"); // exact push
    const underdogWins = fixtureFrom("basketball", "COMPLETED", 98, 101);
    expect(computeSportsMarketOutcome(spread(4.5), underdogWins)).toBe("YES"); // underdog (home +4.5) covers
    expect(computeSportsMarketOutcome(spread(-4.5, "AWAY"), underdogWins)).toBe("NO"); // ... which means away -4.5 does not
    expect(computeSportsMarketOutcome(spread(4.5, "AWAY"), underdogWins)).toBe("YES");
  });

  it("overtime changes the result: a game that is Under after regulation is Over once the real overtime points are counted", () => {
    const ot = realBasketball("AOT", 0);
    const final = (ot.homeScore as number) + (ot.awayScore as number);
    const regulationOnly = final - 5; // pretend a line set where regulation points alone fall short
    expect(computeSportsMarketOutcome(total(final - 0.5), ot)).toBe("YES");
    expect(regulationOnly).toBeLessThan(final);
    // two overtimes: the provider's single over_time field already combines them
    expect(computeSportsMarketOutcome(total(250.5), fixtureFrom("basketball", "COMPLETED", 131, 126))).toBe("YES");
  });

  it("total: Over / Under / exact integer push -> VOID", () => {
    const g = fixtureFrom("basketball", "COMPLETED", 112, 105); // 217
    expect(computeSportsMarketOutcome(total(216.5), g)).toBe("YES");
    expect(computeSportsMarketOutcome(total(217.5), g)).toBe("NO");
    expect(computeSportsMarketOutcome(total(217), g)).toBe("VOID");
  });

  it("cancelled -> VOID, postponed -> PENDING", () => {
    expect(computeSportsMarketOutcome(ML_HOME, fixtureFrom("basketball", "CANCELLED", null, null))).toBe("VOID");
    expect(computeSportsMarketOutcome(total(220.5), fixtureFrom("basketball", "POSTPONED", null, null))).toBe("PENDING");
  });
});

describe("sport policy: games that cannot end level", () => {
  it("NFL keeps its rule: a tied Moneyline is VOID", () => {
    expect(computeSportsMarketOutcome(ML_HOME, fixtureFrom("american_football", "COMPLETED", 20, 20))).toBe("VOID");
    expect(computeSportsMarketOutcome(ML_HOME, fixtureFrom("american_football", "COMPLETED", 20, 20))).toBe("VOID");
    expect(computeSportsMarketOutcome(ML_HOME, { id: "x", internalStatus: "COMPLETED", homeScore: 20, awayScore: 20 })).toBe("VOID"); // unknown sport: permissive, as before
  });

  it("NHL / NBA / MLB: a COMPLETED level score is an INCONSISTENT provider result — it is NOT graded VOID (the NFL rule must never apply), it stays PENDING and is reported", () => {
    for (const sport of ["hockey", "basketball", "baseball"]) {
      const level = fixtureFrom(sport, "COMPLETED", 3, 3, "game-1");
      for (const def of [ML_HOME, spread(-1.5), spread(0), total(6)]) expect(computeSportsMarketOutcome(def, level), `${sport} ${def.marketTemplate}`).toBe("PENDING");
      const reason = inconsistentFinalReason(level)!;
      expect(reason).toContain("cannot end level");
      expect(reason).toContain("game-1"); // Brohda game id in the report
    }
    expect(inconsistentFinalReason(fixtureFrom("hockey", "COMPLETED", 4, 3))).toBeNull();
    expect(inconsistentFinalReason(fixtureFrom("hockey", "LIVE", 3, 3))).toBeNull(); // a level LIVE score is normal
    expect(inconsistentFinalReason(fixtureFrom("american_football", "COMPLETED", 3, 3))).toBeNull();
  });

  it("the grading decision carries the anomaly so the job can report it, and still grades nothing", () => {
    const market = { status: "ACTIVE", marketTemplate: "MONEYLINE", lineValue: null, yesSide: "HOME" } as Parameters<typeof decideGradingForMarket>[0];
    const decision = decideGradingForMarket(market, { ...fixtureFrom("hockey", "COMPLETED", 2, 2), provider: "api_nhl", externalFixtureId: "999", competitionName: "NHL" }, "YES");
    expect(decision).toMatchObject({ decision: "still-pending" });
    expect((decision as { anomaly?: string }).anomaly).toMatch(/hockey final is level \(2-2\).*NHL.*api_nhl game 999/);
    expect(decideGradingForMarket(market, fixtureFrom("hockey", "COMPLETED", 3, 2), "YES")).toEqual({ decision: "graded", result: "CORRECT", resolvedOutcomeSnapshot: "YES" });
  });
});
