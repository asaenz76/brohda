import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ExecutionAuditEvent, ExecutionAuditEventType, ExecutionAuditSeverity } from "./types";

// Milestone 5.5 durable execution audit-event stream (STEP 17/18,
// migration 20260101000154). Append-only at the database level (service_role
// holds select+insert only — no update, no delete, from anywhere in this
// codebase). This module is the ONLY writer, and its redaction guard is the
// only thing standing between arbitrary caller metadata and the database —
// callers must never be trusted to have already sanitized their own input.

const SECRET_KEY_PATTERN = /key|secret|credential|signature|token|password|private/i;

/**
 * Recursively strips any object key whose name looks secret-shaped,
 * regardless of caller intent — defense in depth: no execution code path
 * should ever legitimately need to log a private key, Session Key, raw
 * credential, or signature (none of these exist in Milestone 5.5 at all),
 * but a future careless caller adding a field named `apiKey` or `signature`
 * for an unrelated reason must not silently reach durable storage.
 */
function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactMetadata(val, depth + 1);
  }
  return result;
}

export interface RecordAuditEventInput {
  eventType: ExecutionAuditEventType;
  correlationId?: string | null;
  actorUserId?: string | null;
  marketId?: string | null;
  quoteId?: string | null;
  orderIntentId?: string | null;
  provider?: string | null;
  severity?: ExecutionAuditSeverity;
  metadata?: Record<string, unknown>;
}

export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("execution_audit_events").insert({
    event_type: input.eventType,
    correlation_id: input.correlationId ?? null,
    actor_user_id: input.actorUserId ?? null,
    market_id: input.marketId ?? null,
    quote_id: input.quoteId ?? null,
    order_intent_id: input.orderIntentId ?? null,
    provider: input.provider ?? null,
    severity: input.severity ?? "INFO",
    metadata: redactMetadata(input.metadata ?? {}),
  });
  // A logging failure must never break the execution flow it's observing —
  // matching this codebase's own established convention elsewhere
  // (writeAuditLog callers already tolerate this class of failure being
  // surfaced, but the execution journey itself must not be blocked by an
  // audit-store outage). Swallowed, not silently ignored: surfaced to
  // stderr so it is at least visible in server logs.
  if (error) console.error("[execution] failed to record audit event:", input.eventType, error.message);
}

interface AuditEventRow {
  id: string;
  event_type: ExecutionAuditEventType;
  occurred_at: string;
  correlation_id: string | null;
  actor_user_id: string | null;
  market_id: string | null;
  quote_id: string | null;
  order_intent_id: string | null;
  provider: string | null;
  severity: ExecutionAuditSeverity;
  metadata: Record<string, unknown>;
}

function toDomain(row: AuditEventRow): ExecutionAuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    actorUserId: row.actor_user_id,
    marketId: row.market_id,
    quoteId: row.quote_id,
    orderIntentId: row.order_intent_id,
    provider: row.provider,
    severity: row.severity,
    metadata: row.metadata,
  };
}

export async function listRecentAuditEvents(limit = 100): Promise<ExecutionAuditEvent[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_audit_events").select("*").order("occurred_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as AuditEventRow[]).map(toDomain);
}

export async function listAuditEventsByCorrelationId(correlationId: string): Promise<ExecutionAuditEvent[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_audit_events").select("*").eq("correlation_id", correlationId).order("occurred_at", { ascending: true });
  if (error) throw error;
  return (data as AuditEventRow[]).map(toDomain);
}
