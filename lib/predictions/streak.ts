import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Prediction, PredictionResult } from "./types";

/**
 * Milestone 3 final standing-rule remediation, Finding 2. The original
 * version of this module also maintained `current_streak`/`best_streak`
 * counters. On re-review, "streak" is not a factual aggregate the way
 * correct/incorrect counts are — it embeds real product-policy questions
 * this task's own instructions name explicitly: does CORRECT increment and
 * INCORRECT reset it (as opposed to, say, requiring N consecutive correct
 * before it "starts counting")? Does a VOID grading preserve the streak or
 * break it? Is the sequence ordered by when a Prediction was MADE or by
 * the order the grading job happened to process it (which can differ,
 * since grading runs in batches whenever a market resolves, not in the
 * order predictions were submitted)? Do repeated Predictions on the same
 * market (when `platform_settings.prediction_allow_repeat` is enabled)
 * count as separate streak events? None of these are "genuinely inherent
 * to the domain" — they are exactly the kind of founder-owned reputation
 * design decision `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 8
 * reserves for itself ("the exact reputation/difficulty-adjustment
 * algorithm... should not silently invent one without founder review").
 *
 * Per this remediation's own "prefer deferral" instruction: no current
 * Milestone 3 consumer feature genuinely NEEDED a streak number — it was
 * built because the original Milestone 3 task listed "current basic streak
 * if justified" as something Milestone 3 *may* expose, not something it
 * *must*. Deferred. This module now only records the two facts that
 * really are straightforward historical aggregates with no interpretive
 * policy: how many graded Predictions were correct, and how many were
 * incorrect.
 *
 * `user_profiles.prediction_current_streak`/`prediction_best_streak`
 * remain in the schema (migration 20260101000142) — per the roadmap's own
 * locked "additive migration before destructive migration, always"
 * principle, they are not dropped here. They are simply never written to
 * or read by any Milestone 3 code from this point on; they stay at their
 * default of 0 and are reserved for Milestone 8 to adopt (with a real,
 * founder-reviewed streak definition) or formally retire.
 */
export async function recordGradedPredictionResult(prediction: Prediction, result: Extract<PredictionResult, "CORRECT" | "INCORRECT">): Promise<void> {
  const admin = createAdminClient();
  const { data: profile, error: readError } = await admin
    .from("user_profiles")
    .select("prediction_correct_count, prediction_incorrect_count")
    .eq("id", prediction.userId)
    .single();
  if (readError) throw readError;

  const { error: writeError } = await admin
    .from("user_profiles")
    .update({
      prediction_correct_count: profile.prediction_correct_count + (result === "CORRECT" ? 1 : 0),
      prediction_incorrect_count: profile.prediction_incorrect_count + (result === "INCORRECT" ? 1 : 0),
    })
    .eq("id", prediction.userId);
  if (writeError) throw writeError;
}

export interface PredictionStats {
  correctCount: number;
  incorrectCount: number;
}

export async function getPredictionStats(userId: string): Promise<PredictionStats> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_profiles")
    .select("prediction_correct_count, prediction_incorrect_count")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return {
    correctCount: data.prediction_correct_count,
    incorrectCount: data.prediction_incorrect_count,
  };
}
