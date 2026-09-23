import { describe, expect, it } from "vitest";
import { computeEffectiveLockAt, isPastEffectiveLock } from "@/lib/predictions/lock";

describe("computeEffectiveLockAt", () => {
  it("subtracts the configured minutes from kickoff", () => {
    const kickoff = "2026-01-01T19:00:00.000Z";
    expect(computeEffectiveLockAt(kickoff, 10).toISOString()).toBe("2026-01-01T18:50:00.000Z");
  });

  it("supports a zero-minute cutoff (locks exactly at kickoff)", () => {
    const kickoff = "2026-01-01T19:00:00.000Z";
    expect(computeEffectiveLockAt(kickoff, 0).toISOString()).toBe(kickoff);
  });

  it("is a pure function of its inputs", () => {
    const kickoff = "2026-01-01T19:00:00.000Z";
    expect(computeEffectiveLockAt(kickoff, 10)).toEqual(computeEffectiveLockAt(kickoff, 10));
  });
});

describe("isPastEffectiveLock", () => {
  const kickoff = "2026-01-01T19:00:00.000Z"; // effective lock at 18:50 with a 10-minute cutoff

  it("is false comfortably before the cutoff", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T18:00:00.000Z"))).toBe(false);
  });

  it("is false one millisecond before the cutoff", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T18:49:59.999Z"))).toBe(false);
  });

  it("is true exactly at the cutoff instant", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T18:50:00.000Z"))).toBe(true);
  });

  it("is true after the cutoff", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T19:30:00.000Z"))).toBe(true);
  });
});
