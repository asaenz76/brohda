import { describe, expect, it } from "vitest";
import { computeStreaks, toStreakSymbols, type GradedOutcome } from "@/lib/analytics/streaks";

function outcomes(statuses: GradedOutcome["status"][]): GradedOutcome[] {
  return statuses.map((status) => ({ status }));
}

describe("computeStreaks", () => {
  it("returns all zeros for no entries", () => {
    expect(computeStreaks([])).toEqual({ currentStreak: 0, longestWinStreak: 0, longestLossStreak: 0 });
  });

  it("computes a positive current streak for consecutive recent wins", () => {
    // Most-recent-first: W, W, W, L, W
    const result = computeStreaks(outcomes(["WON", "WON", "WON", "LOST", "WON"]));
    expect(result.currentStreak).toBe(3);
    expect(result.longestWinStreak).toBe(3);
    expect(result.longestLossStreak).toBe(1);
  });

  it("computes a negative current streak for consecutive recent losses", () => {
    const result = computeStreaks(outcomes(["LOST", "LOST", "WON"]));
    expect(result.currentStreak).toBe(-2);
    expect(result.longestLossStreak).toBe(2);
    expect(result.longestWinStreak).toBe(1);
  });

  it("skips voids and refunds entirely — they neither break nor extend a streak", () => {
    // Most-recent-first: V, W, W, V, L
    const result = computeStreaks(outcomes(["VOID", "WON", "WON", "REFUNDED", "LOST"]));
    expect(result.currentStreak).toBe(2);
    expect(result.longestWinStreak).toBe(2);
    expect(result.longestLossStreak).toBe(1);
  });

  it("current streak is 0 when only voids/refunds exist (no graded entries yet)", () => {
    const result = computeStreaks(outcomes(["VOID", "REFUNDED"]));
    expect(result.currentStreak).toBe(0);
    expect(result.longestWinStreak).toBe(0);
    expect(result.longestLossStreak).toBe(0);
  });

  it("finds the longest streak even when it's not the current one", () => {
    // Most-recent-first: L (current), then a long win streak further back
    const result = computeStreaks(outcomes(["LOST", "WON", "WON", "WON", "WON", "LOST", "LOST"]));
    expect(result.currentStreak).toBe(-1);
    expect(result.longestWinStreak).toBe(4);
    expect(result.longestLossStreak).toBe(2);
  });
});

describe("toStreakSymbols", () => {
  it("maps WON/LOST/VOID/REFUNDED to W/L/V/V respectively", () => {
    expect(toStreakSymbols(outcomes(["WON", "LOST", "VOID", "REFUNDED"]))).toEqual(["W", "L", "V", "V"]);
  });
});
