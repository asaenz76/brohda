import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReconciliationRecord, ReconciliationResult } from "../types";

// Milestone 5.5 — repository for execution_reconciliation_records
// (migration 20260101000155). Rows are never overwritten by application
// code once written — a changed comparison always inserts a new row
// chained via previous_record_id (STEP 24) — except resolved_at/
// resolved_by/resolution_note, which a human fills in later for a
// MANUAL_REVIEW_REQUIRED row.

interface ReconciliationRow {
  id: string;
  order_intent_id: string;
  batch_id: string | null;
  correlation_id: string | null;
  expected_state: Record<string, unknown>;
  authoritative_state: Record<string, unknown>;
  result: ReconciliationResult;
  mismatch_details: Record<string, unknown> | null;
  previous_record_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

function toDomain(row: ReconciliationRow): ReconciliationRecord {
  return {
    id: row.id,
    orderIntentId: row.order_intent_id,
    batchId: row.batch_id,
    correlationId: row.correlation_id,
    expectedState: row.expected_state,
    authoritativeState: row.authoritative_state,
    result: row.result,
    mismatchDetails: row.mismatch_details,
    previousRecordId: row.previous_record_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

export async function getLatestReconciliationRecord(orderIntentId: string): Promise<ReconciliationRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_reconciliation_records")
    .select("*")
    .eq("order_intent_id", orderIntentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as ReconciliationRow) : null;
}

/** Trailing MISMATCH records (most-recent-first, stopping at the first non-MISMATCH), for the manual-review escalation threshold. */
export async function countTrailingMismatches(orderIntentId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_reconciliation_records")
    .select("result")
    .eq("order_intent_id", orderIntentId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  let count = 0;
  for (const row of data as Array<{ result: ReconciliationResult }>) {
    if (row.result !== "MISMATCH") break;
    count += 1;
  }
  return count;
}

export interface InsertReconciliationRecordInput {
  orderIntentId: string;
  batchId: string | null;
  correlationId: string | null;
  expectedState: Record<string, unknown>;
  authoritativeState: Record<string, unknown>;
  result: ReconciliationResult;
  mismatchDetails: Record<string, unknown> | null;
  previousRecordId: string | null;
}

export async function insertReconciliationRecord(input: InsertReconciliationRecordInput): Promise<ReconciliationRecord> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_reconciliation_records")
    .insert({
      order_intent_id: input.orderIntentId,
      batch_id: input.batchId,
      correlation_id: input.correlationId,
      expected_state: input.expectedState,
      authoritative_state: input.authoritativeState,
      result: input.result,
      mismatch_details: input.mismatchDetails,
      previous_record_id: input.previousRecordId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toDomain(data as ReconciliationRow);
}

export async function listOpenMismatches(limit = 100): Promise<ReconciliationRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_reconciliation_records")
    .select("*")
    .in("result", ["MISMATCH", "MANUAL_REVIEW_REQUIRED"])
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as ReconciliationRow[]).map(toDomain);
}

export async function resolveReconciliationRecord(id: string, resolvedBy: string, note: string): Promise<ReconciliationRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_reconciliation_records")
    .update({ resolved_at: new Date().toISOString(), resolved_by: resolvedBy, resolution_note: note })
    .eq("id", id)
    .is("resolved_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as ReconciliationRow) : null;
}
