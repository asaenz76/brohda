import "server-only";
import { getPredictionById } from "@/lib/predictions/repository";
import { listUnresolvedAcceptedChallenges, markChallengeResolved } from "./repository";
import { createChallengeResolvedNotifications } from "@/lib/notifications/challenges";
import type { Prediction } from "@/lib/predictions/types";
import type { Challenge, ChallengeResult } from "./types";

/**
 * Milestone R7 (§33-39): "Market resolves -> Picks grade -> accepted
 * Challenges resolve." This module consumes grading truth; it never
 * creates it — nothing here writes to `predictions`, only reads. Mirrors
 * lib/predictions/grading.ts's own shape (a pure decision function plus a
 * separate, explicit run-the-job function) so Challenge resolution stays
 * unit-testable without a database, exactly like Pick grading.
 */

export type ChallengeResolutionDecision = { decision: "still-pending" } | { decision: "resolved"; result: ChallengeResult };

/**
 * The pure per-challenge resolution decision — no I/O. Both Picks must
 * already be GRADED (independently, by the existing Pick grading job) —
 * this function never grades anything itself. Opposing selections graded
 * against one deterministic Market outcome guarantee exactly one CORRECT
 * and one INCORRECT whenever neither is VOID; the final branch is a
 * defensive fallback for that structurally-should-be-unreachable case
 * (never silently declares a winner from an inconsistent pair).
 */
export function decideChallengeResolution(challenger: Prediction, recipient: Prediction): ChallengeResolutionDecision {
  if (challenger.lifecycleState !== "GRADED" || recipient.lifecycleState !== "GRADED") {
    return { decision: "still-pending" };
  }
  if (challenger.result === "VOID" || recipient.result === "VOID") {
    return { decision: "resolved", result: "VOID" };
  }
  if (challenger.result === "CORRECT" && recipient.result === "INCORRECT") {
    return { decision: "resolved", result: "CHALLENGER_WON" };
  }
  if (challenger.result === "INCORRECT" && recipient.result === "CORRECT") {
    return { decision: "resolved", result: "RECIPIENT_WON" };
  }
  // Structurally unreachable given opposing selections graded from one
  // deterministic outcome (both CORRECT or both INCORRECT can't happen) —
  // never fabricate a winner from data that doesn't support one.
  return { decision: "resolved", result: "VOID" };
}

export interface ChallengeResolutionRunSummary {
  examined: number;
  resolved: number;
  challengerWon: number;
  recipientWon: number;
  voided: number;
  stillPending: number;
  /** Milestone R13.5 — per-Challenge failure isolation, mirroring lib/predictions/grading.ts's own. One bad row never aborts the rest of the batch, and its failure is never silent. */
  failures: Array<{ challengeId: string; error: string }>;
}

/**
 * The resolution job itself — manual/developer invocation only
 * (scripts/resolve-challenges.ts), same as runGradingJob. Idempotent by
 * construction: only ever reads ACCEPTED Challenges, and
 * markChallengeResolved only writes rows still ACCEPTED at the moment of
 * its own UPDATE — running this twice grades nothing a second time, and
 * the notification (fired only on the pass that actually flips a row) can
 * never duplicate (§36).
 *
 * Deliberately a SEPARATE job from runGradingJob, not folded into it
 * (§35): Challenge resolution must run strictly after Pick grading (it
 * reads predictions.result, which grading itself produces), and keeping
 * them as two sequential, independently-idempotent steps is the smallest
 * architecture that can never make Challenge resolution responsible for
 * grading a Market.
 */
export async function resolveAcceptedChallenges(): Promise<ChallengeResolutionRunSummary> {
  const accepted = await listUnresolvedAcceptedChallenges();
  const summary: ChallengeResolutionRunSummary = { examined: 0, resolved: 0, challengerWon: 0, recipientWon: 0, voided: 0, stillPending: 0, failures: [] };

  for (const challenge of accepted) {
    summary.examined += 1;
    try {
      const [challengerPred, recipientPred] = await Promise.all([
        getPredictionById(challenge.challengerPredictionId),
        getPredictionById(challenge.recipientPredictionId),
      ]);

      // Both Picks are real, non-cascading FKs (never deleted) — a miss here
      // is a data anomaly, not a legitimate state. Left unresolved rather
      // than fabricating a result.
      if (challengerPred === null || recipientPred === null) {
        summary.stillPending += 1;
        continue;
      }

      const decision = decideChallengeResolution(challengerPred, recipientPred);
      if (decision.decision === "still-pending") {
        summary.stillPending += 1;
        continue;
      }

      const resolvedAt = new Date().toISOString();
      const applied = await markChallengeResolved(challenge.id, { result: decision.result, resolvedAt });
      // A concurrent run already resolved this exact row between our read
      // and write — safe no-op, not double-counted, no duplicate notification.
      if (!applied) continue;

      summary.resolved += 1;
      if (decision.result === "CHALLENGER_WON") summary.challengerWon += 1;
      else if (decision.result === "RECIPIENT_WON") summary.recipientWon += 1;
      else summary.voided += 1;

      await createChallengeResolvedNotifications({ challenge: { ...challenge, result: decision.result, resolvedAt, status: "RESOLVED" } as Challenge });
    } catch (error) {
      // Milestone R13.5 (§23, §26): one bad Challenge must not abort the
      // rest of an automated batch — left ACCEPTED for the next run.
      summary.failures.push({ challengeId: challenge.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return summary;
}
