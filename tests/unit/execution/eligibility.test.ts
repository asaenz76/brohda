import { describe, expect, it } from "vitest";
import { evaluateComplianceState, evaluateExecutionEligibility } from "@/lib/execution/eligibility";

// Milestone 5.5 eligibility framework (STEP 10/11) — no legal conclusions,
// pure composition of whatever compliance state is already known. The one
// invariant this file exists to prove: UNKNOWN is never silently treated
// as APPROVED unless a caller explicitly opts in (and a future real
// execution caller must never opt in — see eligibility.ts's own comment).

describe("evaluateComplianceState", () => {
  it("NOT_REQUIRED and APPROVED always pass", () => {
    expect(evaluateComplianceState("NOT_REQUIRED", false)).toBe(true);
    expect(evaluateComplianceState("APPROVED", false)).toBe(true);
  });

  it("BLOCKED and PENDING always fail, even if the caller tolerates unknown", () => {
    expect(evaluateComplianceState("BLOCKED", true)).toBe(false);
    expect(evaluateComplianceState("PENDING", true)).toBe(false);
  });

  it("UNKNOWN fails by default", () => {
    expect(evaluateComplianceState("UNKNOWN", false)).toBe(false);
  });

  it("UNKNOWN passes only when the caller explicitly tolerates it", () => {
    expect(evaluateComplianceState("UNKNOWN", true)).toBe(true);
  });
});

function baseInput(overrides: Partial<Parameters<typeof evaluateExecutionEligibility>[0]> = {}) {
  return {
    authenticated: true,
    simulationEnabled: true,
    killSwitchAllowed: true,
    rolloutAllowed: true,
    jurisdiction: "NOT_REQUIRED" as const,
    kyc: "NOT_REQUIRED" as const,
    aml: "NOT_REQUIRED" as const,
    sanctions: "NOT_REQUIRED" as const,
    age: "NOT_REQUIRED" as const,
    providerAccount: "NOT_REQUIRED" as const,
    marketEligible: true,
    withinLimits: true,
    toleratesUnknownCompliance: true,
    ...overrides,
  };
}

describe("evaluateExecutionEligibility", () => {
  it("is eligible when every signal passes", () => {
    const decision = evaluateExecutionEligibility(baseInput());
    expect(decision.eligible).toBe(true);
    expect(decision.failedSignal).toBeNull();
  });

  it("denies on an unauthenticated user, reporting that as the failed signal", () => {
    const decision = evaluateExecutionEligibility(baseInput({ authenticated: false }));
    expect(decision.eligible).toBe(false);
    expect(decision.failedSignal).toBe("authenticated");
  });

  it("denies when a kill switch blocks execution", () => {
    const decision = evaluateExecutionEligibility(baseInput({ killSwitchAllowed: false }));
    expect(decision.eligible).toBe(false);
    expect(decision.failedSignal).toBe("killSwitchAllowed");
  });

  it("denies on an UNKNOWN compliance signal when the caller does not tolerate it — this is the one behavior that must never silently flip", () => {
    const decision = evaluateExecutionEligibility(baseInput({ jurisdiction: "UNKNOWN", toleratesUnknownCompliance: false }));
    expect(decision.eligible).toBe(false);
    expect(decision.failedSignal).toBe("jurisdiction");
  });

  it("tolerates an UNKNOWN compliance signal only when the caller explicitly opts in (simulation policy)", () => {
    const decision = evaluateExecutionEligibility(baseInput({ jurisdiction: "UNKNOWN", toleratesUnknownCompliance: true }));
    expect(decision.eligible).toBe(true);
  });

  it("denies on BLOCKED sanctions state regardless of tolerance", () => {
    const decision = evaluateExecutionEligibility(baseInput({ sanctions: "BLOCKED", toleratesUnknownCompliance: true }));
    expect(decision.eligible).toBe(false);
    expect(decision.failedSignal).toBe("sanctions");
  });

  it("still reports every signal even when only one fails, so a caller can see the full picture", () => {
    const decision = evaluateExecutionEligibility(baseInput({ withinLimits: false }));
    expect(decision.signals.withinLimits).toBe(false);
    expect(decision.signals.authenticated).toBe(true);
  });

  it("denies when execution limits are exceeded", () => {
    const decision = evaluateExecutionEligibility(baseInput({ withinLimits: false }));
    expect(decision.eligible).toBe(false);
    expect(decision.failedSignal).toBe("withinLimits");
  });
});
