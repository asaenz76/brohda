import { describe, expect, it } from "vitest";
import { decideChallengeResolution } from "@/lib/challenges/resolution";
import type { Prediction } from "@/lib/predictions/types";

/**
 * The pure per-Challenge resolution decision, in isolation from any
 * database — mirrors tests/unit/predictions/grading.test.ts's own shape.
 * Market resolves -> Picks grade (lib/predictions/grading.ts, unchanged) ->
 * accepted Challenges resolve (this module). Never constructs a raw Market
 * or fixture — only already-graded Prediction rows, proving this function
 * consumes grading truth rather than producing it.
 */

function prediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    id: "p1",
    userId: "u1",
    marketId: "m1",
    selectedOutcome: "YES",
    yesProbabilitySnapshot: 0.6,
    noProbabilitySnapshot: 0.4,
    marketQuestionSnapshot: "Will X happen?",
    marketCloseAtSnapshot: null,
    marketStatusSnapshot: "ACTIVE",
    lifecycleState: "PENDING",
    result: null,
    resolvedOutcomeSnapshot: null,
    gradedAt: null,
    lockedAt: null,
    lockReason: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("decideChallengeResolution", () => {
  it("stays pending while the challenger's Pick is not yet graded", () => {
    const challenger = prediction({ id: "c", lifecycleState: "PENDING" });
    const recipient = prediction({ id: "r", lifecycleState: "GRADED", result: "CORRECT" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "still-pending" });
  });

  it("stays pending while the recipient's Pick is not yet graded", () => {
    const challenger = prediction({ id: "c", lifecycleState: "GRADED", result: "CORRECT" });
    const recipient = prediction({ id: "r", lifecycleState: "PENDING" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "still-pending" });
  });

  it("the challenger wins when their Pick graded CORRECT and the recipient's graded INCORRECT", () => {
    const challenger = prediction({ id: "c", selectedOutcome: "YES", lifecycleState: "GRADED", result: "CORRECT" });
    const recipient = prediction({ id: "r", selectedOutcome: "NO", lifecycleState: "GRADED", result: "INCORRECT" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "resolved", result: "CHALLENGER_WON" });
  });

  it("the recipient wins when their Pick graded CORRECT and the challenger's graded INCORRECT", () => {
    const challenger = prediction({ id: "c", selectedOutcome: "YES", lifecycleState: "GRADED", result: "INCORRECT" });
    const recipient = prediction({ id: "r", selectedOutcome: "NO", lifecycleState: "GRADED", result: "CORRECT" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "resolved", result: "RECIPIENT_WON" });
  });

  it("resolves VOID when the challenger's Pick graded VOID", () => {
    const challenger = prediction({ id: "c", lifecycleState: "GRADED", result: "VOID" });
    const recipient = prediction({ id: "r", lifecycleState: "GRADED", result: "CORRECT" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "resolved", result: "VOID" });
  });

  it("resolves VOID when the recipient's Pick graded VOID", () => {
    const challenger = prediction({ id: "c", lifecycleState: "GRADED", result: "CORRECT" });
    const recipient = prediction({ id: "r", lifecycleState: "GRADED", result: "VOID" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "resolved", result: "VOID" });
  });

  it("resolves VOID when both Picks graded VOID", () => {
    const challenger = prediction({ id: "c", lifecycleState: "GRADED", result: "VOID" });
    const recipient = prediction({ id: "r", lifecycleState: "GRADED", result: "VOID" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "resolved", result: "VOID" });
  });

  it("never fabricates a winner from a structurally-inconsistent pair (defensive fallback)", () => {
    const challenger = prediction({ id: "c", lifecycleState: "GRADED", result: "CORRECT" });
    const recipient = prediction({ id: "r", lifecycleState: "GRADED", result: "CORRECT" });
    expect(decideChallengeResolution(challenger, recipient)).toEqual({ decision: "resolved", result: "VOID" });
  });
});
