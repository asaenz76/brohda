import { describe, expect, it } from "vitest";
import { suggestMinimumGoalsFromExactDistribution, suggestMinimumGoalsFromOdds } from "@/lib/pools/templates/goals-odds";
import type { OddsExactGoalsBucket, OddsGoalsLine } from "@/lib/sports-data/types";

describe("suggestMinimumGoalsFromOdds", () => {
  it("returns null for no lines", () => {
    expect(suggestMinimumGoalsFromOdds([])).toBeNull();
  });

  it("picks the line closest to a 50/50 split and rounds up", () => {
    const lines: OddsGoalsLine[] = [
      { point: 0.5, overOdd: 1.11, underOdd: 6.25 }, // heavily skewed
      { point: 1.5, overOdd: 1.5, underOdd: 2.55 }, // skewed
      { point: 2.5, overOdd: 1.95, underOdd: 1.9 }, // nearly even — the pick
      { point: 3.5, overOdd: 5.0, underOdd: 1.17 }, // heavily skewed
    ];

    expect(suggestMinimumGoalsFromOdds(lines)).toBe(3); // ceil(2.5)
  });

  it("rounds a half-point line up to the next integer", () => {
    expect(suggestMinimumGoalsFromOdds([{ point: 0.5, overOdd: 1.9, underOdd: 1.9 }])).toBe(1);
  });

  it("picks the first entry on an exact tie", () => {
    const lines: OddsGoalsLine[] = [
      { point: 1.5, overOdd: 1.9, underOdd: 1.9 },
      { point: 2.5, overOdd: 1.85, underOdd: 1.85 },
    ];
    expect(suggestMinimumGoalsFromOdds(lines)).toBe(2); // ceil(1.5), first entry wins the tie
  });
});

describe("suggestMinimumGoalsFromExactDistribution", () => {
  it("returns null for no distributions", () => {
    expect(suggestMinimumGoalsFromExactDistribution([])).toBeNull();
  });

  it("picks the threshold whose at-least probability is closest to 50%", () => {
    // Fair (no-vig) distribution: P(0)=.4, P(1)=.35, P(>=2)=.25.
    // P(>=1)=.6 (diff .1) is closer to 50% than P(>=2)=.25 (diff .25).
    const distribution: OddsExactGoalsBucket[] = [
      { count: 0, isTail: false, odd: 2.5 },
      { count: 1, isTail: false, odd: 1 / 0.35 },
      { count: 2, isTail: true, odd: 4 },
    ];
    expect(suggestMinimumGoalsFromExactDistribution([distribution])).toBe(1);
  });

  it("picks a higher threshold when the distribution skews that way", () => {
    // Fair distribution: P(0)=.2, P(1)=.2, P(2)=.3, P(>=3)=.3.
    // P(>=2)=.6 (diff .1) beats P(>=1)=.8 (diff .3) and P(>=3)=.3 (diff .2).
    const distribution: OddsExactGoalsBucket[] = [
      { count: 0, isTail: false, odd: 5 },
      { count: 1, isTail: false, odd: 5 },
      { count: 2, isTail: false, odd: 1 / 0.3 },
      { count: 3, isTail: true, odd: 1 / 0.3 },
    ];
    expect(suggestMinimumGoalsFromExactDistribution([distribution])).toBe(2);
  });

  it("removes the bookmaker's overround before comparing", () => {
    // Same shape as the first case, but every odd is shortened by ~10% —
    // a classic overround — the normalized result should be unchanged.
    const margin = 1.1;
    const distribution: OddsExactGoalsBucket[] = [
      { count: 0, isTail: false, odd: 2.5 / margin },
      { count: 1, isTail: false, odd: 1 / 0.35 / margin },
      { count: 2, isTail: true, odd: 4 / margin },
    ];
    expect(suggestMinimumGoalsFromExactDistribution([distribution])).toBe(1);
  });

  it("picks the best threshold across multiple bookmakers", () => {
    const skewedHigh: OddsExactGoalsBucket[] = [
      { count: 0, isTail: false, odd: 5 },
      { count: 1, isTail: false, odd: 5 },
      { count: 2, isTail: true, odd: 1.25 }, // P(>=2) = .8, far from 50%
    ];
    const nearEven: OddsExactGoalsBucket[] = [
      { count: 0, isTail: false, odd: 2 },
      { count: 1, isTail: true, odd: 2 }, // P(>=1) = .5 exactly
    ];
    expect(suggestMinimumGoalsFromExactDistribution([skewedHigh, nearEven])).toBe(1);
  });
});
