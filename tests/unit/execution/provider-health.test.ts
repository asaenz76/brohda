import { describe, expect, it } from "vitest";
import { decideCallAllowed, deriveProviderHealthStatus } from "@/lib/execution/provider-health";
import type { ProviderHealthRecord } from "@/lib/execution/types";

// Milestone 5.5 provider-health / circuit-breaker pure logic (STEP 14/15).
// No I/O — these two functions are the entire decision surface, fully
// unit-testable without a database.

function record(overrides: Partial<ProviderHealthRecord> = {}): ProviderHealthRecord {
  return {
    provider: "polymarket",
    circuitState: "CLOSED",
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
    halfOpenProbeAt: null,
    manuallyDisabled: false,
    manualReason: null,
    manualSetBy: null,
    manualSetAt: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("deriveProviderHealthStatus", () => {
  it("is HEALTHY when closed and not manually disabled", () => {
    expect(deriveProviderHealthStatus(record())).toBe("HEALTHY");
  });

  it("is DEGRADED when the breaker is HALF_OPEN", () => {
    expect(deriveProviderHealthStatus(record({ circuitState: "HALF_OPEN" }))).toBe("DEGRADED");
  });

  it("is UNAVAILABLE when the breaker is OPEN", () => {
    expect(deriveProviderHealthStatus(record({ circuitState: "OPEN" }))).toBe("UNAVAILABLE");
  });

  it("is MANUALLY_DISABLED regardless of circuit state — the operator override always wins", () => {
    expect(deriveProviderHealthStatus(record({ circuitState: "CLOSED", manuallyDisabled: true }))).toBe("MANUALLY_DISABLED");
    expect(deriveProviderHealthStatus(record({ circuitState: "OPEN", manuallyDisabled: true }))).toBe("MANUALLY_DISABLED");
  });
});

describe("decideCallAllowed", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("allows a call when CLOSED", () => {
    expect(decideCallAllowed(record({ circuitState: "CLOSED" }), now)).toEqual({ allowed: true, transitionToHalfOpen: false });
  });

  it("allows a probe when HALF_OPEN, without a further transition", () => {
    expect(decideCallAllowed(record({ circuitState: "HALF_OPEN" }), now)).toEqual({ allowed: true, transitionToHalfOpen: false });
  });

  it("denies a call when OPEN and the cooldown has not elapsed", () => {
    const halfOpenProbeAt = new Date(now.getTime() + 10_000).toISOString();
    expect(decideCallAllowed(record({ circuitState: "OPEN", halfOpenProbeAt }), now)).toEqual({ allowed: false, transitionToHalfOpen: false });
  });

  it("allows exactly one probe, transitioning to HALF_OPEN, once the cooldown has elapsed", () => {
    const halfOpenProbeAt = new Date(now.getTime() - 1).toISOString();
    expect(decideCallAllowed(record({ circuitState: "OPEN", halfOpenProbeAt }), now)).toEqual({ allowed: true, transitionToHalfOpen: true });
  });

  it("denies a call regardless of circuit state when manually disabled", () => {
    expect(decideCallAllowed(record({ circuitState: "CLOSED", manuallyDisabled: true }), now)).toEqual({ allowed: false, transitionToHalfOpen: false });
  });
});
