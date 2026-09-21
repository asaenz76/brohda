import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ExecutionLimit, ExecutionLimitScope, ExecutionLimitType, ExecutionLimitViolation, LimitEvaluationResult } from "./types";

// Milestone 5.5 execution limits framework (STEP 12/13) — the smallest
// architecture that supports Milestone 6 without forcing a redesign. Usage
// is computed from `order_intents` (this codebase's own real record of
// simulated exposure) — never from the legacy `wallet_balances`/
// `wallet_transactions` ledger, which remains completely unrelated
// (docs/architecture/execution-architecture-gate.md §25/§26).
//
// TRUE INVARIANT (not configurable): only SIMULATED_FILLED order intents
// count toward usage — a rejected or still-pending attempt never
// represents real exposure. This is a domain fact about what "usage" means,
// not an operator knob; a future real-execution equivalent would count
// real Fills the same way.

interface LimitRow {
  id: string;
  scope: ExecutionLimitScope;
  target: string | null;
  limit_type: ExecutionLimitType;
  threshold_value: number;
  window_seconds: number | null;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toDomain(row: LimitRow): ExecutionLimit {
  return {
    id: row.id,
    scope: row.scope,
    target: row.target,
    limitType: row.limit_type,
    thresholdValue: row.threshold_value,
    windowSeconds: row.window_seconds,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAllLimits(): Promise<ExecutionLimit[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_limits").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data as LimitRow[]).map(toDomain);
}

async function listApplicableLimits(scope: ExecutionLimitScope, target: string | null): Promise<ExecutionLimit[]> {
  const admin = createAdminClient();
  const query = admin.from("execution_limits").select("*").eq("enabled", true).eq("scope", scope);
  const { data, error } = await (scope === "GLOBAL" ? query.is("target", null) : query.eq("target", target));
  if (error) throw error;
  return (data as LimitRow[]).map(toDomain);
}

export interface CreateLimitInput {
  scope: ExecutionLimitScope;
  target: string | null;
  limitType: ExecutionLimitType;
  thresholdValue: number;
  windowSeconds: number | null;
  createdBy: string;
}

export async function createLimit(input: CreateLimitInput): Promise<ExecutionLimit> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_limits")
    .insert({
      scope: input.scope,
      target: input.target,
      limit_type: input.limitType,
      threshold_value: input.thresholdValue,
      window_seconds: input.windowSeconds,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toDomain(data as LimitRow);
}

export async function setLimitEnabled(id: string, enabled: boolean): Promise<ExecutionLimit | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_limits").update({ enabled }).eq("id", id).select("*").maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as LimitRow) : null;
}

async function sumFilledAmountCents(userId: string, sinceIso: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("order_intents")
    .select("requested_amount_cents")
    .eq("user_id", userId)
    .eq("lifecycle_state", "SIMULATED_FILLED")
    .gte("confirmed_at", sinceIso);
  if (error) throw error;
  return (data as Array<{ requested_amount_cents: number }>).reduce((sum, row) => sum + row.requested_amount_cents, 0);
}

async function countFilledOrders(userId: string, sinceIso: string): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("order_intents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("lifecycle_state", "SIMULATED_FILLED")
    .gte("confirmed_at", sinceIso);
  if (error) throw error;
  return count ?? 0;
}

function startOfTodayIso(now: Date): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return start.toISOString();
}

export interface EvaluateLimitsInput {
  userId: string;
  cohortKeys: string[];
  provider: string;
  jurisdiction: string | null;
  requestedAmountCents: number;
  now: Date;
}

/**
 * Evaluates every enabled limit across every scope that applies to this
 * request (GLOBAL always applies; USER/COHORT/PROVIDER/JURISDICTION apply
 * when their target matches). A PER_ORDER limit needs no usage query at
 * all (the requested amount itself is the observed value); the other
 * types query `order_intents` for the relevant window.
 */
export async function evaluateExecutionLimits(input: EvaluateLimitsInput): Promise<LimitEvaluationResult> {
  const scopedTargets: Array<{ scope: ExecutionLimitScope; target: string | null }> = [
    { scope: "GLOBAL", target: null },
    { scope: "USER", target: input.userId },
    { scope: "PROVIDER", target: input.provider },
    ...(input.jurisdiction ? [{ scope: "JURISDICTION" as const, target: input.jurisdiction }] : []),
    ...input.cohortKeys.map((key) => ({ scope: "COHORT" as const, target: key })),
  ];

  const limitLists = await Promise.all(scopedTargets.map(({ scope, target }) => listApplicableLimits(scope, target)));
  const limits = limitLists.flat();
  if (limits.length === 0) return { allowed: true, violations: [] };

  const todayStartIso = startOfTodayIso(input.now);
  const violations: ExecutionLimitViolation[] = [];

  for (const limit of limits) {
    let observedValue: number;
    switch (limit.limitType) {
      case "PER_ORDER_AMOUNT_CENTS":
        observedValue = input.requestedAmountCents;
        break;
      case "DAILY_AMOUNT_CENTS":
        observedValue = (await sumFilledAmountCents(input.userId, todayStartIso)) + input.requestedAmountCents;
        break;
      case "ROLLING_AMOUNT_CENTS": {
        const sinceIso = new Date(input.now.getTime() - limit.windowSeconds! * 1000).toISOString();
        observedValue = (await sumFilledAmountCents(input.userId, sinceIso)) + input.requestedAmountCents;
        break;
      }
      case "DAILY_ORDER_COUNT":
        observedValue = (await countFilledOrders(input.userId, todayStartIso)) + 1;
        break;
    }

    if (observedValue > limit.thresholdValue) {
      violations.push({ limitId: limit.id, scope: limit.scope, limitType: limit.limitType, thresholdValue: limit.thresholdValue, observedValue });
    }
  }

  return { allowed: violations.length === 0, violations };
}
