import { describe, expect, it } from "vitest";
import { devig2Way } from "@/lib/pools/templates/odds-devig";

describe("devig2Way", () => {
  it("removes the overround using both sides, never 1 - impliedYes", () => {
    // Raw implied: 1/1.90=0.5263, 1/1.90=0.5263, sum=1.0526 (~5.26% margin).
    // Fair should split the margin evenly since both sides are identical.
    const fair = devig2Way(1.9, 1.9);
    expect(fair).toBeCloseTo(0.5, 6);
  });

  it("weights the fair split toward the shorter (more likely) side", () => {
    // Home heavily favored: raw implied 1/1.25=0.80, 1/4.0=0.25, sum=1.05.
    const fair = devig2Way(1.25, 4.0)!;
    expect(fair).toBeCloseTo(0.8 / 1.05, 6);
    expect(fair).toBeGreaterThan(0.5);
  });

  it("returns null for an unpayable odd (<= 1)", () => {
    expect(devig2Way(1.0, 2.0)).toBeNull();
    expect(devig2Way(2.0, 0.9)).toBeNull();
  });

  it("real sample: Both Teams Score Yes@2.10/No@1.65 devigs close to but not equal to raw implied", () => {
    const rawImpliedYes = 1 / 2.1;
    const fair = devig2Way(2.1, 1.65)!;
    // De-vig always pulls the raw implied probability toward account for
    // the vig on both sides — fair YES should differ from the raw implied
    // value (proof the "no" side was actually used, not `1 - rawYes`).
    expect(fair).not.toBeCloseTo(rawImpliedYes, 4);
    expect(fair).toBeGreaterThan(0);
    expect(fair).toBeLessThan(1);
  });
});
