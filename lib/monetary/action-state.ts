import type { MonetaryPosition, MonetaryPositionSettlement, MonetaryProposal } from "./types";

/**
 * What the single money control for one opposing participant row shows.
 * Decided server-side (never inferred client-side) — see
 * deriveMonetaryActionState below.
 */
export type MonetaryActionState =
  | { kind: "put_money_on_it"; recipientPredictionId: string }
  | { kind: "outgoing_pending"; proposalId: string; stake: number }
  | { kind: "incoming_pending_funded"; proposalId: string; stake: number }
  | { kind: "incoming_pending_unfunded"; proposalId: string; stake: number }
  // A PENDING proposal whose Game is past the cutoff. It can no longer be
  // accepted, and the expiry sweep releases the proposer's hold within a
  // couple of minutes — so neither side is offered a control the server
  // would only refuse.
  | { kind: "expired"; stake: number }
  | { kind: "committed"; stake: number }
  | { kind: "settled_win"; amount: number }
  | { kind: "settled_loss"; amount: number }
  | { kind: "settled_void" };

/**
 * The pure per-row decision behind MarketParticipants' money control — no
 * I/O, unit-testable. `proposals` are the viewer's own proposals on this
 * Market. Expiry of a PENDING proposal is only applied in the database by
 * the sweep (and lazily on an accept attempt), so the UI must not trust
 * `status = PENDING` alone once the cutoff has passed.
 */
export function deriveMonetaryActionState({
  viewerId,
  participantPredictionId,
  canProposeMoney,
  proposals,
  positionsById,
  settlementsByPositionId,
  viewerAvailableCents,
  pastCutoff,
}: {
  viewerId: string;
  participantPredictionId: string;
  canProposeMoney: boolean;
  proposals: MonetaryProposal[];
  positionsById: Map<string, MonetaryPosition>;
  settlementsByPositionId: Map<string, MonetaryPositionSettlement>;
  viewerAvailableCents: number;
  pastCutoff: boolean;
}): MonetaryActionState | null {
  const activeProposal = proposals.find(
    (p) =>
      (p.status === "PENDING" || p.status === "ACCEPTED") &&
      ((p.proposerUserId === viewerId && p.recipientPredictionId === participantPredictionId) ||
        (p.recipientUserId === viewerId && p.proposerPredictionId === participantPredictionId)),
  );

  if (activeProposal) {
    if (activeProposal.status === "ACCEPTED") {
      const position = activeProposal.positionId ? positionsById.get(activeProposal.positionId) : undefined;
      const settlement = position ? settlementsByPositionId.get(position.id) : undefined;
      if (settlement) {
        if (settlement.outcome === "VOID") return { kind: "settled_void" };
        if (settlement.winnerUserId === viewerId) return { kind: "settled_win", amount: settlement.winnerCreditAmount };
        return { kind: "settled_loss", amount: settlement.stake };
      }
      return { kind: "committed", stake: activeProposal.stake };
    }
    if (pastCutoff) return { kind: "expired", stake: activeProposal.stake };
    if (activeProposal.proposerUserId === viewerId) return { kind: "outgoing_pending", proposalId: activeProposal.id, stake: activeProposal.stake };
    if (viewerAvailableCents >= activeProposal.stake) return { kind: "incoming_pending_funded", proposalId: activeProposal.id, stake: activeProposal.stake };
    return { kind: "incoming_pending_unfunded", proposalId: activeProposal.id, stake: activeProposal.stake };
  }

  if (canProposeMoney) return { kind: "put_money_on_it", recipientPredictionId: participantPredictionId };
  return null;
}
