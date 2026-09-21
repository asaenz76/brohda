import type { ExecutionIneligibleReason, OrderIntentRejectionReason } from "./types";

// Milestone 5.5 canonical failure taxonomy (STEP 20) — classifies every
// reason code lib/execution/quote-service.ts can return, so an operator or
// a future incident-response process can tell at a glance whether a spike
// in a given reason means "users are doing something correctable,"
// "policy is intentionally blocking," "the provider is having a bad day,"
// or "something needs investigating." This classification is metadata for
// operators/observability (STEP 38) — it is NOT the consumer-facing copy,
// which stays in lib/execution/copy.ts and is reviewed/configured
// separately, per the standing rule's own instruction that consumer copy
// must be separable from internal failure identity.

export type FailureClass = "CONSUMER_CORRECTABLE" | "POLICY_DENIAL" | "SECURITY_DENIAL" | "PROVIDER_TEMPORARY" | "RECONCILIATION";

type AnyFailureReason = ExecutionIneligibleReason | OrderIntentRejectionReason | "QUOTE_NOT_FOUND" | "QUOTE_EXPIRED";

export const FAILURE_CLASSIFICATION: Record<AnyFailureReason, FailureClass> = {
  // Consumer-correctable: the user can plausibly fix this by changing their own input or retrying shortly.
  AMOUNT_OUT_OF_RANGE: "CONSUMER_CORRECTABLE",
  QUOTE_EXPIRED: "CONSUMER_CORRECTABLE",
  QUOTE_NOT_FOUND: "CONSUMER_CORRECTABLE",
  SLIPPAGE_TOO_HIGH: "CONSUMER_CORRECTABLE",
  INSUFFICIENT_LIQUIDITY: "CONSUMER_CORRECTABLE",

  // Policy denial: an operator/product decision, not an error and not
  // provider-caused. Never implies a bug.
  SIMULATION_DISABLED: "POLICY_DENIAL",
  MARKET_CLOSED: "POLICY_DENIAL",
  MARKET_INACTIVE: "POLICY_DENIAL",
  NOT_ELIGIBLE: "POLICY_DENIAL",
  EXECUTION_DISABLED: "POLICY_DENIAL",
  ROLLOUT_BLOCKED: "POLICY_DENIAL",
  LIMIT_EXCEEDED: "POLICY_DENIAL",

  // Provider-temporary: the provider (or Brohda's read of it) is
  // momentarily untrustworthy — expected to resolve on its own, alert-worthy
  // only if sustained (STEP 38).
  STALE_DATA: "PROVIDER_TEMPORARY",
  PROVIDER_UNAVAILABLE: "PROVIDER_TEMPORARY",

  // Market-not-found sits with security/data-integrity, not
  // consumer-correctable — it usually means a stale/tampered client
  // reference (threat model #14's market-ID-substitution class), not
  // something the user can fix by trying again with the same input.
  MARKET_NOT_FOUND: "SECURITY_DENIAL",
};
