import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ExecutionQuote, ExecutionSide, OrderIntent, OrderIntentLifecycleState, OrderIntentRejectionReason } from "./types";

// Server-side read/write layer for `execution_quotes`/`order_intents` — the
// ONLY module allowed to query them directly, matching this codebase's
// established one-repository-per-table convention. Service-role only: RLS
// grants `authenticated` a read-only policy on their own rows (migration
// 20260101000148).

interface QuoteRow {
  id: string;
  user_id: string;
  market_id: string;
  selected_side: ExecutionSide;
  requested_amount_cents: number;
  current_price: number | string;
  effective_price: number | string;
  estimated_units: number | string;
  estimated_gross_return_cents: number;
  provider_fee_estimate_cents: number;
  brohda_fee_estimate_cents: number;
  total_fee_estimate_cents: number;
  estimated_slippage_bps: number;
  provider_snapshot_at: string;
  expires_at: string;
  is_simulated: true;
  created_at: string;
  correlation_id: string;
}

function quoteToDomain(row: QuoteRow): ExecutionQuote {
  return {
    id: row.id,
    userId: row.user_id,
    marketId: row.market_id,
    selectedSide: row.selected_side,
    requestedAmountCents: row.requested_amount_cents,
    currentPrice: Number(row.current_price),
    effectivePrice: Number(row.effective_price),
    estimatedUnits: Number(row.estimated_units),
    estimatedGrossReturnCents: row.estimated_gross_return_cents,
    providerFeeEstimateCents: row.provider_fee_estimate_cents,
    brohdaFeeEstimateCents: row.brohda_fee_estimate_cents,
    totalFeeEstimateCents: row.total_fee_estimate_cents,
    estimatedSlippageBps: row.estimated_slippage_bps,
    providerSnapshotAt: row.provider_snapshot_at,
    expiresAt: row.expires_at,
    isSimulated: true,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
  };
}

export interface CreateQuoteInput {
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
  correlationId: string;
}

export async function createQuote(input: CreateQuoteInput): Promise<ExecutionQuote> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_quotes")
    .insert({
      user_id: input.userId,
      market_id: input.marketId,
      selected_side: input.selectedSide,
      requested_amount_cents: input.requestedAmountCents,
      current_price: input.currentPrice,
      effective_price: input.effectivePrice,
      estimated_units: input.estimatedUnits,
      estimated_gross_return_cents: input.estimatedGrossReturnCents,
      provider_fee_estimate_cents: input.providerFeeEstimateCents,
      brohda_fee_estimate_cents: input.brohdaFeeEstimateCents,
      total_fee_estimate_cents: input.totalFeeEstimateCents,
      estimated_slippage_bps: input.estimatedSlippageBps,
      provider_snapshot_at: input.providerSnapshotAt,
      expires_at: input.expiresAt,
      correlation_id: input.correlationId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return quoteToDomain(data as QuoteRow);
}

export async function getQuoteById(id: string): Promise<ExecutionQuote | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_quotes").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? quoteToDomain(data as QuoteRow) : null;
}

interface OrderIntentRow {
  id: string;
  user_id: string;
  market_id: string;
  quote_id: string;
  selected_side: ExecutionSide;
  requested_amount_cents: number;
  quoted_effective_price: number | string;
  quoted_estimated_gross_return_cents: number;
  quoted_total_fee_estimate_cents: number;
  quoted_slippage_bps: number;
  quote_created_at: string;
  quote_provider_snapshot_at: string;
  confirmed_at: string;
  lifecycle_state: OrderIntentLifecycleState;
  result_reason: OrderIntentRejectionReason | null;
  resolved_at: string | null;
  idempotency_key: string;
  is_simulated: true;
  created_at: string;
  correlation_id: string;
}

function orderIntentToDomain(row: OrderIntentRow): OrderIntent {
  return {
    id: row.id,
    userId: row.user_id,
    marketId: row.market_id,
    quoteId: row.quote_id,
    selectedSide: row.selected_side,
    requestedAmountCents: row.requested_amount_cents,
    quotedEffectivePrice: Number(row.quoted_effective_price),
    quotedEstimatedGrossReturnCents: row.quoted_estimated_gross_return_cents,
    quotedTotalFeeEstimateCents: row.quoted_total_fee_estimate_cents,
    quotedSlippageBps: row.quoted_slippage_bps,
    quoteCreatedAt: row.quote_created_at,
    quoteProviderSnapshotAt: row.quote_provider_snapshot_at,
    confirmedAt: row.confirmed_at,
    lifecycleState: row.lifecycle_state,
    resultReason: row.result_reason,
    resolvedAt: row.resolved_at,
    isSimulated: true,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
  };
}

export interface CreateOrderIntentInput {
  userId: string;
  marketId: string;
  quoteId: string;
  selectedSide: ExecutionSide;
  requestedAmountCents: number;
  quotedEffectivePrice: number;
  quotedEstimatedGrossReturnCents: number;
  quotedTotalFeeEstimateCents: number;
  quotedSlippageBps: number;
  quoteCreatedAt: string;
  quoteProviderSnapshotAt: string;
  idempotencyKey: string;
  correlationId: string;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * Idempotent create, directly mirroring lib/predictions/repository.ts's
 * createPrediction (pre-check, insert, race-safe fallback on the unique
 * constraint) — no SECURITY DEFINER function needed, same reasoning: no
 * other table needs to change atomically alongside this one in Milestone 5.
 */
export async function createOrderIntent(input: CreateOrderIntentInput): Promise<{ orderIntent: OrderIntent; outcome: "created" | "existing" }> {
  const admin = createAdminClient();

  const { data: existing, error: lookupError } = await admin
    .from("order_intents")
    .select("*")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return { orderIntent: orderIntentToDomain(existing as OrderIntentRow), outcome: "existing" };

  const { data: inserted, error } = await admin
    .from("order_intents")
    .insert({
      user_id: input.userId,
      market_id: input.marketId,
      quote_id: input.quoteId,
      selected_side: input.selectedSide,
      requested_amount_cents: input.requestedAmountCents,
      quoted_effective_price: input.quotedEffectivePrice,
      quoted_estimated_gross_return_cents: input.quotedEstimatedGrossReturnCents,
      quoted_total_fee_estimate_cents: input.quotedTotalFeeEstimateCents,
      quoted_slippage_bps: input.quotedSlippageBps,
      quote_created_at: input.quoteCreatedAt,
      quote_provider_snapshot_at: input.quoteProviderSnapshotAt,
      idempotency_key: input.idempotencyKey,
      correlation_id: input.correlationId,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      const { data: raced, error: racedError } = await admin
        .from("order_intents")
        .select("*")
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      if (racedError) throw racedError;
      return { orderIntent: orderIntentToDomain(raced as OrderIntentRow), outcome: "existing" };
    }
    throw error;
  }

  return { orderIntent: orderIntentToDomain(inserted as OrderIntentRow), outcome: "created" };
}

/**
 * The one-way CONFIRMED -> terminal transition, decided synchronously in
 * the same request (no async provider round-trip exists in Milestone 5).
 * Guarded by `.eq("lifecycle_state", "CONFIRMED")` so this can never
 * re-resolve an already-terminal row.
 */
export async function resolveOrderIntent(
  id: string,
  outcome: { lifecycleState: "SIMULATED_FILLED" | "SIMULATED_REJECTED"; resultReason: OrderIntentRejectionReason | null; resolvedAt: string },
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("order_intents")
    .update({ lifecycle_state: outcome.lifecycleState, result_reason: outcome.resultReason, resolved_at: outcome.resolvedAt })
    .eq("id", id)
    .eq("lifecycle_state", "CONFIRMED")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function listUserOrderIntents(userId: string, limit = 50): Promise<OrderIntent[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("order_intents")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as OrderIntentRow[]).map(orderIntentToDomain);
}
