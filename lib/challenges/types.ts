// Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges).
// A Challenge is a free, P2P, non-monetary disagreement between two
// existing, opposing Picks on the same Market — never a Comment, a
// Market, a Pick, or a Monetary Position (see
// docs/architecture/call-bs-challenges.md). This file defines the
// domain's own shape only.

import type { PredictionOutcome } from "@/lib/predictions/types";

export type ChallengeStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "RESOLVED";

/** Only meaningful once status = 'RESOLVED'. Derives deterministically from each Pick's own canonical grading — never computed independently. VOID means the Market/Pick never reached a trustworthy result; no winner, nothing to refund (R7 has no money). */
export type ChallengeResult = "CHALLENGER_WON" | "RECIPIENT_WON" | "VOID";

/**
 * The full domain record. Structural fields (challenger/recipient/Market/
 * both Pick identities/both selection snapshots) are immutable after
 * creation by any code path — enforced by RLS (no `authenticated` write
 * grant at all) and by the fact that only call_bs()/accept_call_bs()/
 * decline_call_bs() (service-role RPCs) ever write this table.
 */
export interface Challenge {
  id: string;
  /** Soft reference to markets.id — same durability reasoning as predictions.marketId. Immutable. */
  marketId: string;

  challengerUserId: string;
  recipientUserId: string;
  /** Real reference to predictions.id (never deleted). Immutable. */
  challengerPredictionId: string;
  /** Real reference to predictions.id (never deleted). Immutable. */
  recipientPredictionId: string;

  /** The challenger's selected outcome AT THE MOMENT this Challenge was created — never re-derived from the live, mutable predictions.selected_outcome later. Immutable. */
  challengerSelectionSnapshot: PredictionOutcome;
  /** Immutable. */
  recipientSelectionSnapshot: PredictionOutcome;

  status: ChallengeStatus;
  result: ChallengeResult | null;

  acceptedAt: string | null;
  declinedAt: string | null;
  resolvedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

/** Presentation-safe participant identity for the Post/Market "who picked what" surface (§42). Never private profile fields, wallet info, or email. */
export interface ChallengeParticipant {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  predictionId: string;
  selectedOutcome: PredictionOutcome;
  /** Whether the viewer could Call BS on this specific participant right now — server-derived (opposing viewer Pick exists, neither Pick graded, before cutoff, no existing PENDING pair between the two). Never inferred client-side. */
  canCallBs: boolean;
}

/** The purely factual head-to-head record a future R11 will consume (§38-39) — no scoring, no reputation, no streaks. */
export interface ChallengeRecord {
  wins: number;
  losses: number;
  voids: number;
}
