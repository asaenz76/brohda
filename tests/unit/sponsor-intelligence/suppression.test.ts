import { describe, expect, it } from "vitest";
import { MIN_COHORT_FLOOR, suppressBreakdown, suppressCount, suppressSubset } from "@/lib/sponsor-intelligence/suppression";

describe("suppressCount", () => {
  it("shows zero and anything at or above the threshold, hides 1..k-1", () => {
    expect(suppressCount(0, 10)).toBe(0);
    expect(suppressCount(1, 10)).toBeNull();
    expect(suppressCount(9, 10)).toBeNull();
    expect(suppressCount(10, 10)).toBe(10); // the boundary is inclusive
    expect(suppressCount(11, 10)).toBe(11);
  });

  it("follows the configured threshold, not a constant", () => {
    expect(suppressCount(3, 3)).toBe(3);
    expect(suppressCount(3, 4)).toBeNull();
    expect(suppressCount(100, 250)).toBeNull();
  });

  it("a malformed or too-low threshold never loosens privacy", () => {
    for (const bad of [1, 0, -5, 2.5, Number.NaN]) {
      expect(suppressCount(7, bad), `k=${bad}`).toBeNull();
    }
    expect(MIN_COHORT_FLOOR).toBe(2);
    expect(suppressCount(2, 2)).toBe(2);
  });

  it("refuses nonsense counts", () => {
    expect(suppressCount(-1, 10)).toBeNull();
    expect(suppressCount(Number.NaN, 10)).toBeNull();
    expect(suppressCount(Number.POSITIVE_INFINITY, 10)).toBeNull();
  });
});

describe("suppressSubset", () => {
  it("shows a subset only when its remainder is also safe", () => {
    expect(suppressSubset(20, 30, 10)).toBe(20); // remainder 10: fine
    expect(suppressSubset(28, 30, 10)).toBeNull(); // remainder 2 would be revealed
    expect(suppressSubset(5, 30, 10)).toBeNull(); // subset itself too small
    expect(suppressSubset(0, 30, 10)).toBe(0); // zero subset, remainder = whole
    expect(suppressSubset(30, 30, 10)).toBe(30); // everyone, remainder 0
  });
});

describe("suppressBreakdown", () => {
  const cells = [
    { key: "nfl", label: "NFL", count: 40 },
    { key: "nba", label: "NBA", count: 12 },
    { key: "nhl", label: "NHL", count: 4 },
    { key: "mlb", label: "MLB", count: 3 },
    { key: "mls", label: "MLS", count: 2 },
  ];

  it("shows big cells, merges the small ones, and shows the merged figure only if it is big enough", () => {
    const out = suppressBreakdown(cells, 5);
    expect(out.cells.map((c) => c.key)).toEqual(["nfl", "nba"]);
    expect(out.other).toBe(9); // 4 + 3 + 2
  });

  it("hides the merged 'Other' when it would itself be a small group", () => {
    const out = suppressBreakdown(cells, 10);
    expect(out.cells.map((c) => c.key)).toEqual(["nfl", "nba"]);
    expect(out.other).toBeNull(); // 9 < 10: not shown at all
  });

  it("returns nothing when no cell is large enough", () => {
    const out = suppressBreakdown(cells, 100);
    expect(out).toEqual({ cells: [], other: null });
  });

  it("drops zero and invalid cells, orders biggest first and never exposes a cell under k", () => {
    const out = suppressBreakdown([{ key: "a", label: "A", count: 0 }, { key: "b", label: "B", count: 20 }, { key: "c", label: "C", count: 25 }], 10);
    expect(out.cells.map((c) => c.key)).toEqual(["c", "b"]);
    expect(out.cells.every((c) => c.count >= 10)).toBe(true);
  });

  it("with a malformed threshold it shows nothing rather than everything", () => {
    expect(suppressBreakdown(cells, 1)).toEqual({ cells: [], other: null });
  });
});
