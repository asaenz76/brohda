import type { ComplianceState, EligibilitySignals } from "./types";

// Milestone 5.5 provider-neutral eligibility framework (STEP 10/11). This
// module makes NO legal conclusions — it does not decide which
// jurisdictions are legal, which users need KYC, which ages are allowed,
// or who is sanctioned. Those remain blocked on counsel
// (docs/legal/milestone-6-counsel-brief.md). What it DOES do is define how
// to compose whatever compliance state is known (including "not known at
// all") into a single allow/deny decision, and — critically — draws the
// one line that must never move: UNKNOWN is never silently treated as
// APPROVED.
//
// `toleratesUnknownCompliance` is a configuration value ONLY for
// simulation (platform_settings.execution_simulation_tolerate_unknown_compliance,
// read in lib/execution/policy.ts). A hypothetical future real-execution
// caller MUST pass `false` here as a hard-coded literal, never read from
// configuration — that is the one place this codebase deliberately
// violates its own "don't hard-code" rule, because "real execution always
// fails closed on unresolved compliance" is a true safety invariant, not a
// value that could reasonably change without changing the architecture.

/** Pure. `NOT_REQUIRED` and `APPROVED` pass; `BLOCKED` always fails; `PENDING` fails (not yet resolved); `UNKNOWN` fails unless the caller explicitly tolerates it. */
export function evaluateComplianceState(state: ComplianceState, toleratesUnknown: boolean): boolean {
  switch (state) {
    case "NOT_REQUIRED":
    case "APPROVED":
      return true;
    case "BLOCKED":
    case "PENDING":
      return false;
    case "UNKNOWN":
      return toleratesUnknown;
  }
}

export interface ComposeEligibilityInput {
  authenticated: boolean;
  simulationEnabled: boolean;
  killSwitchAllowed: boolean;
  rolloutAllowed: boolean;
  jurisdiction: ComplianceState;
  kyc: ComplianceState;
  aml: ComplianceState;
  sanctions: ComplianceState;
  age: ComplianceState;
  providerAccount: ComplianceState;
  marketEligible: boolean;
  withinLimits: boolean;
  /** See this module's own header comment — a future real-execution caller must pass `false` literally, never from configuration. */
  toleratesUnknownCompliance: boolean;
}

export interface EligibilityDecision {
  eligible: boolean;
  signals: EligibilitySignals;
  /** The first failing signal, in a fixed, documented check order — not every failing signal, since the caller only needs one reason to deny. */
  failedSignal: keyof EligibilitySignals | null;
}

/**
 * Composes every known signal into one decision. Order matters only for
 * which single reason is reported first (a cheap/structural check like
 * `authenticated` is checked before an operational-policy check, which is
 * checked before a compliance-state check) — every signal is still fully
 * evaluated and returned in `signals` regardless of order, so a caller can
 * always see the complete picture, not just the first failure.
 */
export function evaluateExecutionEligibility(input: ComposeEligibilityInput): EligibilityDecision {
  const signals: EligibilitySignals = {
    authenticated: input.authenticated,
    simulationEnabled: input.simulationEnabled,
    killSwitchAllowed: input.killSwitchAllowed,
    rolloutAllowed: input.rolloutAllowed,
    jurisdiction: input.jurisdiction,
    kyc: input.kyc,
    aml: input.aml,
    sanctions: input.sanctions,
    age: input.age,
    providerAccount: input.providerAccount,
    marketEligible: input.marketEligible,
    withinLimits: input.withinLimits,
  };

  const orderedChecks: Array<[keyof EligibilitySignals, boolean]> = [
    ["authenticated", input.authenticated],
    ["simulationEnabled", input.simulationEnabled],
    ["killSwitchAllowed", input.killSwitchAllowed],
    ["rolloutAllowed", input.rolloutAllowed],
    ["marketEligible", input.marketEligible],
    ["jurisdiction", evaluateComplianceState(input.jurisdiction, input.toleratesUnknownCompliance)],
    ["kyc", evaluateComplianceState(input.kyc, input.toleratesUnknownCompliance)],
    ["aml", evaluateComplianceState(input.aml, input.toleratesUnknownCompliance)],
    ["sanctions", evaluateComplianceState(input.sanctions, input.toleratesUnknownCompliance)],
    ["age", evaluateComplianceState(input.age, input.toleratesUnknownCompliance)],
    ["providerAccount", evaluateComplianceState(input.providerAccount, input.toleratesUnknownCompliance)],
    ["withinLimits", input.withinLimits],
  ];

  const firstFailure = orderedChecks.find(([, passed]) => !passed);

  return { eligible: firstFailure === undefined, signals, failedSignal: firstFailure ? firstFailure[0] : null };
}
