// Brohda Simulated Execution domain (Milestone 5,
// docs/PRODUCT_TRANSFORMATION_ROADMAP.md). Introduces the provider-neutral
// Quote/OrderIntent concepts Milestone 6 is expected to build real
// execution against — see docs/architecture/simulated-execution.md.
//
// This is NOT the Prediction domain (lib/predictions/) and NOT the
// Milestone 1 market-discovery provider domain (lib/prediction-markets/).
// Nothing here imports from lib/prediction-markets/providers/ — provider
// specifics stay inside lib/execution/providers/.
//
// No real financial exposure, no provider order, no signing, no custody —
// every record this domain creates is structurally marked `isSimulated`.

export type ExecutionSide = "YES" | "NO";

/**
 * One depth level from a provider's order book, already provider-neutral
 * (price 0-1, size in shares) — the adapter is solely responsible for
 * translating a raw provider response into this shape.
 */
export interface DepthLevel {
  price: number;
  size: number;
}

/**
 * A read-only, provider-neutral snapshot of what's needed to compute a
 * simulated quote. Never exposes a token ID, condition ID, or any other
 * raw provider identifier — those stay inside the adapter that produced
 * this snapshot.
 */
export interface ExecutableMarketSnapshot {
  /** 0-1, the provider's current best/last price for the requested side. */
  currentPrice: number;
  /** Ascending by price — the adapter is responsible for this ordering regardless of the raw provider's own array order. */
  askLevels: DepthLevel[];
  tickSize: number;
  minOrderSize: number;
  /** When the provider actually returned this data — the freshness input, distinct from when Brohda finished processing it. */
  snapshotAt: string;
}

/**
 * The read-only provider contract for Milestone 5. Deliberately narrow and
 * separate from lib/prediction-markets/types.ts's PredictionMarketProvider
 * (which is a discovery/ingestion concern) — mixing quote/depth
 * responsibilities into that interface would blur two different
 * lifecycles (batch ingestion vs. per-request live pricing). No
 * order-placement or cancellation method exists on this interface, and
 * none may be added until Milestone 6's own architecture review.
 */
export interface ExecutionQuoteProvider {
  readonly name: string;
  isEnabled(): boolean;
  /**
   * Fetches a live, read-only snapshot for one market's given side.
   * Returns `null` if the provider has no executable data for this market
   * (e.g. no CLOB token id recorded) — never a fabricated snapshot.
   */
  getExecutableSnapshot(providerMarketId: string, side: ExecutionSide): Promise<ExecutableMarketSnapshot | null>;
}

/**
 * The configurable Milestone 5 simulation policy — see
 * lib/execution/policy.ts. Extended in Milestone 5.5 with the operational
 * safety layer's own singleton policy values (rollout mode, the simulation
 * compliance-tolerance flag, circuit-breaker thresholds, and the
 * reconciliation manual-review threshold) — all from the same
 * `platform_settings` row, read together to avoid scattering config reads
 * across modules.
 */
export interface ExecutionPolicy {
  simulationEnabled: boolean;
  minAmountCents: number;
  maxAmountCents: number;
  quoteExpirySeconds: number;
  dataFreshnessMaxSeconds: number;
  maxSlippageBps: number;
  recalculationToleranceBps: number;
  simulatedProviderFeeBps: number;
  simulatedBrohdaFeeBps: number;
  /** OPEN: every eligible user may proceed regardless of cohort membership. COHORT_RESTRICTED: only active-cohort members may proceed. */
  rolloutMode: "OPEN" | "COHORT_RESTRICTED";
  /**
   * Whether SIMULATION eligibility tolerates an UNKNOWN compliance signal.
   * Real execution must NEVER read this flag — its own fail-closed-on-UNKNOWN
   * behavior is a code-level invariant, not configuration. See
   * lib/execution/eligibility.ts.
   */
  simulationTolerateUnknownCompliance: boolean;
  circuitBreaker: CircuitBreakerPolicy;
  reconciliationManualReviewAfterMismatches: number;
}

/**
 * Why a quote/confirmation attempt was rejected — never a raw provider/
 * internal message. The three Milestone 5.5 additions (EXECUTION_DISABLED,
 * ROLLOUT_BLOCKED, LIMIT_EXCEEDED) are produced only by the operational
 * safety layer (lib/execution/control-plane.ts, lib/execution/limits.ts)
 * and are never persisted to order_intents.result_reason — they only ever
 * occur as an early, pre-persistence denial, exactly like NOT_ELIGIBLE/
 * QUOTE_EXPIRED already do in lib/execution/quote-service.ts. See
 * lib/execution/failure-taxonomy.ts for the classification of every reason
 * in this union.
 */
export type ExecutionIneligibleReason =
  | "SIMULATION_DISABLED"
  | "MARKET_NOT_FOUND"
  | "MARKET_CLOSED"
  | "MARKET_INACTIVE"
  | "STALE_DATA"
  | "PROVIDER_UNAVAILABLE"
  | "INSUFFICIENT_LIQUIDITY"
  | "AMOUNT_OUT_OF_RANGE"
  | "SLIPPAGE_TOO_HIGH"
  | "NOT_ELIGIBLE"
  | "EXECUTION_DISABLED"
  | "ROLLOUT_BLOCKED"
  | "LIMIT_EXCEEDED";

export type ExecutionEligibility = { eligible: true } | { eligible: false; reason: ExecutionIneligibleReason };

/** The result of a successful quote computation — see lib/execution/quote-math.ts. */
export interface QuoteComputation {
  currentPrice: number;
  effectivePrice: number;
  estimatedUnits: number;
  estimatedGrossReturnCents: number;
  providerFeeEstimateCents: number;
  brohdaFeeEstimateCents: number;
  totalFeeEstimateCents: number;
  estimatedSlippageBps: number;
}

/** The full domain record — mirrors lib/predictions/types.ts's own immutability-by-convention documentation style. */
export interface ExecutionQuote {
  id: string;
  userId: string;
  marketId: string;
  selectedSide: ExecutionSide;
  requestedAmountCents: number;
  currentPrice: number;
  effectivePrice: number;
  estimatedUnits: number;
  estimatedGrossReturnCents: number;
  providerFeeEstimateCents: number;
  brohdaFeeEstimateCents: number;
  totalFeeEstimateCents: number;
  estimatedSlippageBps: number;
  providerSnapshotAt: string;
  expiresAt: string;
  isSimulated: true;
  createdAt: string;
  /** See lib/execution/correlation.ts — generated once, here, and carried forward. */
  correlationId: string;
}

export type OrderIntentLifecycleState = "CONFIRMED" | "SIMULATED_FILLED" | "SIMULATED_REJECTED";

export type OrderIntentRejectionReason = "MARKET_CLOSED" | "STALE_DATA" | "INSUFFICIENT_LIQUIDITY" | "SLIPPAGE_TOO_HIGH" | "NOT_ELIGIBLE";

export interface OrderIntent {
  id: string;
  userId: string;
  marketId: string;
  /** Traceability only — see repository.ts. Not a source of truth for this row's own economics. */
  quoteId: string;
  selectedSide: ExecutionSide;
  requestedAmountCents: number;
  quotedEffectivePrice: number;
  quotedEstimatedGrossReturnCents: number;
  quotedTotalFeeEstimateCents: number;
  quotedSlippageBps: number;
  quoteCreatedAt: string;
  quoteProviderSnapshotAt: string;
  confirmedAt: string;
  lifecycleState: OrderIntentLifecycleState;
  resultReason: OrderIntentRejectionReason | null;
  resolvedAt: string | null;
  isSimulated: true;
  createdAt: string;
  /** See lib/execution/correlation.ts — inherited from the parent Quote at confirmation time. */
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Milestone 5.5 — Execution Controls, Reconciliation & Operational Safety
// (docs/architecture/execution-operational-safety.md). Provider-neutral
// operational infrastructure — no wallet, no Session Key, no real order,
// no real financial exposure. See that document for the full design.
// ---------------------------------------------------------------------------

/** A closed, hard-coded vocabulary (a true invariant — adding a scope is a genuine application change). */
export type KillSwitchScope = "GLOBAL" | "PROVIDER" | "JURISDICTION" | "MARKET" | "USER" | "COHORT";

export interface ExecutionKillSwitch {
  id: string;
  scope: KillSwitchScope;
  /** Null only for GLOBAL. Meaning depends on scope — see lib/execution/kill-switches.ts. */
  target: string | null;
  enabled: boolean;
  reason: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  disabledBy: string | null;
  disabledAt: string | null;
}

export type CohortMode = "ALLOWLIST" | "PERCENTAGE";

export interface ExecutionCohort {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  mode: CohortMode;
  /** Non-null only when mode is PERCENTAGE. */
  percentage: number | null;
  /** Non-null only when mode is PERCENTAGE — see lib/execution/cohorts.ts's deterministic hash. */
  rolloutSeed: string | null;
  providerScope: string | null;
  jurisdictionScope: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionLimitScope = "GLOBAL" | "USER" | "COHORT" | "JURISDICTION" | "PROVIDER";
export type ExecutionLimitType = "PER_ORDER_AMOUNT_CENTS" | "DAILY_AMOUNT_CENTS" | "ROLLING_AMOUNT_CENTS" | "DAILY_ORDER_COUNT";

export interface ExecutionLimit {
  id: string;
  scope: ExecutionLimitScope;
  target: string | null;
  limitType: ExecutionLimitType;
  thresholdValue: number;
  /** Non-null only when limitType is ROLLING_AMOUNT_CENTS. */
  windowSeconds: number | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionLimitViolation {
  limitId: string;
  scope: ExecutionLimitScope;
  limitType: ExecutionLimitType;
  thresholdValue: number;
  observedValue: number;
}

export interface LimitEvaluationResult {
  allowed: boolean;
  violations: ExecutionLimitViolation[];
}

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";
export type ProviderHealthStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "MANUALLY_DISABLED";

export interface ProviderHealthRecord {
  provider: string;
  circuitState: CircuitBreakerState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  openedAt: string | null;
  halfOpenProbeAt: string | null;
  manuallyDisabled: boolean;
  manualReason: string | null;
  manualSetBy: string | null;
  manualSetAt: string | null;
  updatedAt: string;
}

export interface CircuitBreakerPolicy {
  failureThreshold: number;
  observationWindowSeconds: number;
  cooldownSeconds: number;
  halfOpenMaxProbes: number;
}

/**
 * The Milestone 5.5 execution event vocabulary (STEP 17) — reviewed down
 * from the task's own example list to events this codebase actually emits;
 * see lib/execution/audit.ts.
 */
export type ExecutionAuditEventType =
  | "QUOTE_REQUESTED"
  | "QUOTE_CREATED"
  | "QUOTE_REJECTED"
  | "ORDER_INTENT_CONFIRMED"
  | "SIMULATION_FILLED"
  | "SIMULATION_REJECTED"
  | "EXECUTION_ELIGIBILITY_DENIED"
  | "LIMIT_DENIED"
  | "KILL_SWITCH_ACTIVATED"
  | "KILL_SWITCH_DEACTIVATED"
  | "PROVIDER_HEALTH_CHANGED"
  | "CIRCUIT_BREAKER_OPENED"
  | "CIRCUIT_BREAKER_CLOSED"
  | "RECONCILIATION_STARTED"
  | "RECONCILIATION_COMPLETED"
  | "RECONCILIATION_MISMATCH"
  | "POLICY_CHANGED";

export type ExecutionAuditSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

export interface ExecutionAuditEvent {
  id: string;
  eventType: ExecutionAuditEventType;
  occurredAt: string;
  correlationId: string | null;
  actorUserId: string | null;
  marketId: string | null;
  quoteId: string | null;
  orderIntentId: string | null;
  provider: string | null;
  severity: ExecutionAuditSeverity;
  /** Safe, structured metadata only — see lib/execution/audit.ts's redaction guard. */
  metadata: Record<string, unknown>;
}

/**
 * The states a real-world compliance dimension may be in. Brohda does not
 * decide *what* jurisdiction/KYC/AML/sanctions/age rule applies (that
 * remains blocked by counsel, docs/legal/milestone-6-counsel-brief.md) —
 * only how the eligibility framework composes whatever state is known.
 * UNKNOWN must never be silently treated as APPROVED — see
 * lib/execution/eligibility.ts.
 */
export type ComplianceState = "UNKNOWN" | "NOT_REQUIRED" | "PENDING" | "APPROVED" | "BLOCKED";

/** The full set of signals the Milestone 5.5 eligibility framework composes (STEP 10). No signal here makes a legal conclusion. */
export interface EligibilitySignals {
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
}

export type ReconciliationResult = "IN_SYNC" | "UPDATED" | "PENDING" | "MISMATCH" | "MANUAL_REVIEW_REQUIRED";

export interface ReconciliationRecord {
  id: string;
  orderIntentId: string;
  batchId: string | null;
  correlationId: string | null;
  expectedState: Record<string, unknown>;
  authoritativeState: Record<string, unknown>;
  result: ReconciliationResult;
  mismatchDetails: Record<string, unknown> | null;
  previousRecordId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}
