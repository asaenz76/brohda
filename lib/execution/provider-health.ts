import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CircuitBreakerPolicy, CircuitBreakerState, ProviderHealthRecord, ProviderHealthStatus } from "./types";

// Milestone 5.5 provider-neutral provider-health / circuit-breaker
// framework (STEP 14/15). One row per provider (migration
// 20260101000154) is both the circuit breaker's persisted state and the
// manual-override record — combining them avoids splitting one operational
// concept ("is this provider safe to call right now") across two tables.
//
// Exercised in Milestone 5.5 only against read-only quote/order-book
// requests (lib/execution/providers/polymarket/adapter.ts) and simulated
// reconciliation operations — never a real provider mutation, because none
// exists.

interface ProviderHealthRow {
  provider: string;
  circuit_state: CircuitBreakerState;
  consecutive_failures: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  opened_at: string | null;
  half_open_probe_at: string | null;
  manually_disabled: boolean;
  manual_reason: string | null;
  manual_set_by: string | null;
  manual_set_at: string | null;
  updated_at: string;
}

function toDomain(row: ProviderHealthRow): ProviderHealthRecord {
  return {
    provider: row.provider,
    circuitState: row.circuit_state,
    consecutiveFailures: row.consecutive_failures,
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at,
    openedAt: row.opened_at,
    halfOpenProbeAt: row.half_open_probe_at,
    manuallyDisabled: row.manually_disabled,
    manualReason: row.manual_reason,
    manualSetBy: row.manual_set_by,
    manualSetAt: row.manual_set_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_RECORD: Omit<ProviderHealthRecord, "provider"> = {
  circuitState: "CLOSED",
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  openedAt: null,
  halfOpenProbeAt: null,
  manuallyDisabled: false,
  manualReason: null,
  manualSetBy: null,
  manualSetAt: null,
  updatedAt: new Date(0).toISOString(),
};

export async function getProviderHealth(provider: string): Promise<ProviderHealthRecord> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_provider_health").select("*").eq("provider", provider).maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as ProviderHealthRow) : { provider, ...DEFAULT_RECORD };
}

export async function listAllProviderHealth(): Promise<ProviderHealthRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_provider_health").select("*").order("provider");
  if (error) throw error;
  return (data as ProviderHealthRow[]).map(toDomain);
}

/** Pure — derives the operator-facing status from the persisted state. No I/O. */
export function deriveProviderHealthStatus(record: ProviderHealthRecord): ProviderHealthStatus {
  if (record.manuallyDisabled) return "MANUALLY_DISABLED";
  if (record.circuitState === "OPEN") return "UNAVAILABLE";
  if (record.circuitState === "HALF_OPEN") return "DEGRADED";
  return "HEALTHY";
}

/**
 * Pure decision: may a call to this provider be attempted right now? Also
 * returns the state the breaker should transition to first (OPEN ->
 * HALF_OPEN once the cooldown has elapsed) — the caller persists that
 * transition via `recordProbeStarted` before actually attempting the call,
 * so a HALF_OPEN probe is never issued twice concurrently by two racing
 * requests without at least the first one's transition being visible.
 */
export function decideCallAllowed(record: ProviderHealthRecord, now: Date): { allowed: boolean; transitionToHalfOpen: boolean } {
  if (record.manuallyDisabled) return { allowed: false, transitionToHalfOpen: false };
  if (record.circuitState === "CLOSED" || record.circuitState === "HALF_OPEN") return { allowed: true, transitionToHalfOpen: false };
  // OPEN
  const cooldownElapsed = record.halfOpenProbeAt !== null && now.getTime() >= new Date(record.halfOpenProbeAt).getTime();
  return { allowed: cooldownElapsed, transitionToHalfOpen: cooldownElapsed };
}

async function upsertProviderHealth(provider: string, patch: Partial<ProviderHealthRow>): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("execution_provider_health").upsert({ provider, ...patch }, { onConflict: "provider" });
  if (error) throw error;
}

/**
 * Checks whether a call is currently allowed, applying the OPEN ->
 * HALF_OPEN cooldown transition first if applicable. Callers should call
 * this immediately before attempting a provider read, then
 * `recordProviderSuccess`/`recordProviderFailure` immediately after.
 */
export async function isProviderCallAllowed(provider: string, now: Date = new Date()): Promise<boolean> {
  const record = await getProviderHealth(provider);
  const decision = decideCallAllowed(record, now);
  if (decision.transitionToHalfOpen) {
    await upsertProviderHealth(provider, { circuit_state: "HALF_OPEN" });
  }
  return decision.allowed;
}

export async function recordProviderSuccess(provider: string, now: Date = new Date()): Promise<void> {
  await upsertProviderHealth(provider, {
    circuit_state: "CLOSED",
    consecutive_failures: 0,
    last_success_at: now.toISOString(),
    opened_at: null,
    half_open_probe_at: null,
  });
}

export async function recordProviderFailure(provider: string, policy: CircuitBreakerPolicy, now: Date = new Date()): Promise<void> {
  const record = await getProviderHealth(provider);

  // A failure while HALF_OPEN immediately re-opens (a probe failed) rather
  // than requiring the full failure threshold again — a single bad probe
  // is sufficient evidence the provider is still unhealthy.
  if (record.circuitState === "HALF_OPEN") {
    await upsertProviderHealth(provider, {
      circuit_state: "OPEN",
      consecutive_failures: record.consecutiveFailures + 1,
      last_failure_at: now.toISOString(),
      opened_at: now.toISOString(),
      half_open_probe_at: new Date(now.getTime() + policy.cooldownSeconds * 1000).toISOString(),
    });
    return;
  }

  const withinWindow = record.lastFailureAt !== null && now.getTime() - new Date(record.lastFailureAt).getTime() <= policy.observationWindowSeconds * 1000;
  const consecutiveFailures = (withinWindow ? record.consecutiveFailures : 0) + 1;

  if (consecutiveFailures >= policy.failureThreshold) {
    await upsertProviderHealth(provider, {
      circuit_state: "OPEN",
      consecutive_failures: consecutiveFailures,
      last_failure_at: now.toISOString(),
      opened_at: now.toISOString(),
      half_open_probe_at: new Date(now.getTime() + policy.cooldownSeconds * 1000).toISOString(),
    });
  } else {
    await upsertProviderHealth(provider, { consecutive_failures: consecutiveFailures, last_failure_at: now.toISOString() });
  }
}

export interface SetManualOverrideInput {
  provider: string;
  disabled: boolean;
  reason: string | null;
  setBy: string;
}

export async function setManualProviderOverride(input: SetManualOverrideInput): Promise<void> {
  await upsertProviderHealth(input.provider, {
    manually_disabled: input.disabled,
    manual_reason: input.disabled ? input.reason : null,
    manual_set_by: input.disabled ? input.setBy : null,
    manual_set_at: input.disabled ? new Date().toISOString() : null,
  });
}
