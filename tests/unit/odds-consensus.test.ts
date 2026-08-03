import { describe, expect, it } from "vitest";
import { buildConsensus, buildMatchWinnerConsensus } from "@/lib/pools/templates/odds-consensus";
import type { MatchWinnerLine, OddsProposition } from "@/lib/sports-data/types";

// Real reputable ids from the allowlist (see odds-consensus.ts): Pinnacle=4,
// Bet365=8, William Hill=7, 10Bet=1, Betfair=3, Unibet=16. 99 is
// deliberately not on the allowlist.
function prop(bookmakerId: number, yesOdd: number, noOdd: number): OddsProposition {
  return { bookmakerId, bookmakerName: `book-${bookmakerId}`, yesOdd, noOdd };
}

describe("buildConsensus", () => {
  it("uses the median fair probability across 3+ qualifying bookmakers", () => {
    const propositions = [prop(1, 2.0, 2.0), prop(4, 1.8, 2.3), prop(8, 2.2, 1.85)];
    const result = buildConsensus(propositions)!;
    expect(result.source).toBe("MARKET_CONSENSUS");
    expect(result.bookmakerCount).toBe(3);
    // Median, not mean — proven by picking odds where median != mean.
    const fairValues = propositions
      .map((p) => 1 / p.yesOdd / (1 / p.yesOdd + 1 / p.noOdd))
      .sort((a, b) => a - b);
    expect(result.probability).toBeCloseTo(fairValues[1], 9);
  });

  it("falls back to a single bookmaker when fewer than 3 qualify, preferring Pinnacle", () => {
    const propositions = [prop(1, 2.0, 2.0), prop(4, 1.9, 2.1)];
    const result = buildConsensus(propositions)!;
    expect(result.source).toBe("SINGLE_BOOKMAKER");
    expect(result.bookmakerCount).toBe(1);
    expect(result.bookmakerIds).toEqual([4]); // Pinnacle preferred over 10Bet
  });

  it("falls back to whichever single bookmaker is available when the preferred ones aren't", () => {
    const propositions = [prop(1, 2.0, 2.0)]; // only 10Bet, no Pinnacle
    const result = buildConsensus(propositions)!;
    expect(result.source).toBe("SINGLE_BOOKMAKER");
    expect(result.bookmakerIds).toEqual([1]);
  });

  it("ignores non-reputable bookmakers entirely", () => {
    const propositions = [prop(99, 2.0, 2.0), prop(98, 1.5, 3.0)];
    expect(buildConsensus(propositions)).toBeNull();
  });

  it("returns null with no propositions at all", () => {
    expect(buildConsensus([])).toBeNull();
  });

  it("a reputable bookmaker's unpayable odds don't count toward the qualifying total", () => {
    // Book 1's unpayable odd drops it, leaving only 2 qualifying books —
    // below the 3-book consensus threshold, so this falls back to a single
    // preferred bookmaker (Pinnacle=4) rather than a 3-book median.
    const propositions = [prop(1, 1.0, 2.0), prop(4, 1.9, 2.1), prop(8, 2.0, 2.0)];
    const result = buildConsensus(propositions)!;
    expect(result.source).toBe("SINGLE_BOOKMAKER");
    expect(result.bookmakerIds).toEqual([4]);
  });
});

describe("buildMatchWinnerConsensus", () => {
  function line(bookmakerId: number, homeOdd: number, drawOdd: number, awayOdd: number): MatchWinnerLine {
    return { bookmakerId, bookmakerName: `book-${bookmakerId}`, homeOdd, drawOdd, awayOdd };
  }

  it("medians each outcome independently and renormalizes to sum to 1", () => {
    const lines = [line(1, 3.2, 2.86, 2.46), line(4, 3.1, 2.9, 2.5), line(8, 3.3, 2.8, 2.4)];
    const result = buildMatchWinnerConsensus(lines)!;
    expect(result.source).toBe("MARKET_CONSENSUS");
    expect(result.home + result.draw + result.away).toBeCloseTo(1, 9);
    expect(result.away).toBeGreaterThan(result.home); // away was the raw favorite across all three
  });

  it("falls back to a single bookmaker (Pinnacle preferred) below the consensus threshold", () => {
    const lines = [line(1, 3.2, 2.86, 2.46), line(4, 3.1, 2.9, 2.5)];
    const result = buildMatchWinnerConsensus(lines)!;
    expect(result.source).toBe("SINGLE_BOOKMAKER");
    expect(result.bookmakerIds).toEqual([4]);
  });

  it("returns null with no qualifying bookmakers", () => {
    expect(buildMatchWinnerConsensus([line(99, 3.2, 2.86, 2.46)])).toBeNull();
  });
});
