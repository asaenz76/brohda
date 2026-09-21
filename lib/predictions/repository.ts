import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  Prediction,
  PredictionLifecycleState,
  PredictionMarketStatusSnapshot,
  PredictionOutcome,
  PredictionResult,
} from "./types";

// Server-side read/write layer for the `predictions` table — the ONLY
// module allowed to query it directly, matching this codebase's existing
// one-repository-per-table convention (lib/prediction-markets/repository.ts,
// lib/prediction-markets/discovery/repository.ts). Uses the service-role
// admin client throughout: RLS on `predictions` grants `authenticated` a
// read-only policy on their own rows only (migration 20260101000141) —
// every write, and every read that needs to see across users (the grading
// job), goes through here instead.

interface PredictionRow {
  id: string;
  user_id: string;
  market_id: string;
  selected_outcome: PredictionOutcome;
  yes_probability_snapshot: number | string;
  no_probability_snapshot: number | string;
  market_question_snapshot: string;
  market_close_at_snapshot: string | null;
  market_status_snapshot: PredictionMarketStatusSnapshot;
  lifecycle_state: PredictionLifecycleState;
  result: PredictionResult | null;
  resolved_outcome_snapshot: PredictionOutcome | null;
  graded_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

function toDomain(row: PredictionRow): Prediction {
  return {
    id: row.id,
    userId: row.user_id,
    marketId: row.market_id,
    selectedOutcome: row.selected_outcome,
    yesProbabilitySnapshot: Number(row.yes_probability_snapshot),
    noProbabilitySnapshot: Number(row.no_probability_snapshot),
    marketQuestionSnapshot: row.market_question_snapshot,
    marketCloseAtSnapshot: row.market_close_at_snapshot,
    marketStatusSnapshot: row.market_status_snapshot,
    lifecycleState: row.lifecycle_state,
    result: row.result,
    resolvedOutcomeSnapshot: row.resolved_outcome_snapshot,
    gradedAt: row.graded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreatePredictionInput {
  userId: string;
  marketId: string;
  selectedOutcome: PredictionOutcome;
  yesProbabilitySnapshot: number;
  noProbabilitySnapshot: number;
  marketQuestionSnapshot: string;
  marketCloseAtSnapshot: string | null;
  marketStatusSnapshot: PredictionMarketStatusSnapshot;
  /** Client-generated, carried across retries — see docs/architecture/prediction-layer.md's mutation-safety section. */
  idempotencyKey: string;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * Idempotent create. Mirrors `create_pool_entry`'s own idempotency-key
 * pattern (pre-check, then insert, then a race-safe fallback on the unique
 * constraint) without needing a SECURITY DEFINER function — a plain
 * service-role insert is sufficient here since, unlike wallet debit +
 * entry creation, no other table needs to change atomically alongside this
 * one. Returns `{outcome: "existing"}` on a genuine replay (same key seen
 * before), never a duplicate row.
 */
export async function createPrediction(
  input: CreatePredictionInput,
): Promise<{ prediction: Prediction; outcome: "created" | "existing" }> {
  const admin = createAdminClient();

  const { data: existing, error: lookupError } = await admin
    .from("predictions")
    .select("*")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return { prediction: toDomain(existing as PredictionRow), outcome: "existing" };

  const { data: inserted, error } = await admin
    .from("predictions")
    .insert({
      user_id: input.userId,
      market_id: input.marketId,
      selected_outcome: input.selectedOutcome,
      yes_probability_snapshot: input.yesProbabilitySnapshot,
      no_probability_snapshot: input.noProbabilitySnapshot,
      market_question_snapshot: input.marketQuestionSnapshot,
      market_close_at_snapshot: input.marketCloseAtSnapshot,
      market_status_snapshot: input.marketStatusSnapshot,
      idempotency_key: input.idempotencyKey,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      // Lost the race against a concurrent identical-key retry — the other
      // request's row is the true result, not an error.
      const { data: raced, error: racedError } = await admin
        .from("predictions")
        .select("*")
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      if (racedError) throw racedError;
      return { prediction: toDomain(raced as PredictionRow), outcome: "existing" };
    }
    throw error;
  }

  return { prediction: toDomain(inserted as PredictionRow), outcome: "created" };
}

/** Most recent Prediction a user has made on a given market, if any — used for repeat-policy checks and market-detail display. */
export async function getLatestUserPredictionForMarket(userId: string, marketId: string): Promise<Prediction | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .eq("market_id", marketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as PredictionRow) : null;
}

/** A user's full Prediction history, most recent first — for the profile history surface. Defensive cap, not real pagination, matching the existing legacy predictions-tab precedent. */
export async function listUserPredictions(userId: string, limit = 50): Promise<Prediction[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as PredictionRow[]).map(toDomain);
}

/** Every still-ungraded Prediction, oldest first — the grading job's own work queue. Bounded, so one run never processes an unbounded backlog. */
export async function listPendingPredictions(limit = 200): Promise<Prediction[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predictions")
    .select("*")
    .eq("lifecycle_state", "PENDING")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data as PredictionRow[]).map(toDomain);
}

/**
 * The only mutation grading ever performs — one-way, PENDING to GRADED.
 * Guarded by `.eq("lifecycle_state", "PENDING")` in the update itself (not
 * just the caller's query), so a concurrent/duplicate grading pass over the
 * same row is a safe no-op (`data` comes back empty) rather than a second
 * write — belt-and-suspenders idempotency alongside the job's own
 * PENDING-only read query.
 */
export async function markPredictionGraded(
  id: string,
  outcome: { result: PredictionResult; resolvedOutcomeSnapshot: PredictionOutcome | null; gradedAt: string },
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("predictions")
    .update({
      lifecycle_state: "GRADED",
      result: outcome.result,
      resolved_outcome_snapshot: outcome.resolvedOutcomeSnapshot,
      graded_at: outcome.gradedAt,
      updated_at: outcome.gradedAt,
    })
    .eq("id", id)
    .eq("lifecycle_state", "PENDING")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
