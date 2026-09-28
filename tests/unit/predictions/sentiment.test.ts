import { describe, expect, it } from "vitest";
import { computePickSentiment } from "@/lib/predictions/sentiment";

// Phase C (Brohda 2.0 redesign, spec §13-14) — the pure percentage
// calculation behind Home's real Pick-share sentiment. See that file's
// own header comment for the documented inclusion rule this assumes the
// caller (getPickAggregatesForMarkets) already applied.
describe("computePickSentiment", () => {
  it("returns a null split and zero count when there is no aggregate at all (nobody has predicted)", () => {
    expect(computePickSentiment(undefined)).toEqual({ totalPickCount: 0, yesPercent: null, noPercent: null });
  });

  it("returns a null split when the aggregate exists but totalPickCount is 0", () => {
    expect(computePickSentiment({ marketId: "m1", totalPickCount: 0, yesCount: 0, noCount: 0 })).toEqual({
      totalPickCount: 0,
      yesPercent: null,
      noPercent: null,
    });
  });

  it("computes an even split for one Pick each way", () => {
    expect(computePickSentiment({ marketId: "m1", totalPickCount: 2, yesCount: 1, noCount: 1 })).toEqual({
      totalPickCount: 2,
      yesPercent: 50,
      noPercent: 50,
    });
  });

  it("computes a real, non-fabricated percentage for a single Pick — not gated behind a minimum sample size", () => {
    expect(computePickSentiment({ marketId: "m1", totalPickCount: 1, yesCount: 1, noCount: 0 })).toEqual({
      totalPickCount: 1,
      yesPercent: 100,
      noPercent: 0,
    });
  });

  it("rounds to the nearest whole percent", () => {
    // 2/3 = 66.67 -> 67, 1/3 = 33.33 -> 33
    expect(computePickSentiment({ marketId: "m1", totalPickCount: 3, yesCount: 2, noCount: 1 })).toEqual({
      totalPickCount: 3,
      yesPercent: 67,
      noPercent: 33,
    });
  });

  it("handles every Pick landing on the same side", () => {
    expect(computePickSentiment({ marketId: "m1", totalPickCount: 4, yesCount: 4, noCount: 0 })).toEqual({
      totalPickCount: 4,
      yesPercent: 100,
      noPercent: 0,
    });
  });
});
