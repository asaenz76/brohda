// Milestone R9 (docs/BROHDA_2_0_MILESTONE_MAP.md, Monetary Challenge +
// Position). A monetary proposal is a negotiation/offer — the economic
// counterpart to R7's free Challenge, never the free Challenge itself
// (see docs/architecture/monetary-challenge-position.md). A Position is
// the committed bilateral economic contract a proposal's acceptance
// produces — never a Comment, a Market, a Pick, or a free Challenge.

import type { PredictionOutcome } from "@/lib/predictions/types";

export type MonetaryProposalStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "WITHDRAWN";

/**
 * The full domain record. Structural fields (proposer/recipient/Market/
 * both Pick identities/both selection snapshots/stake/source Challenge)
 * are immutable after creation — enforced by RLS (no `authenticated`
 * write grant at all) and by the fact that only propose_money()/
 * accept_monetary_proposal()/decline_monetary_proposal()/
 * withdraw_monetary_proposal() (service-role RPCs) ever write this table.
 */
export interface MonetaryProposal {
  id: string;
  /** Soft reference to markets.id — same durability reasoning as predictions.marketId/challenges.marketId. Immutable. */
  marketId: string;

  proposerUserId: string;
  recipientUserId: string;
  /** Real reference to predictions.id. Immutable. */
  proposerPredictionId: string;
  /** Real reference to predictions.id. Immutable. */
  recipientPredictionId: string;

  /** The proposer's selected outcome AT THE MOMENT this proposal was created — never re-derived from the live, mutable predictions.selected_outcome later. Immutable. */
  proposerSelectionSnapshot: PredictionOutcome;
  /** Immutable. */
  recipientSelectionSnapshot: PredictionOutcome;

  /** Equal-stake model (§19) — cents, positive. Immutable. */
  stake: number;

  /** The free Challenge this proposal escalated, if any (§10-11). Never required. Immutable. */
  sourceChallengeId: string | null;

  /** The proposer's funds, held from the moment this proposal exists. Immutable reference — which reservation this is never changes, though the reservation's own status does. */
  proposerReservationId: string;

  status: MonetaryProposalStatus;
  /** Set only once ACCEPTED — the Position this proposal produced. */
  positionId: string | null;

  acceptedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
  withdrawnAt: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * The durable, immutable-except-for-settlement bilateral economic
 * contract (§40-42, extended by Milestone R10). Structural/economic terms
 * (participants, Picks, snapshots, stake) never change after commitment.
 * `feeBps`/`settlementStatus`/`settledAt`/`settlementId` are R10's own
 * additions — `feeBps` is captured once, at commitment (inside
 * accept_monetary_proposal() itself), from the platform's fee rate at
 * that exact moment, and never re-read live at settlement time, so a
 * later platform fee-rate change can never alter an already-committed
 * Position's economics (docs/architecture/p2p-settlement.md §"Fee
 * snapshot").
 */
export type MonetaryPositionSettlementStatus = "COMMITTED" | "SETTLED" | "VOIDED";

export interface MonetaryPosition {
  id: string;
  proposalId: string;

  marketId: string;
  proposerUserId: string;
  recipientUserId: string;
  proposerPredictionId: string;
  recipientPredictionId: string;
  proposerSelectionSnapshot: PredictionOutcome;
  recipientSelectionSnapshot: PredictionOutcome;
  stake: number;

  proposerReservationId: string;
  recipientReservationId: string;

  /** The P2P fee rate (basis points) snapshotted onto this Position at commitment. Immutable. */
  feeBps: number;
  settlementStatus: MonetaryPositionSettlementStatus;
  /** Non-null once settlementStatus is SETTLED or VOIDED. */
  settledAt: string | null;
  /** Non-null once settlementStatus is SETTLED or VOIDED. */
  settlementId: string | null;

  committedAt: string;
  updatedAt: string;
}

export type MonetaryPositionSettlementOutcome = "PROPOSER_WINS" | "RECIPIENT_WINS" | "VOID";

/**
 * Milestone R10's own first-class, fully immutable settlement audit
 * record — created exactly once per Position (§19). `winnerUserId`/
 * `loserUserId` are null for a VOID settlement; every other participant-
 * facing field uses `proposerUserId`/`recipientUserId` (always populated,
 * mirroring MonetaryPosition's own identity fields) so a VOID settlement
 * is still fully attributable to its two participants.
 */
export interface MonetaryPositionSettlement {
  id: string;
  positionId: string;
  marketId: string;

  proposerUserId: string;
  recipientUserId: string;

  outcome: MonetaryPositionSettlementOutcome;
  /** Null for VOID. */
  winnerUserId: string | null;
  /** Null for VOID. */
  loserUserId: string | null;

  stake: number;
  /** The fee rate actually applied — copied from the Position's own snapshot at settlement time, never a live read. */
  feeBps: number;
  feeAmount: number;
  /** stake - feeAmount for a WIN settlement, 0 for VOID. */
  winnerCreditAmount: number;

  /** The exact authoritative Market/Pick result this settlement used (§20) — preserved forever regardless of anything that happens to the Market/fixture afterward. */
  marketResult: PredictionOutcome | "VOID";
  proposerPredictionResult: "CORRECT" | "INCORRECT" | "VOID";
  recipientPredictionResult: "CORRECT" | "INCORRECT" | "VOID";

  proposerReservationOutcome: "RELEASED" | "CONSUMED";
  recipientReservationOutcome: "RELEASED" | "CONSUMED";

  /** Real reference to wallet_transactions.id — null only for a VOID settlement (no debit occurred). */
  loserWalletTransactionId: string | null;
  /** Real reference to wallet_transactions.id — null for VOID, or for a WIN settlement whose winner credit rounded to exactly 0. */
  winnerWalletTransactionId: string | null;
  /** Real reference to wallet_transactions.id — null whenever feeAmount is 0. */
  houseFeeTransactionId: string | null;

  settledAt: string;
}

/** Presentation-safe participant identity plus monetary eligibility for the Post/Market "who picked what, can I put money on it" surface — mirrors lib/challenges/types.ts's own ChallengeParticipant shape, extended with funding/eligibility context specific to money. */
export interface MonetaryParticipant {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  predictionId: string;
  selectedOutcome: PredictionOutcome;
  /** Whether the viewer could send a monetary proposal to this specific participant right now, assuming they have the stake available — server-derived (opposing selection, neither Pick graded, before cutoff, monetary P2P enabled, no existing active proposal between the two). Does NOT depend on the viewer's own balance — that's checked at proposal-creation time, not discovery time. */
  canProposeMoney: boolean;
}
