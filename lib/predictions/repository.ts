import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  Prediction,
  PredictionLifecycleState,
  PredictionLockReason,
  PredictionMarketStatusSnapshot,
  PredictionOutcome,
  PredictionResult,
  PredictionRevision,
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
  locked_at: string | null;
  lock_reason: PredictionLockReason | null;
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
    lockedAt: row.locked_at,
    lockReason: row.lock_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Milestone R5 (docs/BROHDA_2_0_MILESTONE_MAP.md, Pick Editing + Locking):
// the pre-R5 createPrediction() — a plain idempotent insert, no editing,
// no locking — was removed here. It is fully superseded by setPick()
// below, which subsumes its idempotency-key-replay behavior and adds
// create-or-edit-or-reject semantics on top. It was not merely deprecated
// in place: once lib/actions/predictions.ts switched to setPick(), it had
// zero remaining callers, and its own idempotency handling covered only
// the idempotency_key unique constraint — calling it twice for the same
// (user_id, market_id) with different keys would have thrown an unhandled
// conflict against R5's new predictions_one_per_user_market constraint.
// Keeping genuinely dead, newly-unsafe code around had no upside.

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

/** A single Prediction by id — used by Milestone R7's Challenge resolution (lib/challenges/resolution.ts), which needs to read the current graded state of two specific Picks, not a user's own latest one. */
export async function getPredictionById(id: string): Promise<Prediction | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("predictions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as PredictionRow) : null;
}

/**
 * Every still-ungraded Prediction, oldest first — the grading job's own
 * work queue. Bounded, so one run never processes an unbounded backlog.
 *
 * Milestone R13.5: `platform_settings.grading_batch_size` (default 200,
 * matching this function's own former hard-coded default exactly) is the
 * canonical source, live-read on every call, changeable by an operator
 * with no deployment — same pattern R12 already established for
 * `listSettlementEligiblePositionIds()`. An explicit `limit` argument
 * still overrides it (used by tests that need a smaller, deterministic
 * batch).
 */
export async function listPendingPredictions(limit?: number): Promise<Prediction[]> {
  const admin = createAdminClient();
  let effectiveLimit: number = limit ?? 200;
  if (limit === undefined) {
    const { data: settingsRow } = await admin.from("platform_settings").select("grading_batch_size").eq("id", true).single();
    effectiveLimit = settingsRow?.grading_batch_size ?? 200;
  }
  const { data, error } = await admin
    .from("predictions")
    .select("*")
    .eq("lifecycle_state", "PENDING")
    .order("created_at", { ascending: true })
    .limit(effectiveLimit);
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
export interface SetPickInput {
  userId: string;
  marketId: string;
  selectedOutcome: PredictionOutcome;
  yesProbability: number;
  noProbability: number;
  marketQuestionSnapshot: string;
  marketCloseAtSnapshot: string | null;
  marketStatusSnapshot: PredictionMarketStatusSnapshot;
  idempotencyKey: string;
}

export type SetPickOutcome = "created" | "updated" | "unchanged" | "replayed" | "rejected_cutoff" | "rejected_game_closed" | "rejected_locked";

export interface SetPickResult {
  prediction: Prediction | null;
  outcome: SetPickOutcome;
}

interface SetPickRpcRow {
  prediction: PredictionRow | null;
  outcome: SetPickOutcome;
}

/**
 * Milestone R5's single coherent create-or-edit-or-reject domain operation
 * (§25) — the server decides create vs. update vs. no-op vs. reject; the
 * caller never has to. Wraps the `set_pick` SQL function (see
 * supabase/migrations/20260101000152_pick_editing_and_locking.sql for the
 * full concurrency/locking rationale — this is intentionally an RPC, not a
 * plain table write, because it needs SELECT ... FOR UPDATE row-locking
 * and an authoritative in-transaction re-read of the Game's live
 * kickoff/status, which a multi-round-trip JS implementation cannot give
 * the same race-safety guarantee for (§27-29).
 */
export async function setPick(input: SetPickInput): Promise<SetPickResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("set_pick", {
      p_user_id: input.userId,
      p_market_id: input.marketId,
      p_selected_outcome: input.selectedOutcome,
      p_yes_probability: input.yesProbability,
      p_no_probability: input.noProbability,
      p_market_question: input.marketQuestionSnapshot,
      p_market_close_at: input.marketCloseAtSnapshot,
      p_market_status: input.marketStatusSnapshot,
      p_idempotency_key: input.idempotencyKey,
    })
    .single();
  if (error) throw error;

  const row = data as SetPickRpcRow;
  return { prediction: row.prediction ? toDomain(row.prediction) : null, outcome: row.outcome };
}

interface PredictionRevisionRow {
  id: string;
  prediction_id: string;
  user_id: string;
  previous_selected_outcome: PredictionOutcome;
  previous_probability_snapshot: number | string;
  new_selected_outcome: PredictionOutcome;
  new_probability_snapshot: number | string;
  changed_at: string;
}

function toRevisionDomain(row: PredictionRevisionRow): PredictionRevision {
  return {
    id: row.id,
    predictionId: row.prediction_id,
    userId: row.user_id,
    previousSelectedOutcome: row.previous_selected_outcome,
    previousProbabilitySnapshot: Number(row.previous_probability_snapshot),
    newSelectedOutcome: row.new_selected_outcome,
    newProbabilitySnapshot: Number(row.new_probability_snapshot),
    changedAt: row.changed_at,
  };
}

/** A Pick's full change history, oldest first — audit/history surface only; grading and current-state reads never consult this. */
export async function listPredictionRevisions(predictionId: string): Promise<PredictionRevision[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("prediction_revisions").select("*").eq("prediction_id", predictionId).order("changed_at", { ascending: true });
  if (error) throw error;
  return (data as PredictionRevisionRow[]).map(toRevisionDomain);
}

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
