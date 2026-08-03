import { describe, expect, it } from "vitest";
import { devig2Way, devig3Way } from "@/lib/pools/templates/odds-devig";

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

describe("devig3Way", () => {
  it("normalizes three raw implied probabilities to sum to exactly 1", () => {
    // Real sample from the audit: Home 3.20 / Draw 2.86 / Away 2.46.
    const fair = devig3Way(3.2, 2.86, 2.46)!;
    expect(fair.home + fair.draw + fair.away).toBeCloseTo(1, 9);
    expect(fair.away).toBeGreaterThan(fair.home); // away was the raw favorite
  });

  it("returns null for an unpayable odd (<= 1)", () => {
    expect(devig3Way(1.0, 2.0, 3.0)).toBeNull();
  });

  it("splits evenly across three identical odds", () => {
    const fair = devig3Way(3.0, 3.0, 3.0)!;
    expect(fair.home).toBeCloseTo(1 / 3, 6);
    expect(fair.draw).toBeCloseTo(1 / 3, 6);
    expect(fair.away).toBeCloseTo(1 / 3, 6);
  });
});
