import { describe, expect, it } from "vitest";
import { formatProbabilityPercent } from "@/lib/prediction-markets/discovery/probability";

describe("formatProbabilityPercent", () => {
  it("converts a 0-1 price to a whole-number percent", () => {
    expect(formatProbabilityPercent(0.62)).toBe(62);
  });

  it("rounds consistently (round-half-up)", () => {
    expect(formatProbabilityPercent(0.625)).toBe(63);
    expect(formatProbabilityPercent(0.001)).toBe(0);
    expect(formatProbabilityPercent(0.999)).toBe(100);
  });

  it("returns null for a missing price — never fabricates a number", () => {
    expect(formatProbabilityPercent(null)).toBeNull();
  });

  it("never derives one side from the other — each call is independent", () => {
    const yes = formatProbabilityPercent(0.3);
    const no = formatProbabilityPercent(0.68); // deliberately NOT 1 - 0.3, proving no complement is assumed
    expect(yes).toBe(30);
    expect(no).toBe(68);
    expect(yes! + no!).not.toBe(100);
  });
});
