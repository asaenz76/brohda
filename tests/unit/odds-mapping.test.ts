import { describe, expect, it } from "vitest";
import { estimateFromMarkets, ODDS_ALLOWLIST_TEMPLATE_IDS } from "@/lib/pools/templates/odds-mapping";
import type { NormalizedFixtureMarkets, OddsMarket, OddsMarketLine, OddsProposition } from "@/lib/sports-data/types";

// Reputable ids (see odds-consensus.ts): 1, 2, 3, 4, 7, 8, 10, 11, 16, 24, 32, 36.
function props(...pairs: Array<[number, number, number]>): OddsProposition[] {
  return pairs.map(([bookmakerId, yesOdd, noOdd]) => ({ bookmakerId, bookmakerName: `book-${bookmakerId}`, yesOdd, noOdd }));
}

function singlePropMarket(key: OddsMarket["key"], pairs: Array<[number, number, number]>): OddsMarket {
  return { key, lines: [{ point: 0, propositions: props(...pairs) }] };
}

function thresholdMarket(key: OddsMarket["key"], lines: Array<{ point: number; pairs: Array<[number, number, number]> }>): OddsMarket {
  return { key, lines: lines.map((l): OddsMarketLine => ({ point: l.point, propositions: props(...l.pairs) })) };
}

function emptyMarkets(overrides: Partial<NormalizedFixtureMarkets> = {}): NormalizedFixtureMarkets {
  return {
    externalFixtureId: "test-fixture",
    providerUpdatedAt: "2026-08-03T00:15:08Z",
    matchWinner: [],
    markets: [],
    ...overrides,
  };
}

describe("ODDS_ALLOWLIST_TEMPLATE_IDS", () => {
  it("excludes the templates flagged as not-clean-enough for real odds", () => {
    for (const excluded of ["PLAYER_TO_SCORE", "RED_CARD", "GOAL_AFTER_MINUTE", "FIRST_TEAM_TO_SCORE", "PENALTY_AWARDED", "WINNING_MARGIN"]) {
      expect(ODDS_ALLOWLIST_TEMPLATE_IDS.has(excluded)).toBe(false);
    }
  });

  it("includes the 11 confirmed-clean templates", () => {
    expect(ODDS_ALLOWLIST_TEMPLATE_IDS.size).toBe(11);
  });
});

describe("estimateFromMarkets — allowlist gate", () => {
  it("returns null for a non-allowlisted template even with matching market data present", () => {
    const markets = emptyMarkets({ markets: [singlePropMarket("BOTH_TEAMS_SCORE", [[1, 2.1, 1.65], [4, 2.05, 1.7], [8, 2.15, 1.6]])] });
    expect(estimateFromMarkets("RED_CARD", {}, markets)).toBeNull();
  });

  it("returns null when the relevant market wasn't fetched at all", () => {
    expect(estimateFromMarkets("BOTH_TEAMS_TO_SCORE", {}, emptyMarkets())).toBeNull();
  });
});

describe("estimateFromMarkets — single-proposition markets", () => {
  it("estimates BOTH_TEAMS_TO_SCORE from consensus, no line/resolvedConfig", () => {
    const markets = emptyMarkets({ markets: [singlePropMarket("BOTH_TEAMS_SCORE", [[1, 2.1, 1.65], [4, 2.05, 1.7], [8, 2.15, 1.6]])] });
    const estimate = estimateFromMarkets("BOTH_TEAMS_TO_SCORE", {}, markets)!;
    expect(estimate.source).toBe("MARKET_CONSENSUS");
    expect(estimate.line).toBeNull();
    expect(estimate.resolvedConfig).toBeNull();
    expect(estimate.probability).toBeGreaterThan(0);
    expect(estimate.probability).toBeLessThan(1);
  });

  it("picks CLEAN_SHEET_AWAY market when config.team is AWAY, CLEAN_SHEET_HOME otherwise", () => {
    const markets = emptyMarkets({
      markets: [
        singlePropMarket("CLEAN_SHEET_HOME", [[1, 3.0, 1.4], [4, 3.1, 1.35], [8, 2.9, 1.45]]),
        singlePropMarket("CLEAN_SHEET_AWAY", [[1, 4.0, 1.2], [4, 4.1, 1.18], [8, 3.9, 1.22]]),
      ],
    });
    const home = estimateFromMarkets("CLEAN_SHEET", { team: "HOME" }, markets)!;
    const away = estimateFromMarkets("CLEAN_SHEET", { team: "AWAY" }, markets)!;
    expect(home.marketKey).toBe("CLEAN_SHEET_HOME");
    expect(away.marketKey).toBe("CLEAN_SHEET_AWAY");
    expect(home.probability).not.toBeCloseTo(away.probability, 3);
  });
});

describe("estimateFromMarkets — threshold markets (the sportsbook chooses the line)", () => {
  it("picks whichever line's consensus is closest to 50%, not the first/lowest line", () => {
    const markets = emptyMarkets({
      markets: [
        thresholdMarket("MATCH_TOTAL_GOALS", [
          // 1.5: heavily lopsided (~85% over)
          { point: 1.5, pairs: [[1, 1.15, 5.5], [4, 1.18, 5.2], [8, 1.12, 5.8]] },
          // 2.5: close to a coin flip — should win
          { point: 2.5, pairs: [[1, 1.95, 1.9], [4, 2.0, 1.85], [8, 1.9, 1.95]] },
          // 3.5: heavily lopsided the other way (~15% over)
          { point: 3.5, pairs: [[1, 5.5, 1.15], [4, 5.2, 1.18], [8, 5.8, 1.12]] },
        ]),
      ],
    });
    const estimate = estimateFromMarkets("MATCH_TOTAL_GOALS", { minimumGoals: 1 }, markets)!;
    expect(estimate.line).toBe(2.5);
    expect(Math.abs(estimate.probability - 0.5)).toBeLessThan(0.05);
  });

  it("converts the chosen half-point line into an integer 'X or more' resolvedConfig via ceil", () => {
    const markets = emptyMarkets({
      markets: [thresholdMarket("FIRST_HALF_TOTAL_GOALS", [{ point: 0.5, pairs: [[1, 1.55, 2.3], [4, 1.5, 2.4], [8, 1.6, 2.2]] }])],
    });
    const estimate = estimateFromMarkets("FIRST_HALF_TOTAL_GOALS", { minimumGoals: 1 }, markets)!;
    expect(estimate.resolvedConfig).toEqual({ minimumGoals: 1 }); // ceil(0.5) = 1
  });

  it("skips lines with no valid consensus (e.g. only non-reputable books) when picking the best", () => {
    const markets = emptyMarkets({
      markets: [
        thresholdMarket("MATCH_TOTAL_GOALS", [
          { point: 2.5, pairs: [[99, 2.0, 1.85]] }, // non-reputable only — no consensus
          { point: 3.5, pairs: [[1, 2.0, 1.85], [4, 2.05, 1.8], [8, 1.95, 1.9]] },
        ]),
      ],
    });
    const estimate = estimateFromMarkets("MATCH_TOTAL_GOALS", { minimumGoals: 1 }, markets)!;
    expect(estimate.line).toBe(3.5);
  });

  it("uses TEAM_TOTAL_GOALS_AWAY vs _HOME depending on config.team", () => {
    const markets = emptyMarkets({
      markets: [
        thresholdMarket("TEAM_TOTAL_GOALS_HOME", [{ point: 1.5, pairs: [[1, 2.0, 1.85], [4, 2.05, 1.8], [8, 1.95, 1.9]] }]),
        thresholdMarket("TEAM_TOTAL_GOALS_AWAY", [{ point: 0.5, pairs: [[1, 1.4, 3.0], [4, 1.45, 2.9], [8, 1.35, 3.1]] }]),
      ],
    });
    const away = estimateFromMarkets("TEAM_TOTAL_GOALS", { team: "AWAY", minimumGoals: 1 }, markets)!;
    expect(away.marketKey).toBe("TEAM_TOTAL_GOALS_AWAY");
    expect(away.resolvedConfig).toEqual({ minimumGoals: 1 });
  });
});

describe("estimateFromMarkets — match-winner-derived templates", () => {
  const matchWinner = [
    { bookmakerId: 1, bookmakerName: "10Bet", homeOdd: 3.2, drawOdd: 2.86, awayOdd: 2.46 },
    { bookmakerId: 4, bookmakerName: "Pinnacle", homeOdd: 3.1, drawOdd: 2.9, awayOdd: 2.5 },
    { bookmakerId: 8, bookmakerName: "Bet365", homeOdd: 3.3, drawOdd: 2.8, awayOdd: 2.4 },
  ];

  it("HOME_TEAM_TO_WIN and AWAY_TEAM_TO_WIN come from the same 3-way consensus and are complementary-ish", () => {
    const markets = emptyMarkets({ matchWinner });
    const home = estimateFromMarkets("HOME_TEAM_TO_WIN", {}, markets)!;
    const away = estimateFromMarkets("AWAY_TEAM_TO_WIN", {}, markets)!;
    expect(home.marketKey).toBe("MATCH_WINNER_3WAY");
    expect(away.probability).toBeGreaterThan(home.probability); // away was the raw favorite
  });

  it("EITHER_TEAM_TO_WIN is 1 - P(draw)", () => {
    const markets = emptyMarkets({ matchWinner });
    const home = estimateFromMarkets("HOME_TEAM_TO_WIN", {}, markets)!;
    const away = estimateFromMarkets("AWAY_TEAM_TO_WIN", {}, markets)!;
    const either = estimateFromMarkets("EITHER_TEAM_TO_WIN", {}, markets)!;
    expect(either.probability).toBeCloseTo(home.probability + away.probability, 6);
  });

  it("TEAM_TO_AVOID_DEFEAT flips between 1-P(away) and 1-P(home) by config.team", () => {
    const markets = emptyMarkets({ matchWinner });
    const homeAvoid = estimateFromMarkets("TEAM_TO_AVOID_DEFEAT", { team: "HOME" }, markets)!;
    const awayAvoid = estimateFromMarkets("TEAM_TO_AVOID_DEFEAT", { team: "AWAY" }, markets)!;
    const home = estimateFromMarkets("HOME_TEAM_TO_WIN", {}, markets)!;
    const away = estimateFromMarkets("AWAY_TEAM_TO_WIN", {}, markets)!;
    expect(homeAvoid.probability).toBeCloseTo(1 - away.probability, 6);
    expect(awayAvoid.probability).toBeCloseTo(1 - home.probability, 6);
  });

  it("returns null with no match-winner data", () => {
    expect(estimateFromMarkets("HOME_TEAM_TO_WIN", {}, emptyMarkets())).toBeNull();
  });
});
