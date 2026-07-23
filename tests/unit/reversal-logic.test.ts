import { describe, expect, it } from "vitest";
import { checkReversalFeasibility } from "@/lib/pools/reversal-logic";

describe("checkReversalFeasibility", () => {
  it("is feasible when every winner can absorb the clawback", () => {
    const result = checkReversalFeasibility([
      { userId: "a", creditedAmount: 1800, currentBalance: 5000 },
      { userId: "b", creditedAmount: 900, currentBalance: 900 },
    ]);

    expect(result.feasible).toBe(true);
    expect(result.report).toEqual([
      { userId: "a", creditedAmount: 1800, currentBalance: 5000, shortfall: 0 },
      { userId: "b", creditedAmount: 900, currentBalance: 900, shortfall: 0 },
    ]);
  });

  it("is infeasible when one winner is short, and reports the exact shortfall", () => {
    const result = checkReversalFeasibility([
      { userId: "a", creditedAmount: 1800, currentBalance: 500 },
    ]);

    expect(result.feasible).toBe(false);
    expect(result.report).toEqual([
      { userId: "a", creditedAmount: 1800, currentBalance: 500, shortfall: 1300 },
    ]);
  });

  it("reports every affected winner, not just the ones short (spec X.17.4)", () => {
    const result = checkReversalFeasibility([
      { userId: "a", creditedAmount: 1000, currentBalance: 5000 },
      { userId: "b", creditedAmount: 1000, currentBalance: 200 },
    ]);

    expect(result.feasible).toBe(false);
    expect(result.report).toHaveLength(2);
    expect(result.report[0]).toEqual({
      userId: "a",
      creditedAmount: 1000,
      currentBalance: 5000,
      shortfall: 0,
    });
    expect(result.report[1]).toEqual({
      userId: "b",
      creditedAmount: 1000,
      currentBalance: 200,
      shortfall: 800,
    });
  });

  it("an exact-match balance (credited === current) is feasible with zero shortfall", () => {
    const result = checkReversalFeasibility([
      { userId: "a", creditedAmount: 1000, currentBalance: 1000 },
    ]);

    expect(result.feasible).toBe(true);
    expect(result.report[0].shortfall).toBe(0);
  });

  it("no winners at all is trivially feasible", () => {
    expect(checkReversalFeasibility([])).toEqual({ feasible: true, report: [] });
  });
});
