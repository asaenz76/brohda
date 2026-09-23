import "server-only";
import { getMarketById, type MarketRecord } from "@/lib/prediction-markets/repository";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";
import { maybeCreatePredictionGradedNotification } from "@/lib/notifications/predictions";
import { computeSportsMarketOutcome } from "./sports-resolution";
import { getFixtureForGrading, type FixtureForGrading } from "@/lib/sports-data/fixture-lookup";
import { listPendingPredictions, markPredictionGraded } from "./repository";
import type { Prediction, PredictionOutcome, PredictionResult } from "./types";

/**
 * Provider resolution -> normalized Market resolution -> Prediction grading.
 * This module never interprets a raw provider field directly.
 *
 * Two decision functions exist:
 * - `decideGrading` (legacy/generic path): reads `MarketRecord.status`/
 *   `resolvedOutcome` only. Kept for its still-correct ARCHIVED -> VOID rule
 *   and CORRECT/INCORRECT comparison logic, and for unit coverage of that
 *   boundary in isolation.
 * - `decideGradingForMarket` (Milestone R1, the one `runGradingJob` actually
 *   uses): every Market now belongs to a canonical Game
 *   (`fixture_id`/`market_template`, see
 *   supabase/migrations/20260101000148_market_game_foundation.sql), so the
 *   objective result is computed deterministically from that Game's final
 *   score (lib/predictions/sports-resolution.ts) rather than from the
 *   provider-pass-through `resolved_outcome` field.
 */

export type GradingDecision =
  | { decision: "still-pending" }
  | { decision: "graded"; result: PredictionResult; resolvedOutcomeSnapshot: PredictionOutcome | null };

/**
 * The pure per-prediction grading decision — no I/O, so the whole rule is
 * unit-testable with an explicit MarketRecord and selected outcome.
 *
 * - Market not found: caller's problem (data anomaly) — left PENDING.
 * - Market not yet RESOLVED (still ACTIVE/CLOSED): still PENDING — never
 *   fabricate a result.
 * - Market RESOLVED: compare `selectedOutcome` to the market's resolved
 *   outcome -> CORRECT/INCORRECT.
 * - Market ARCHIVED (Milestone 1's most terminal status, "read-only, no
 *   updates" per the provider's own docs) without ever having resolved:
 *   VOID — the one case grading treats as permanently undecidable rather
 *   than leaving a Prediction PENDING forever (see
 *   docs/architecture/prediction-layer.md's grading-architecture section).
 *   A merely INACTIVE market (not terminal) is left PENDING, never VOIDed
 *   prematurely.
 */
export function decideGrading(market: MarketRecord | null, selectedOutcome: PredictionOutcome): GradingDecision {
  if (market === null) return { decision: "still-pending" };

  if (market.status === "ARCHIVED") {
    return { decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null };
  }

  const consumerStatus = deriveConsumerStatus(market.status, market.resolvedOutcome);
  if (consumerStatus !== "RESOLVED") return { decision: "still-pending" };

  // deriveConsumerStatus only returns RESOLVED when resolvedOutcome is
  // genuinely non-null (its own contract) — this cast documents that
  // guarantee rather than re-deriving it.
  const resolvedOutcome = market.resolvedOutcome as PredictionOutcome;
  const result: PredictionResult = resolvedOutcome === selectedOutcome ? "CORRECT" : "INCORRECT";
  return { decision: "graded", result, resolvedOutcomeSnapshot: resolvedOutcome };
}

/**
 * Milestone R1 (docs/BROHDA_2_0_MILESTONE_MAP.md) grading entry point: every
 * Market now carries a canonical Game (fixture_id/market_template are NOT
 * NULL — supabase/migrations/20260101000148_market_game_foundation.sql), so
 * the objective result is computed from that Game's final score
 * (lib/predictions/sports-resolution.ts), never from the legacy
 * `resolved_outcome` pass-through field. `decideGrading` above is preserved
 * unchanged (and still covers the shared ARCHIVED -> VOID rule, reused
 * here) rather than deleted, since it remains the correct, tested
 * description of that one shared boundary case and of the
 * resolvedOutcome-based comparison this function's own sports path mirrors.
 *
 * `fixture` is passed in explicitly (never fetched by this function) so the
 * decision itself stays pure and unit-testable without a database — see
 * tests/unit/predictions/grading.test.ts and
 * tests/unit/predictions/sports-resolution.test.ts. `runGradingJob` below is
 * the only caller that performs the actual fixture lookup.
 */
export function decideGradingForMarket(market: MarketRecord | null, fixture: FixtureForGrading | null, selectedOutcome: PredictionOutcome): GradingDecision {
  if (market === null) return { decision: "still-pending" };
  if (market.status === "ARCHIVED") {
    return { decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null };
  }
  // A fixture lookup miss is a data anomaly (fixture_id is a real,
  // non-nullable FK) — never fabricate a result over it.
  if (fixture === null) return { decision: "still-pending" };

  const outcome = computeSportsMarketOutcome({ marketTemplate: market.marketTemplate, lineValue: market.lineValue, yesSide: market.yesSide }, fixture);

  if (outcome === "PENDING") return { decision: "still-pending" };
  if (outcome === "VOID") return { decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null };

  const result: PredictionResult = outcome === selectedOutcome ? "CORRECT" : "INCORRECT";
  return { decision: "graded", result, resolvedOutcomeSnapshot: outcome };
}

export interface GradingRunSummary {
  examined: number;
  graded: number;
  correct: number;
  incorrect: number;
  voided: number;
  stillPending: number;
  /** Milestone R13.5 — per-Prediction failure isolation, mirroring lib/prediction-markets/ingestion/nfl.ts's own established shape. One bad row never aborts the rest of the batch, and its failure is never silent. */
  failures: Array<{ predictionId: string; error: string }>;
}

/**
 * The grading job itself (roadmap STEP 20) — manual/developer invocation
 * only (scripts/grade-predictions.ts). Idempotent by construction: it only
 * ever reads PENDING predictions, and `markPredictionGraded` only writes
 * rows still in PENDING state at the moment of its own UPDATE — running
 * this twice in a row grades nothing the second time, and the notification
 * (called only on the same pass that flips a row) can never duplicate.
 *
 * Correction/reversal limitation (roadmap STEP 21, documented explicitly
 * rather than engineered around): once a Prediction is GRADED, this job
 * never revisits it, even if a market's resolved outcome later changes
 * (e.g. a provider correction re-ingested). This preserves history
 * immutability at the cost of not handling that rare case — see
 * docs/architecture/prediction-layer.md.
 *
 * `resultRecorder` (Milestone 3 final standing-rule remediation, Finding
 * 2): records only the factual correct/incorrect count — no streak
 * semantics. See lib/predictions/streak.ts's own comment for why streak
 * behavior was deferred to roadmap Milestone 8 rather than kept here.
 *
 * Notification policy (Milestone 3 final notification-policy remediation):
 * grading always persists the result and updates the factual aggregates
 * first — `maybeCreatePredictionGradedNotification` runs last, consults
 * configurable policy (lib/predictions/policy.ts's
 * getPredictionNotificationPolicy/shouldNotifyForResult), and never throws
 * — a notification-policy failure or a notification-send failure can
 * never undo or fail the grading step that already happened above it.
 * Policy changes are never applied retroactively: this job only ever
 * reaches this line once per row, at the moment that row transitions
 * PENDING to GRADED — a later policy change cannot cause a re-notify for
 * an already-graded Prediction, since grading never revisits it (same
 * idempotency guarantee as the correction/reversal limitation above).
 */
export async function runGradingJob(
  resultRecorder: (prediction: Prediction, result: Extract<PredictionResult, "CORRECT" | "INCORRECT">) => Promise<void>,
): Promise<GradingRunSummary> {
  const pending = await listPendingPredictions();
  const summary: GradingRunSummary = { examined: 0, graded: 0, correct: 0, incorrect: 0, voided: 0, stillPending: 0, failures: [] };

  for (const prediction of pending) {
    summary.examined += 1;
    try {
      const market = await getMarketById(prediction.marketId);
      // ARCHIVED short-circuits before any fixture lookup — an archived
      // market is VOID regardless of its Game's state, and never needs one.
      const fixture = market !== null && market.status !== "ARCHIVED" ? await getFixtureForGrading(market.fixtureId) : null;
      const decision = decideGradingForMarket(market, fixture, prediction.selectedOutcome);

      if (decision.decision === "still-pending") {
        summary.stillPending += 1;
        continue;
      }

      const gradedAt = new Date().toISOString();
      const applied = await markPredictionGraded(prediction.id, {
        result: decision.result,
        resolvedOutcomeSnapshot: decision.resolvedOutcomeSnapshot,
        gradedAt,
      });
      // A concurrent run already graded this exact row between our read and
      // write — safe no-op, not double-counted.
      if (!applied) continue;

      summary.graded += 1;
      if (decision.result === "CORRECT") summary.correct += 1;
      else if (decision.result === "INCORRECT") summary.incorrect += 1;
      else summary.voided += 1;

      if (decision.result === "CORRECT" || decision.result === "INCORRECT") {
        await resultRecorder(prediction, decision.result);
      }

      await maybeCreatePredictionGradedNotification({
        userId: prediction.userId,
        predictionId: prediction.id,
        questionSnapshot: prediction.marketQuestionSnapshot,
        result: decision.result,
      });
    } catch (error) {
      // Milestone R13.5 (§22, §26): one bad Prediction must not abort the
      // rest of an automated batch. Grading itself is a single row-scoped
      // write (markPredictionGraded), so a failure here never leaves that
      // one row partially graded — it's simply left PENDING for the next
      // run, exactly like a still-pending decision.
      summary.failures.push({ predictionId: prediction.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return summary;
}
