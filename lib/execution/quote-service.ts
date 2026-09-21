import "server-only";
import { getMarketById } from "@/lib/prediction-markets/repository";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";
import { recordAuditEvent } from "./audit";
import { getUserCohortKeys } from "./cohorts";
import { checkExecutionControlPlane } from "./control-plane";
import { generateCorrelationId } from "./correlation";
import { evaluateExecutionLimits } from "./limits";
import { getExecutionQuoteProvider } from "./provider-registry";
import { checkExecutionEligibility, getExecutionPolicy } from "./policy";
import { computeQuote, priceMovementBps } from "./quote-math";
import { createOrderIntent, createQuote, getQuoteById, resolveOrderIntent } from "./repository";
import type { ExecutionIneligibleReason, ExecutionQuote, ExecutionSide, OrderIntent, OrderIntentRejectionReason } from "./types";

/**
 * Orchestrates STEP 15's flow: control plane -> validate -> fetch read-only
 * provider data -> compute -> persist. The browser never reaches this file
 * directly — it is called only from lib/actions/execution.ts's Server
 * Action, so every provider call here is already server-side by
 * construction.
 *
 * Milestone 5.5 addition: before any of the Milestone 5 checks run, this
 * function asks the execution control plane (lib/execution/control-plane.ts)
 * "is execution currently allowed?" — the same question a future real
 * execution flow must ask before any provider mutation. A correlation ID
 * is generated once, here, and threads through every subsequent event for
 * this journey (lib/execution/correlation.ts).
 */
export type RequestQuoteResult = { success: true; quote: ExecutionQuote } | { success: false; reason: ExecutionIneligibleReason };

export async function requestQuote(userId: string, marketId: string, selectedSide: ExecutionSide, requestedAmountCents: number): Promise<RequestQuoteResult> {
  const correlationId = generateCorrelationId();
  await recordAuditEvent({ eventType: "QUOTE_REQUESTED", correlationId, actorUserId: userId, marketId, metadata: { selectedSide, requestedAmountCents } });

  const market = await getMarketById(marketId);
  if (market === null) {
    await recordAuditEvent({ eventType: "QUOTE_REJECTED", correlationId, actorUserId: userId, marketId, severity: "INFO", metadata: { reason: "MARKET_NOT_FOUND" } });
    return { success: false, reason: "MARKET_NOT_FOUND" };
  }

  const policy = await getExecutionPolicy();

  const controlPlane = await checkExecutionControlPlane({ userId, provider: market.provider, marketId, jurisdiction: null }, policy);
  if (!controlPlane.allowed) {
    await recordAuditEvent({
      eventType: "EXECUTION_ELIGIBILITY_DENIED",
      correlationId,
      actorUserId: userId,
      marketId,
      provider: market.provider,
      severity: "WARN",
      metadata: { reason: controlPlane.reason, blockedBySwitch: controlPlane.blockedBySwitch ?? null },
    });
    return { success: false, reason: controlPlane.reason };
  }

  const consumerStatus = deriveConsumerStatus(market.status, market.resolvedOutcome);

  const provider = getExecutionQuoteProvider(market.provider);
  const snapshot = provider?.isEnabled() ? await provider.getExecutableSnapshot(marketId, selectedSide) : null;

  const eligibility = checkExecutionEligibility(
    { consumerStatus, providerSnapshotAt: snapshot?.snapshotAt ?? null, requestedAmountCents, now: new Date() },
    policy,
  );
  if (!eligibility.eligible) {
    await recordAuditEvent({
      eventType: "QUOTE_REJECTED",
      correlationId,
      actorUserId: userId,
      marketId,
      provider: market.provider,
      metadata: { reason: eligibility.reason },
    });
    return { success: false, reason: eligibility.reason };
  }

  // checkExecutionEligibility already guarantees snapshot is non-null when eligible.
  const computation = computeQuote(snapshot!, requestedAmountCents, policy);
  if (!computation.ok) {
    await recordAuditEvent({ eventType: "QUOTE_REJECTED", correlationId, actorUserId: userId, marketId, provider: market.provider, metadata: { reason: "INSUFFICIENT_LIQUIDITY" } });
    return { success: false, reason: "INSUFFICIENT_LIQUIDITY" };
  }
  if (computation.computation.estimatedSlippageBps > policy.maxSlippageBps) {
    await recordAuditEvent({ eventType: "QUOTE_REJECTED", correlationId, actorUserId: userId, marketId, provider: market.provider, metadata: { reason: "SLIPPAGE_TOO_HIGH" } });
    return { success: false, reason: "SLIPPAGE_TOO_HIGH" };
  }

  const cohortKeys = await getUserCohortKeys(userId);
  const limitCheck = await evaluateExecutionLimits({ userId, cohortKeys, provider: market.provider, jurisdiction: null, requestedAmountCents, now: new Date() });
  if (!limitCheck.allowed) {
    await recordAuditEvent({
      eventType: "LIMIT_DENIED",
      correlationId,
      actorUserId: userId,
      marketId,
      provider: market.provider,
      severity: "WARN",
      metadata: { violations: limitCheck.violations },
    });
    return { success: false, reason: "LIMIT_EXCEEDED" };
  }

  const now = new Date();
  const quote = await createQuote({
    userId,
    marketId,
    selectedSide,
    requestedAmountCents,
    ...computation.computation,
    providerSnapshotAt: snapshot!.snapshotAt,
    expiresAt: new Date(now.getTime() + policy.quoteExpirySeconds * 1000).toISOString(),
    correlationId,
  });

  await recordAuditEvent({ eventType: "QUOTE_CREATED", correlationId, actorUserId: userId, marketId, quoteId: quote.id, provider: market.provider });

  return { success: true, quote };
}

export type ConfirmSimulationResult =
  | { success: true; orderIntent: OrderIntent }
  | { success: false; reason: "QUOTE_NOT_FOUND" | "NOT_ELIGIBLE" | "QUOTE_EXPIRED" | "EXECUTION_DISABLED" | "ROLLOUT_BLOCKED" | "LIMIT_EXCEEDED" | OrderIntentRejectionReason };

/**
 * Orchestrates STEP 21/24/25: never trusts client-submitted economics —
 * every value used to decide the simulated outcome is re-derived
 * server-side from the stored Quote row and a FRESH provider snapshot,
 * never from anything the client sent beyond the Quote's own id and the
 * idempotency key. The client submits identifiers/intention only.
 *
 * Milestone 5.5 addition: the control plane and execution limits are
 * re-checked here too, not only at quote-request time — an operator who
 * flips a kill switch between quote and confirmation must actually block
 * the confirmation, not just the next quote request.
 */
export async function confirmSimulatedExecution(userId: string, quoteId: string, idempotencyKey: string): Promise<ConfirmSimulationResult> {
  const quote = await getQuoteById(quoteId);
  // Cross-user protection: a quote that doesn't belong to this user is
  // treated identically to one that doesn't exist — never leaking whether
  // the id was valid for someone else.
  if (quote === null || quote.userId !== userId) return { success: false, reason: "QUOTE_NOT_FOUND" };

  const correlationId = quote.correlationId;
  const now = new Date();
  if (now.getTime() >= new Date(quote.expiresAt).getTime()) return { success: false, reason: "QUOTE_EXPIRED" };

  const market = await getMarketById(quote.marketId);
  if (market === null) return { success: false, reason: "NOT_ELIGIBLE" };
  const consumerStatus = deriveConsumerStatus(market.status, market.resolvedOutcome);
  const policy = await getExecutionPolicy();

  const controlPlane = await checkExecutionControlPlane({ userId, provider: market.provider, marketId: quote.marketId, jurisdiction: null }, policy);
  if (!controlPlane.allowed) {
    await recordAuditEvent({
      eventType: "EXECUTION_ELIGIBILITY_DENIED",
      correlationId,
      actorUserId: userId,
      marketId: quote.marketId,
      quoteId: quote.id,
      provider: market.provider,
      severity: "WARN",
      metadata: { reason: controlPlane.reason, stage: "confirmation" },
    });
    return { success: false, reason: controlPlane.reason };
  }

  if (!policy.simulationEnabled) return { success: false, reason: "NOT_ELIGIBLE" };
  if (consumerStatus !== "ACTIVE") return { success: false, reason: "MARKET_CLOSED" };

  // Re-check current data — STEP 25: never silently confirm against a
  // snapshot that might no longer be honorable, and never silently
  // re-price the user's already-reviewed quote either.
  const provider = getExecutionQuoteProvider(market.provider);
  const freshSnapshot = provider?.isEnabled() ? await provider.getExecutableSnapshot(quote.marketId, quote.selectedSide) : null;
  if (freshSnapshot === null) return { success: false, reason: "STALE_DATA" };

  const ageSeconds = (now.getTime() - new Date(freshSnapshot.snapshotAt).getTime()) / 1000;
  if (ageSeconds > policy.dataFreshnessMaxSeconds) return { success: false, reason: "STALE_DATA" };

  const freshComputation = computeQuote(freshSnapshot, quote.requestedAmountCents, policy);
  if (!freshComputation.ok) return { success: false, reason: "INSUFFICIENT_LIQUIDITY" };

  const cohortKeys = await getUserCohortKeys(userId);
  const limitCheck = await evaluateExecutionLimits({
    userId,
    cohortKeys,
    provider: market.provider,
    jurisdiction: null,
    requestedAmountCents: quote.requestedAmountCents,
    now,
  });
  if (!limitCheck.allowed) {
    await recordAuditEvent({
      eventType: "LIMIT_DENIED",
      correlationId,
      actorUserId: userId,
      marketId: quote.marketId,
      quoteId: quote.id,
      provider: market.provider,
      severity: "WARN",
      metadata: { violations: limitCheck.violations, stage: "confirmation" },
    });
    return { success: false, reason: "LIMIT_EXCEEDED" };
  }

  const movementBps = priceMovementBps(quote.effectivePrice, freshComputation.computation.effectivePrice);

  const { orderIntent, outcome } = await createOrderIntent({
    userId,
    marketId: quote.marketId,
    quoteId: quote.id,
    selectedSide: quote.selectedSide,
    requestedAmountCents: quote.requestedAmountCents,
    quotedEffectivePrice: quote.effectivePrice,
    quotedEstimatedGrossReturnCents: quote.estimatedGrossReturnCents,
    quotedTotalFeeEstimateCents: quote.totalFeeEstimateCents,
    quotedSlippageBps: quote.estimatedSlippageBps,
    quoteCreatedAt: quote.createdAt,
    quoteProviderSnapshotAt: quote.providerSnapshotAt,
    idempotencyKey,
    correlationId,
  });

  // A genuine replay of an already-resolved confirmation — return it
  // as-is, never re-evaluate or re-resolve.
  if (outcome === "existing") return { success: true, orderIntent };

  await recordAuditEvent({ eventType: "ORDER_INTENT_CONFIRMED", correlationId, actorUserId: userId, marketId: quote.marketId, quoteId: quote.id, orderIntentId: orderIntent.id, provider: market.provider });

  const resolvedAt = new Date().toISOString();
  const rejectionReason: OrderIntentRejectionReason | null = movementBps > policy.recalculationToleranceBps ? "SLIPPAGE_TOO_HIGH" : null;

  await resolveOrderIntent(orderIntent.id, {
    lifecycleState: rejectionReason ? "SIMULATED_REJECTED" : "SIMULATED_FILLED",
    resultReason: rejectionReason,
    resolvedAt,
  });

  await recordAuditEvent({
    eventType: rejectionReason ? "SIMULATION_REJECTED" : "SIMULATION_FILLED",
    correlationId,
    actorUserId: userId,
    marketId: quote.marketId,
    quoteId: quote.id,
    orderIntentId: orderIntent.id,
    provider: market.provider,
    metadata: rejectionReason ? { reason: rejectionReason } : undefined,
  });

  return {
    success: true,
    orderIntent: { ...orderIntent, lifecycleState: rejectionReason ? "SIMULATED_REJECTED" : "SIMULATED_FILLED", resultReason: rejectionReason, resolvedAt },
  };
}
