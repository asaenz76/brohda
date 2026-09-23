import { describe, expect, it } from "vitest";
import { aggregateMoneyline, aggregateTotal } from "@/lib/prediction-markets/ingestion/aggregate-nfl-odds";
import type { NflBookmakerOdds } from "@/lib/sports-data/types";

function bm(id: number, moneyline: Array<{ value: string; odd: number }>, gameTotal: Array<{ value: string; odd: number }> = []): NflBookmakerOdds {
  return { bookmakerId: id, bookmakerName: `book-${id}`, moneyline, asianHandicap: [], gameTotal, homeTeamTotal: [], awayTeamTotal: [] };
}

describe("aggregateMoneyline", () => {
  it("returns HOME's fair (de-vigged) win probability, anchored to HOME regardless of who's favored", () => {
    const bookmakers = [
      bm(1, [{ value: "Home", odd: 1.5 }, { value: "Away", odd: 2.7 }]),
      bm(2, [{ value: "Home", odd: 1.55 }, { value: "Away", odd: 2.6 }]),
    ];
    const result = aggregateMoneyline(bookmakers, 2);
    expect(result).not.toBeNull();
    expect(result!.homeProbability).toBeGreaterThan(0.5);
    expect(result!.homeProbability).toBeLessThan(1);
    expect(result!.bookmakerCount).toBe(2);
  });

  it("is symmetric — an AWAY-favored game produces a HOME probability below 0.5", () => {
    const bookmakers = [
      bm(1, [{ value: "Home", odd: 3.0 }, { value: "Away", odd: 1.4 }]),
      bm(2, [{ value: "Home", odd: 3.1 }, { value: "Away", odd: 1.38 }]),
    ];
    const result = aggregateMoneyline(bookmakers, 2);
    expect(result!.homeProbability).toBeLessThan(0.5);
  });

  it("returns null below the minimum bookmaker count", () => {
    const bookmakers = [bm(1, [{ value: "Home", odd: 1.5 }, { value: "Away", odd: 2.7 }])];
    expect(aggregateMoneyline(bookmakers, 2)).toBeNull();
  });

  it("ignores a bookmaker missing one side entirely", () => {
    const bookmakers = [
      bm(1, [{ value: "Home", odd: 1.5 }, { value: "Away", odd: 2.7 }]),
      bm(2, [{ value: "Home", odd: 1.55 }]), // no Away entry
      bm(3, [{ value: "Home", odd: 1.6 }, { value: "Away", odd: 2.5 }]),
    ];
    const result = aggregateMoneyline(bookmakers, 2);
    expect(result!.bookmakerCount).toBe(2);
  });

  it("ignores an unusable (<=1) price without crashing", () => {
    const bookmakers = [
      bm(1, [{ value: "Home", odd: 0.9 }, { value: "Away", odd: 2.7 }]),
      bm(2, [{ value: "Home", odd: 1.5 }, { value: "Away", odd: 2.7 }]),
      bm(3, [{ value: "Home", odd: 1.55 }, { value: "Away", odd: 2.6 }]),
    ];
    const result = aggregateMoneyline(bookmakers, 2);
    expect(result!.bookmakerCount).toBe(2);
  });

  it("is a pure function — the same input always produces the same output", () => {
    const bookmakers = [
      bm(1, [{ value: "Home", odd: 1.5 }, { value: "Away", odd: 2.7 }]),
      bm(2, [{ value: "Home", odd: 1.6 }, { value: "Away", odd: 2.5 }]),
      bm(3, [{ value: "Home", odd: 1.55 }, { value: "Away", odd: 2.6 }]),
    ];
    expect(aggregateMoneyline(bookmakers, 2)).toEqual(aggregateMoneyline(bookmakers, 2));
  });
});

describe("aggregateTotal", () => {
  it("picks the point value whose consensus lands closest to a 50/50 split", () => {
    const bookmakers = [
      bm(1, [], [
        { value: "Over 40", odd: 1.3 }, { value: "Under 40", odd: 3.2 },
        { value: "Over 47.5", odd: 1.91 }, { value: "Under 47.5", odd: 1.91 },
        { value: "Over 55", odd: 3.0 }, { value: "Under 55", odd: 1.35 },
      ]),
      bm(2, [], [
        { value: "Over 40", odd: 1.28 }, { value: "Under 40", odd: 3.3 },
        { value: "Over 47.5", odd: 1.9 }, { value: "Under 47.5", odd: 1.92 },
        { value: "Over 55", odd: 3.05 }, { value: "Under 55", odd: 1.33 },
      ]),
    ];
    const result = aggregateTotal(bookmakers, 2);
    expect(result).not.toBeNull();
    expect(result!.line).toBe(47.5);
    expect(result!.overProbability).toBeCloseTo(0.5, 1);
  });

  it("allows a whole-number line — no artificial half-point rounding, unlike the legacy pool wizard's estimator", () => {
    const bookmakers = [
      bm(1, [], [{ value: "Over 47", odd: 1.91 }, { value: "Under 47", odd: 1.91 }]),
      bm(2, [], [{ value: "Over 47", odd: 1.9 }, { value: "Under 47", odd: 1.92 }]),
    ];
    const result = aggregateTotal(bookmakers, 2);
    expect(result!.line).toBe(47);
  });

  it("requires the minimum bookmaker count at the SAME point — evidence does not carry across different lines", () => {
    const bookmakers = [
      bm(1, [], [{ value: "Over 47.5", odd: 1.91 }, { value: "Under 47.5", odd: 1.91 }]),
      bm(2, [], [{ value: "Over 48.5", odd: 1.9 }, { value: "Under 48.5", odd: 1.92 }]),
    ];
    // Each point only has ONE bookmaker quoting it — neither meets minBookmakerCount=2.
    expect(aggregateTotal(bookmakers, 2)).toBeNull();
  });

  it("ignores a bookmaker's one-sided entry (missing Under) at a given point", () => {
    const bookmakers = [
      bm(1, [], [{ value: "Over 47.5", odd: 1.91 }, { value: "Under 47.5", odd: 1.91 }]),
      bm(2, [], [{ value: "Over 47.5", odd: 1.9 }]), // no Under at this point
    ];
    expect(aggregateTotal(bookmakers, 2)).toBeNull();
  });

  it("returns null when no point value is offered by any bookmaker", () => {
    expect(aggregateTotal([bm(1, [], [])], 2)).toBeNull();
  });

  it("is a pure function", () => {
    const bookmakers = [
      bm(1, [], [{ value: "Over 47.5", odd: 1.91 }, { value: "Under 47.5", odd: 1.91 }]),
      bm(2, [], [{ value: "Over 47.5", odd: 1.9 }, { value: "Under 47.5", odd: 1.92 }]),
    ];
    expect(aggregateTotal(bookmakers, 2)).toEqual(aggregateTotal(bookmakers, 2));
  });
});
