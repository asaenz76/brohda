import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ConsumerMarketStatus } from "@/lib/prediction-markets/discovery/types";
import type { ExecutionEligibility, ExecutionPolicy } from "./types";

/**
 * Milestone 5 simulation policy, read from `platform_settings`
 * (migration 20260101000149). Fail-open on an unreadable row, matching
 * this codebase's existing platform_settings convention
 * (getFreshnessPolicy, getPredictionPolicy) — a transient config-read
 * failure is a platform-wide incident far bigger than this one feature,
 * not a reason to treat provider DATA as untrustworthy. Provider-data
 * trustworthiness (staleness, availability) is a completely separate
 * question, checked in `checkExecutionEligibility` below, and that check
 * is deliberately strict — Milestone 4's own architecture gate document
 * treats financial execution as higher-risk than ordinary product
 * eligibility (docs/architecture/execution-architecture-gate.md §12/§23).
 */
const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
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

const EXECUTION_POLICY_COLUMNS =
  "execution_simulation_enabled, execution_min_amount_cents, execution_max_amount_cents, execution_quote_expiry_seconds, execution_data_freshness_max_seconds, execution_max_slippage_bps, execution_recalculation_tolerance_bps, execution_simulated_provider_fee_bps, execution_simulated_brohda_fee_bps, execution_rollout_mode, execution_simulation_tolerate_unknown_compliance, execution_circuit_breaker_failure_threshold, execution_circuit_breaker_observation_window_seconds, execution_circuit_breaker_cooldown_seconds, execution_circuit_breaker_half_open_max_probes, execution_reconciliation_manual_review_after_mismatches";

export async function getExecutionPolicy(): Promise<ExecutionPolicy> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("platform_settings").select(EXECUTION_POLICY_COLUMNS).eq("id", true).single();

  if (!data) return DEFAULT_EXECUTION_POLICY;
  return {
    simulationEnabled: data.execution_simulation_enabled ?? DEFAULT_EXECUTION_POLICY.simulationEnabled,
    minAmountCents: data.execution_min_amount_cents ?? DEFAULT_EXECUTION_POLICY.minAmountCents,
    maxAmountCents: data.execution_max_amount_cents ?? DEFAULT_EXECUTION_POLICY.maxAmountCents,
    quoteExpirySeconds: data.execution_quote_expiry_seconds ?? DEFAULT_EXECUTION_POLICY.quoteExpirySeconds,
    dataFreshnessMaxSeconds: data.execution_data_freshness_max_seconds ?? DEFAULT_EXECUTION_POLICY.dataFreshnessMaxSeconds,
    maxSlippageBps: data.execution_max_slippage_bps ?? DEFAULT_EXECUTION_POLICY.maxSlippageBps,
    recalculationToleranceBps: data.execution_recalculation_tolerance_bps ?? DEFAULT_EXECUTION_POLICY.recalculationToleranceBps,
    simulatedProviderFeeBps: data.execution_simulated_provider_fee_bps ?? DEFAULT_EXECUTION_POLICY.simulatedProviderFeeBps,
    simulatedBrohdaFeeBps: data.execution_simulated_brohda_fee_bps ?? DEFAULT_EXECUTION_POLICY.simulatedBrohdaFeeBps,
    rolloutMode: data.execution_rollout_mode === "COHORT_RESTRICTED" ? "COHORT_RESTRICTED" : DEFAULT_EXECUTION_POLICY.rolloutMode,
    simulationTolerateUnknownCompliance: data.execution_simulation_tolerate_unknown_compliance ?? DEFAULT_EXECUTION_POLICY.simulationTolerateUnknownCompliance,
    circuitBreaker: {
      failureThreshold: data.execution_circuit_breaker_failure_threshold ?? DEFAULT_EXECUTION_POLICY.circuitBreaker.failureThreshold,
      observationWindowSeconds: data.execution_circuit_breaker_observation_window_seconds ?? DEFAULT_EXECUTION_POLICY.circuitBreaker.observationWindowSeconds,
      cooldownSeconds: data.execution_circuit_breaker_cooldown_seconds ?? DEFAULT_EXECUTION_POLICY.circuitBreaker.cooldownSeconds,
      halfOpenMaxProbes: data.execution_circuit_breaker_half_open_max_probes ?? DEFAULT_EXECUTION_POLICY.circuitBreaker.halfOpenMaxProbes,
    },
    reconciliationManualReviewAfterMismatches:
      data.execution_reconciliation_manual_review_after_mismatches ?? DEFAULT_EXECUTION_POLICY.reconciliationManualReviewAfterMismatches,
  };
}

export interface ExecutionEligibilityInput {
  consumerStatus: ConsumerMarketStatus | null;
  /** Null when the provider adapter returned no snapshot at all (disabled, no token id, network failure). */
  providerSnapshotAt: string | null;
  requestedAmountCents: number;
  now: Date;
}

/**
 * The pure Milestone 5 execution-eligibility decision — deliberately
 * SEPARATE from lib/predictions/policy.ts's checkMarketEligibility
 * (roadmap STEP 13's own instruction: "do not reuse Prediction eligibility
 * blindly"). A market can be fully eligible for a Prediction while still
 * being ineligible for simulated execution (e.g. its provider order-book
 * data is stale) — these are different trust requirements for different
 * risk levels.
 *
 * Does NOT check liquidity sufficiency or slippage — those require an
 * actual order-book walk (lib/execution/quote-math.ts) and are decided by
 * the orchestrating service (lib/execution/quote-service.ts) after this
 * check passes.
 */
export function checkExecutionEligibility(input: ExecutionEligibilityInput, policy: ExecutionPolicy): ExecutionEligibility {
  const { consumerStatus, providerSnapshotAt, requestedAmountCents, now } = input;

  if (!policy.simulationEnabled) return { eligible: false, reason: "SIMULATION_DISABLED" };
  if (consumerStatus === null) return { eligible: false, reason: "MARKET_INACTIVE" };
  if (consumerStatus !== "ACTIVE") return { eligible: false, reason: "MARKET_CLOSED" };

  if (providerSnapshotAt === null) return { eligible: false, reason: "PROVIDER_UNAVAILABLE" };
  const ageSeconds = (now.getTime() - new Date(providerSnapshotAt).getTime()) / 1000;
  if (ageSeconds > policy.dataFreshnessMaxSeconds) return { eligible: false, reason: "STALE_DATA" };

  if (requestedAmountCents < policy.minAmountCents || requestedAmountCents > policy.maxAmountCents) {
    return { eligible: false, reason: "AMOUNT_OUT_OF_RANGE" };
  }

  return { eligible: true };
}
