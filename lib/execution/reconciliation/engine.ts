import "server-only";
import { recordAuditEvent } from "../audit";
import { countTrailingMismatches, getLatestReconciliationRecord, insertReconciliationRecord } from "./repository";
import type { ExpectedOrderState, SimulatedProviderState, SimulatedProviderStateSource } from "./types";
import type { ReconciliationRecord, ReconciliationResult } from "../types";

// Milestone 5.5 reconciliation algorithm (STEP 21-24). Brohda is never
// assumed authoritative — every comparison is (Brohda's expected state) vs
// (the simulated provider's authoritative state), never the reverse.

interface Comparison {
  result: ReconciliationResult;
  mismatchDetails: Record<string, unknown> | null;
}

/**
 * Pure — the actual decision table (STEP 23). No auto-"fixing": a DUPLICATE
 * report always escalates to a human, and any state combination this table
 * doesn't explicitly recognize as safe falls through to MISMATCH rather
 * than being guessed at.
 */
export function compareExpectedToAuthoritative(expected: ExpectedOrderState, authoritative: SimulatedProviderState): Comparison {
  const details = { expected, authoritative };

  switch (authoritative.outcome) {
    case "UNAVAILABLE":
    case "DELAYED":
      return { result: "PENDING", mismatchDetails: null };

    case "MISSING":
      return expected.lifecycleState === "CONFIRMED" ? { result: "PENDING", mismatchDetails: null } : { result: "MISMATCH", mismatchDetails: details };

    case "DUPLICATE":
      return { result: "MANUAL_REVIEW_REQUIRED", mismatchDetails: details };

    case "INCONSISTENT":
      return { result: "MISMATCH", mismatchDetails: details };

    case "ACCEPTED":
      if (expected.lifecycleState === "CONFIRMED") return { result: "UPDATED", mismatchDetails: null };
      if (expected.lifecycleState === "SIMULATED_FILLED" && expected.filledAmountCents === (authoritative.filledAmountCents ?? null)) {
        return { result: "IN_SYNC", mismatchDetails: null };
      }
      return { result: "MISMATCH", mismatchDetails: details };

    case "REJECTED":
      if (expected.lifecycleState === "CONFIRMED") return { result: "UPDATED", mismatchDetails: null };
      if (expected.lifecycleState === "SIMULATED_REJECTED") return { result: "IN_SYNC", mismatchDetails: null };
      return { result: "MISMATCH", mismatchDetails: details };

    case "CANCELLED":
      if (expected.lifecycleState === "CONFIRMED") return { result: "UPDATED", mismatchDetails: null };
      if (expected.lifecycleState === "SIMULATED_REJECTED") return { result: "IN_SYNC", mismatchDetails: null };
      return { result: "MISMATCH", mismatchDetails: details };

    case "PARTIAL":
      if (expected.lifecycleState === "CONFIRMED") return { result: "UPDATED", mismatchDetails: null };
      if (expected.lifecycleState === "SIMULATED_FILLED" && expected.filledAmountCents === (authoritative.filledAmountCents ?? null)) {
        return { result: "IN_SYNC", mismatchDetails: null };
      }
      return { result: "MISMATCH", mismatchDetails: details };
  }
}

function statesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ReconcileInput {
  orderIntentId: string;
  correlationId: string | null;
  expected: ExpectedOrderState;
  stateSource: SimulatedProviderStateSource;
  manualReviewAfterMismatches: number;
  batchId?: string | null;
}

/**
 * Idempotent (STEP 24): if the latest existing record for this order
 * intent already reflects the identical authoritative state and result,
 * nothing new is written — no duplicate row, no duplicate audit event, and
 * the prior mismatch evidence (if any) is left exactly as it was. A
 * genuinely changed comparison always inserts a NEW row referencing the
 * prior one, never overwriting it.
 */
export async function reconcileOrderIntent(input: ReconcileInput): Promise<ReconciliationRecord> {
  await recordAuditEvent({ eventType: "RECONCILIATION_STARTED", correlationId: input.correlationId, orderIntentId: input.orderIntentId, severity: "INFO" });

  const authoritative = await input.stateSource.getAuthoritativeState(input.orderIntentId);
  const comparison = compareExpectedToAuthoritative(input.expected, authoritative);

  const latest = await getLatestReconciliationRecord(input.orderIntentId);
  const authoritativeAsRecord = authoritative as unknown as Record<string, unknown>;

  if (latest && latest.result === comparison.result && statesEqual(latest.authoritativeState, authoritativeAsRecord)) {
    // Genuinely unchanged since the last attempt — idempotent no-op.
    return latest;
  }

  let result = comparison.result;
  let mismatchDetails = comparison.mismatchDetails;
  if (result === "MISMATCH") {
    const trailing = await countTrailingMismatches(input.orderIntentId);
    if (trailing + 1 >= input.manualReviewAfterMismatches) {
      result = "MANUAL_REVIEW_REQUIRED";
      mismatchDetails = { ...mismatchDetails, escalatedAfterConsecutiveMismatches: trailing + 1 };
    }
  }

  const record = await insertReconciliationRecord({
    orderIntentId: input.orderIntentId,
    batchId: input.batchId ?? null,
    correlationId: input.correlationId,
    expectedState: input.expected as unknown as Record<string, unknown>,
    authoritativeState: authoritativeAsRecord,
    result,
    mismatchDetails,
    previousRecordId: latest?.id ?? null,
  });

  const severity = result === "MANUAL_REVIEW_REQUIRED" ? "CRITICAL" : result === "MISMATCH" ? "WARN" : "INFO";
  await recordAuditEvent({
    eventType: result === "MISMATCH" || result === "MANUAL_REVIEW_REQUIRED" ? "RECONCILIATION_MISMATCH" : "RECONCILIATION_COMPLETED",
    correlationId: input.correlationId,
    orderIntentId: input.orderIntentId,
    severity,
    metadata: { result },
  });

  return record;
}
