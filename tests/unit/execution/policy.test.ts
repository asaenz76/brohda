import { describe, expect, it } from "vitest";
import { checkExecutionEligibility, type ExecutionEligibilityInput } from "@/lib/execution/policy";
import type { ExecutionPolicy } from "@/lib/execution/types";

/**
 * The pure Milestone 5 execution-eligibility decision, deliberately
 * separate from Prediction's own eligibility (lib/predictions/policy.ts) —
 * see checkExecutionEligibility's own comment for why. Execution's
 * freshness requirement is measured in seconds, not minutes, per
 * Milestone 4's "financial execution is higher risk" instruction.
 */

const POLICY: ExecutionPolicy = {
  simulationEnabled: true,
  minAmountCents: 100,
  maxAmountCents: 100_000,
  quoteExpirySeconds: 30,
  dataFreshnessMaxSeconds: 10,
  maxSlippageBps: 500,
  recalculationToleranceBps: 200,
  simulatedProviderFeeBps: 100,
  simulatedBrohdaFeeBps: 0,
  rolloutMode: "OPEN",
  simulationTolerateUnknownCompliance: true,
  circuitBreaker: { failureThreshold: 5, observationWindowSeconds: 60, cooldownSeconds: 30, halfOpenMaxProbes: 1 },
  reconciliationManualReviewAfterMismatches: 2,
};

function baseInput(overrides: Partial<ExecutionEligibilityInput> = {}): ExecutionEligibilityInput {
  return {
    consumerStatus: "ACTIVE",
    providerSnapshotAt: "2026-01-01T00:00:00.000Z",
    requestedAmountCents: 1000,
    now: new Date("2026-01-01T00:00:05.000Z"), // 5s after snapshot
    ...overrides,
  };
}

describe("checkExecutionEligibility", () => {
  it("permits an active market with fresh data and an in-range amount", () => {
    expect(checkExecutionEligibility(baseInput(), POLICY)).toEqual({ eligible: true });
  });

  it("denies when simulation is disabled by policy, regardless of everything else", () => {
    expect(checkExecutionEligibility(baseInput(), { ...POLICY, simulationEnabled: false })).toEqual({
      eligible: false,
      reason: "SIMULATION_DISABLED",
    });
  });

  it("denies an inactive/archived market (null consumer status)", () => {
    expect(checkExecutionEligibility(baseInput({ consumerStatus: null }), POLICY)).toEqual({ eligible: false, reason: "MARKET_INACTIVE" });
  });

  it("denies a CLOSED or RESOLVED market — simulation never runs on a non-ACTIVE market", () => {
    expect(checkExecutionEligibility(baseInput({ consumerStatus: "CLOSED" }), POLICY)).toEqual({ eligible: false, reason: "MARKET_CLOSED" });
    expect(checkExecutionEligibility(baseInput({ consumerStatus: "RESOLVED" }), POLICY)).toEqual({ eligible: false, reason: "MARKET_CLOSED" });
  });

  it("denies when no provider snapshot could be obtained at all", () => {
    expect(checkExecutionEligibility(baseInput({ providerSnapshotAt: null }), POLICY)).toEqual({
      eligible: false,
      reason: "PROVIDER_UNAVAILABLE",
    });
  });

  describe("data freshness — stricter, separately configurable from discovery", () => {
    it("denies stale provider data past the configured seconds threshold", () => {
      const input = baseInput({ now: new Date("2026-01-01T00:00:11.000Z") }); // 11s > 10s threshold
      expect(checkExecutionEligibility(input, POLICY)).toEqual({ eligible: false, reason: "STALE_DATA" });
    });

    it("permits data right at the freshness boundary", () => {
      const input = baseInput({ now: new Date("2026-01-01T00:00:10.000Z") }); // exactly 10s
      expect(checkExecutionEligibility(input, POLICY)).toEqual({ eligible: true });
    });

    it("changing the freshness threshold changes the decision with no code change", () => {
      const stricter: ExecutionPolicy = { ...POLICY, dataFreshnessMaxSeconds: 3 };
      const input = baseInput(); // 5s old
      expect(checkExecutionEligibility(input, stricter)).toEqual({ eligible: false, reason: "STALE_DATA" });
    });
  });

  describe("amount range policy", () => {
    it("denies an amount below the configured minimum", () => {
      expect(checkExecutionEligibility(baseInput({ requestedAmountCents: 50 }), POLICY)).toEqual({
        eligible: false,
        reason: "AMOUNT_OUT_OF_RANGE",
      });
    });

    it("denies an amount above the configured maximum", () => {
      expect(checkExecutionEligibility(baseInput({ requestedAmountCents: 200_000 }), POLICY)).toEqual({
        eligible: false,
        reason: "AMOUNT_OUT_OF_RANGE",
      });
    });

    it("changing min/max policy changes the decision with no code change", () => {
      const widened: ExecutionPolicy = { ...POLICY, minAmountCents: 10, maxAmountCents: 500_000 };
      expect(checkExecutionEligibility(baseInput({ requestedAmountCents: 50 }), widened)).toEqual({ eligible: true });
    });
  });
});
