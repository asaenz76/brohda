import { describe, expect, it } from "vitest";
import { estimateNflFixtureLines } from "@/lib/pools/templates/nfl-odds";
import type { NflBookmakerOdds } from "@/lib/sports-data/types";

// Every fixture below is real, captured-live API-NFL /odds data (not
// synthesized) — see the Task D investigation: a real read-only call
// against game id 21465 (Cincinnati Bengals @ Detroit Lions, 2026-08-12),
// and 2 more real upcoming games pulled to cross-validate the Asian
// Handicap interpretation before any code was written. Odd strings are
// converted to numbers here the same way api-nfl-provider.ts's
// rawValuesForBet does.
function bm(id: number, name: string, values: Partial<Record<"1" | "2" | "3" | "8" | "9", Array<{ value: string; odd: string }>>>): NflBookmakerOdds {
  const toNum = (arr?: Array<{ value: string; odd: string }>) => (arr ?? []).map((v) => ({ value: v.value, odd: Number(v.odd) }));
  return {
    bookmakerId: id,
    bookmakerName: name,
    moneyline: toNum(values["1"]),
    asianHandicap: toNum(values["2"]),
    gameTotal: toNum(values["3"]),
    homeTeamTotal: toNum(values["8"]),
    awayTeamTotal: toNum(values["9"]),
  };
}

// Cincinnati Bengals (home, strong favorite) @ Detroit Lions (away) —
// 11 real bookmakers, game id 21465.
const bengalsLions: NflBookmakerOdds[] = [
  bm(2, "10Bet", {
    "1": [{ value: "Home", odd: "1.35" }, { value: "Away", odd: "3.25" }],
    "2": [
      { value: "Home -3.5", odd: "1.91" }, { value: "Away -3.5", odd: "1.91" },
      { value: "Home -5", odd: "1.91" }, { value: "Away -5", odd: "1.91" },
      { value: "Home -4.5", odd: "1.90" }, { value: "Away -4.5", odd: "1.95" },
      { value: "Home -5.5", odd: "1.90" }, { value: "Away -5.5", odd: "1.95" },
      { value: "Home -6.5", odd: "1.90" }, { value: "Away -6.5", odd: "1.95" },
      { value: "Home -7", odd: "1.90" }, { value: "Away -7", odd: "1.95" },
    ],
    "3": [
      { value: "Over 37", odd: "1.90" }, { value: "Under 37", odd: "1.95" },
      { value: "Over 37.5", odd: "1.91" }, { value: "Under 37.5", odd: "1.91" },
      { value: "Over 38", odd: "1.91" }, { value: "Under 38", odd: "1.91" },
    ],
  }),
  bm(4, "Bet365", {
    "1": [{ value: "Home", odd: "1.37" }, { value: "Away", odd: "3.20" }],
    "2": [
      { value: "Home -3.5", odd: "1.90" }, { value: "Away -3.5", odd: "1.90" },
      { value: "Home -5", odd: "1.90" }, { value: "Away -5", odd: "1.90" },
      { value: "Home -4.5", odd: "1.86" }, { value: "Away -4.5", odd: "1.95" },
      { value: "Home -6.5", odd: "1.86" }, { value: "Away -6.5", odd: "1.95" },
      { value: "Home -7.5", odd: "2.00" }, { value: "Away -7.5", odd: "1.83" },
    ],
    "3": [
      { value: "Over 37.5", odd: "1.90" }, { value: "Under 37.5", odd: "1.90" },
      { value: "Over 38", odd: "1.90" }, { value: "Under 38", odd: "1.90" },
      { value: "Over 38.5", odd: "1.90" }, { value: "Under 38.5", odd: "1.90" },
    ],
    "8": [
      { value: "Over 9.5", odd: "1.04" }, { value: "Under 9.5", odd: "10.00" },
      { value: "Over 13.5", odd: "1.18" }, { value: "Under 13.5", odd: "4.50" },
      { value: "Over 20.5", odd: "1.62" }, { value: "Under 20.5", odd: "2.20" },
      { value: "Over 23.5", odd: "1.80" }, { value: "Under 23.5", odd: "1.90" },
      { value: "Over 27.5", odd: "2.50" }, { value: "Under 27.5", odd: "1.50" },
    ],
    "9": [
      { value: "Over 13.5", odd: "1.90" }, { value: "Under 13.5", odd: "1.80" },
      { value: "Over 16.5", odd: "2.40" }, { value: "Under 16.5", odd: "1.52" },
      { value: "Over 20.5", odd: "4.50" }, { value: "Under 20.5", odd: "1.18" },
    ],
  }),
  bm(5, "Marathon", {
    "1": [{ value: "Home", odd: "1.31" }, { value: "Away", odd: "3.26" }],
    "2": [
      { value: "Home -1.5", odd: "1.50" }, { value: "Away -1.5", odd: "2.45" },
      { value: "Home +1.5", odd: "1.41" }, { value: "Away +1.5", odd: "2.69" },
      { value: "Home -3.5", odd: "1.55" }, { value: "Away -3.5", odd: "2.32" },
    ],
    "3": [
      { value: "Over 37.5", odd: "1.88" }, { value: "Under 37.5", odd: "1.86" },
      { value: "Over 38.5", odd: "1.89" }, { value: "Under 38.5", odd: "1.85" },
    ],
    "8": [
      { value: "Over 21", odd: "1.84" }, { value: "Under 21", odd: "1.88" },
      { value: "Over 22.5", odd: "1.86" }, { value: "Under 22.5", odd: "1.86" },
      { value: "Over 23", odd: "1.89" }, { value: "Under 23", odd: "1.83" },
    ],
    "9": [
      { value: "Over 14", odd: "1.80" }, { value: "Under 14", odd: "1.92" },
      { value: "Over 17", odd: "1.91" }, { value: "Under 17", odd: "1.81" },
      { value: "Over 16", odd: "1.85" }, { value: "Under 16", odd: "1.87" },
    ],
  }),
  bm(6, "Unibet", {
    "1": [{ value: "Home", odd: "1.38" }, { value: "Away", odd: "3.10" }],
    "2": [
      { value: "Home -4", odd: "1.92" }, { value: "Away -4", odd: "1.90" },
      { value: "Home -3.5", odd: "1.92" }, { value: "Away -3.5", odd: "1.90" },
    ],
    "3": [
      { value: "Over 37.5", odd: "1.88" }, { value: "Under 37.5", odd: "1.94" },
      { value: "Over 38", odd: "1.94" }, { value: "Under 38", odd: "1.88" },
      { value: "Over 38.5", odd: "1.91" }, { value: "Under 38.5", odd: "1.91" },
    ],
  }),
  bm(7, "Pinnacle", {
    "1": [{ value: "Home", odd: "1.36" }, { value: "Away", odd: "3.22" }],
    "2": [
      { value: "Home -4.5", odd: "1.93" }, { value: "Away -4.5", odd: "1.93" },
      { value: "Home -6.5", odd: "1.83" }, { value: "Away -6.5", odd: "2.03" },
    ],
    "3": [
      { value: "Over 37", odd: "1.93" }, { value: "Under 37", odd: "1.93" },
      { value: "Over 37.5", odd: "1.85" }, { value: "Under 37.5", odd: "2.01" },
      { value: "Over 38.5", odd: "1.93" }, { value: "Under 38.5", odd: "1.92" },
    ],
  }),
  bm(9, "1xBet", {
    "1": [{ value: "Home", odd: "1.37" }, { value: "Away", odd: "3.20" }],
    "2": [
      { value: "Home -3.5", odd: "1.55" }, { value: "Away -3.5", odd: "2.32" },
      { value: "Home -5", odd: "1.91" }, { value: "Away -5", odd: "1.91" },
    ],
    "3": [
      { value: "Over 37.5", odd: "1.92" }, { value: "Under 37.5", odd: "1.88" },
      { value: "Over 38", odd: "1.91" }, { value: "Under 38", odd: "1.91" },
      { value: "Over 38.5", odd: "1.91" }, { value: "Under 38.5", odd: "1.91" },
    ],
    "8": [
      { value: "Over 23.5", odd: "1.80" }, { value: "Under 23.5", odd: "1.91" },
      { value: "Over 21", odd: "1.84" }, { value: "Under 21", odd: "1.88" },
    ],
    "9": [
      { value: "Over 13.5", odd: "1.91" }, { value: "Under 13.5", odd: "1.80" },
    ],
  }),
];

// Pittsburgh Steelers (home, underdog per moneyline) @ Green Bay Packers
// (away, favorite per moneyline) — a genuinely close real game (id
// 21466), 11 real bookmakers. The Asian Handicap data here is exactly
// the case that motivated estimateSpreadMagnitude's design: bookmakers
// routinely list both "Home -X" and "Away -X" (identical sign, same
// magnitude) side by side, alongside separate "+0"/"+X" entries — real
// evidence the pairing convention can't be resolved by sign alone, only
// by reading the favorite's own "-X" entries via the (unambiguous)
// moneyline-determined side.
const steelersPackers: NflBookmakerOdds[] = [
  bm(2, "10Bet", {
    "1": [{ value: "Home", odd: "2.10" }, { value: "Away", odd: "1.75" }],
    "2": [
      { value: "Home +0", odd: "1.91" }, { value: "Away +0", odd: "1.91" },
      { value: "Home -1.5", odd: "1.91" }, { value: "Away -1.5", odd: "1.91" },
      { value: "Home +1.5", odd: "1.91" }, { value: "Away +1.5", odd: "1.91" },
    ],
  }),
  bm(4, "Bet365", {
    "1": [{ value: "Home", odd: "2.15" }, { value: "Away", odd: "1.74" }],
    "2": [
      { value: "Home -1.5", odd: "1.95" }, { value: "Away -1.5", odd: "1.86" },
      { value: "Home +1.5", odd: "1.90" }, { value: "Away +1.5", odd: "1.90" },
    ],
  }),
  bm(5, "Marathon", {
    "1": [{ value: "Home", odd: "2.01" }, { value: "Away", odd: "1.75" }],
    "2": [
      { value: "Home -1.5", odd: "2.02" }, { value: "Away -1.5", odd: "1.73" },
      { value: "Home -3.5", odd: "2.39" }, { value: "Away -3.5", odd: "1.52" },
      { value: "Home -4.5", odd: "2.58" }, { value: "Away -4.5", odd: "1.44" },
      { value: "Home -6.5", odd: "3.04" }, { value: "Away -6.5", odd: "1.33" },
    ],
  }),
  bm(6, "Unibet", {
    "1": [{ value: "Home", odd: "2.10" }, { value: "Away", odd: "1.75" }],
    "2": [
      { value: "Home -1", odd: "1.90" }, { value: "Away -1", odd: "1.92" },
      { value: "Home -2", odd: "1.92" }, { value: "Away -2", odd: "1.90" },
      { value: "Home -1.5", odd: "1.89" }, { value: "Away -1.5", odd: "1.93" },
    ],
  }),
  bm(20, "Betfair", {
    "1": [{ value: "Home", odd: "2.10" }, { value: "Away", odd: "1.73" }],
    "2": [{ value: "Home -1.5", odd: "1.91" }, { value: "Away -1.5", odd: "1.80" }],
  }),
  bm(24, "BetVictor", {
    "1": [{ value: "Home", odd: "2.05" }, { value: "Away", odd: "1.75" }],
    "2": [
      { value: "Home -1.5", odd: "1.83" }, { value: "Away -1.5", odd: "1.87" },
      { value: "Home -2.5", odd: "1.85" }, { value: "Away -2.5", odd: "1.85" },
    ],
  }),
  bm(7, "Pinnacle", {
    "1": [{ value: "Home", odd: "2.17" }, { value: "Away", odd: "1.73" }],
    "2": [
      { value: "Home -1", odd: "1.93" }, { value: "Away -1", odd: "1.93" },
      { value: "Home -2", odd: "1.92" }, { value: "Away -2", odd: "1.93" },
    ],
  }),
  bm(8, "SBO", {
    "1": [{ value: "Home", odd: "2.06" }, { value: "Away", odd: "1.76" }],
    "2": [{ value: "Home -1.5", odd: "1.83" }, { value: "Away -1.5", odd: "1.99" }],
  }),
  bm(9, "1xBet", {
    "1": [{ value: "Home", odd: "2.10" }, { value: "Away", odd: "1.77" }],
    "2": [
      { value: "Home -1", odd: "1.84" }, { value: "Away -1", odd: "1.96" },
      { value: "Home -1.5", odd: "2.20" }, { value: "Away -1.5", odd: "1.62" },
      { value: "Home -6.5", odd: "3.04" }, { value: "Away -6.5", odd: "1.33" },
    ],
  }),
  bm(22, "Betano", {
    "1": [{ value: "Home", odd: "2.15" }, { value: "Away", odd: "1.72" }],
    "2": [
      { value: "Home -0.5", odd: "1.83" }, { value: "Away -0.5", odd: "1.88" },
      { value: "Home -1.5", odd: "1.83" }, { value: "Away -1.5", odd: "1.87" },
    ],
  }),
  bm(23, "Superbet", {
    "1": [{ value: "Home", odd: "2.05" }, { value: "Away", odd: "1.78" }],
    "2": [{ value: "Home -1.5", odd: "1.90" }, { value: "Away -1.5", odd: "1.83" }],
  }),
];

describe("estimateNflFixtureLines — favorite (moneyline)", () => {
  it("picks the moneyline favorite regardless of home/away, with a real bookmaker count", () => {
    const result = estimateNflFixtureLines({ externalFixtureId: "21465", providerUpdatedAt: null, bookmakers: bengalsLions });
    expect(result.favorite).not.toBeNull();
    expect(result.favorite!.team).toBe("HOME"); // Bengals (home) are the clear favorite at ~1.3x odds
    expect(result.favorite!.probability).toBeGreaterThan(0.6);
    expect(result.favorite!.bookmakerCount).toBe(bengalsLions.length);
  });

  it("correctly picks the AWAY team as favorite when the home team is the underdog", () => {
    const result = estimateNflFixtureLines({ externalFixtureId: "steelers-packers", providerUpdatedAt: null, bookmakers: steelersPackers });
    expect(result.favorite).not.toBeNull();
    expect(result.favorite!.team).toBe("AWAY"); // Packers (away, ML 1.75) favored over Steelers (home, ML 2.10)
  });

  it("returns null with fewer than 2 bookmakers offering moneyline (no real consensus)", () => {
    const result = estimateNflFixtureLines({ externalFixtureId: "single", providerUpdatedAt: null, bookmakers: [bengalsLions[0]] });
    expect(result.favorite).toBeNull();
  });
});

describe("estimateNflFixtureLines — game/team totals (Over/Under, unambiguous)", () => {
  it("picks a half-point game total line close to the market's own cluster (37.5-38.5) and rounds up any whole-number pick", () => {
    const result = estimateNflFixtureLines({ externalFixtureId: "21465", providerUpdatedAt: null, bookmakers: bengalsLions });
    expect(result.gameTotal).not.toBeNull();
    expect(result.gameTotal!.line % 1).not.toBe(0); // never a whole number
    expect(result.gameTotal!.line).toBeGreaterThanOrEqual(37.5);
    expect(result.gameTotal!.line).toBeLessThanOrEqual(38.5);
  });

  it("picks real team-total lines for both sides from the Total-Home/Total-Away markets", () => {
    const result = estimateNflFixtureLines({ externalFixtureId: "21465", providerUpdatedAt: null, bookmakers: bengalsLions });
    expect(result.homeTeamTotal).not.toBeNull();
    expect(result.homeTeamTotal!.line % 1).not.toBe(0);
    expect(result.awayTeamTotal).not.toBeNull();
    expect(result.awayTeamTotal!.line % 1).not.toBe(0);
  });

  it("returns null when a market has no usable data at all", () => {
    const result = estimateNflFixtureLines({
      externalFixtureId: "no-totals",
      providerUpdatedAt: null,
      bookmakers: [bm(1, "OnlyMoneyline", { "1": [{ value: "Home", odd: "1.50" }, { value: "Away", odd: "2.60" }] })],
    });
    expect(result.gameTotal).toBeNull();
    expect(result.homeTeamTotal).toBeNull();
    expect(result.awayTeamTotal).toBeNull();
  });
});

describe("estimateNflFixtureLines — spread (best-effort, unconfirmed)", () => {
  it("derives a half-point spread magnitude for the moneyline favorite, never a whole number", () => {
    const result = estimateNflFixtureLines({ externalFixtureId: "21465", providerUpdatedAt: null, bookmakers: bengalsLions });
    expect(result.spread).not.toBeNull();
    expect(result.spread!.line % 1).not.toBe(0);
    expect(result.spread!.line).toBeGreaterThan(0);
  });

  it("only reads the favorite's own '-X' entries across 11 real bookmakers, ignoring '+X' entries and the underdog's '-X' entries", () => {
    // Away (Packers) is favorite. Every bookmaker's own smallest "Away -X"
    // magnitude, medianed: [1.5,1.5,1.5,1,1.5,1.5,1,1.5,1,0.5,1.5] -> 1.5 —
    // already a half-point, matching this real game's actual close spread.
    const result = estimateNflFixtureLines({ externalFixtureId: "21466", providerUpdatedAt: null, bookmakers: steelersPackers });
    expect(result.favorite!.team).toBe("AWAY");
    expect(result.spread).not.toBeNull();
    expect(result.spread!.line).toBe(1.5);
    expect(result.spread!.bookmakerCount).toBe(steelersPackers.length);
  });

  it("is null when the favorite has no '-X' entries at all (e.g. only a pick'em '+0' line)", () => {
    const result = estimateNflFixtureLines({
      externalFixtureId: "pickem-only",
      providerUpdatedAt: null,
      bookmakers: [
        bm(1, "PickemOnly", {
          "1": [{ value: "Home", odd: "1.90" }, { value: "Away", odd: "1.90" }],
          "2": [{ value: "Home +0", odd: "1.91" }, { value: "Away +0", odd: "1.91" }],
        }),
        bm(2, "PickemOnly2", {
          "1": [{ value: "Home", odd: "1.91" }, { value: "Away", odd: "1.89" }],
        }),
      ],
    });
    expect(result.spread).toBeNull();
  });

  it("rounds a whole-number-only spread magnitude up to the next half-point", () => {
    // Two real-shaped bookmakers, both offering only a whole-number
    // favorite handicap ("-3") — the resolved magnitude (median 3) must
    // round up to 3.5, never surface as a whole number.
    const result = estimateNflFixtureLines({
      externalFixtureId: "whole-number-line",
      providerUpdatedAt: null,
      bookmakers: [
        bm(1, "BookA", {
          "1": [{ value: "Home", odd: "1.40" }, { value: "Away", odd: "2.90" }],
          "2": [{ value: "Home -3", odd: "1.91" }, { value: "Away -3", odd: "1.91" }],
        }),
        bm(2, "BookB", {
          "1": [{ value: "Home", odd: "1.42" }, { value: "Away", odd: "2.80" }],
          "2": [{ value: "Home -3", odd: "1.90" }, { value: "Away -3", odd: "1.92" }],
        }),
      ],
    });
    expect(result.favorite!.team).toBe("HOME");
    expect(result.spread).toEqual({ line: 3.5, bookmakerCount: 2 });
  });
});
