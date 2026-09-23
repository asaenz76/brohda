import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R9 §72: a deterministic consistency check for
// `monetary_proposals`/`monetary_positions` against `wallet_reservations`,
// mirroring lib/wallet/reconciliation.ts's own read-only, point-in-time,
// no-auto-repair shape exactly. Most of these conditions are already
// impossible by construction (this table's own CHECK/UNIQUE constraints
// and the fact that only propose_money()/accept_monetary_proposal()/
// decline_monetary_proposal()/withdraw_monetary_proposal() ever write these
// tables) — this exists as an independent, queryable proof those
// invariants hold, not as a repair tool.

export interface MonetaryConsistencyAnomaly {
  kind:
    | "pending_proposal_without_active_reservation"
    | "proposer_reservation_wrong_owner"
    | "proposer_reservation_wrong_amount"
    | "terminal_proposal_with_active_reservation"
    | "accepted_proposal_without_position"
    | "position_reservation_not_active"
    | "position_reservation_wrong_owner"
    | "position_reservation_wrong_amount"
    | "duplicate_reservation_across_positions"
    | "position_participant_pick_mismatch"
    | "proposal_position_market_mismatch"
    // Milestone R10 (§39).
    | "committed_position_graded_but_unsettled"
    | "settlement_without_terminal_position"
    | "terminal_position_without_settlement"
    | "settlement_reservation_outcome_mismatch"
    | "settlement_missing_ledger_transaction"
    | "settlement_fee_mismatch"
    | "settlement_conservation_mismatch"
    | "settlement_position_market_mismatch"
    | "duplicate_settlement_for_position";
  proposalId: string | null;
  positionId: string | null;
  detail: string;
}

export interface MonetaryConsistencyReport {
  checkedProposals: number;
  checkedPositions: number;
  anomalies: MonetaryConsistencyAnomaly[];
}

/** Read-only, bounded, safe against a live database — same reasoning as checkWalletReservationConsistency's own header comment. */
export async function checkMonetaryConsistency(): Promise<MonetaryConsistencyReport> {
  const admin = createAdminClient();
  const anomalies: MonetaryConsistencyAnomaly[] = [];

  const { data: proposals, error: proposalsError } = await admin
    .from("monetary_proposals")
    .select("id, market_id, proposer_user_id, stake, status, proposer_reservation_id, position_id");
  if (proposalsError) throw proposalsError;

  const { data: positions, error: positionsError } = await admin
    .from("monetary_positions")
    .select(
      "id, proposal_id, market_id, proposer_user_id, recipient_user_id, proposer_prediction_id, recipient_prediction_id, stake, proposer_reservation_id, recipient_reservation_id, fee_bps, settlement_status, settlement_id",
    );
  if (positionsError) throw positionsError;

  const reservationIds = [
    ...new Set([...(proposals ?? []).map((p) => p.proposer_reservation_id), ...(positions ?? []).flatMap((p) => [p.proposer_reservation_id, p.recipient_reservation_id])]),
  ];
  const { data: reservations, error: reservationsError } =
    reservationIds.length > 0
      ? await admin.from("wallet_reservations").select("id, user_id, amount, status").in("id", reservationIds)
      : { data: [], error: null };
  if (reservationsError) throw reservationsError;
  const reservationsById = new Map((reservations ?? []).map((r) => [r.id, r]));

  const positionsByProposalId = new Map((positions ?? []).map((p) => [p.proposal_id, p]));

  for (const proposal of proposals ?? []) {
    const reservation = reservationsById.get(proposal.proposer_reservation_id);
    if (!reservation) {
      anomalies.push({
        kind: "pending_proposal_without_active_reservation",
        proposalId: proposal.id,
        positionId: null,
        detail: `proposal ${proposal.id} references reservation ${proposal.proposer_reservation_id}, which does not exist`,
      });
      continue;
    }
    if (reservation.user_id !== proposal.proposer_user_id) {
      anomalies.push({
        kind: "proposer_reservation_wrong_owner",
        proposalId: proposal.id,
        positionId: null,
        detail: `proposal ${proposal.id} proposer=${proposal.proposer_user_id} but reservation ${reservation.id} owner=${reservation.user_id}`,
      });
    }
    if (reservation.amount !== proposal.stake) {
      anomalies.push({
        kind: "proposer_reservation_wrong_amount",
        proposalId: proposal.id,
        positionId: null,
        detail: `proposal ${proposal.id} stake=${proposal.stake} but reservation ${reservation.id} amount=${reservation.amount}`,
      });
    }

    if (proposal.status === "PENDING" && reservation.status !== "ACTIVE") {
      anomalies.push({
        kind: "pending_proposal_without_active_reservation",
        proposalId: proposal.id,
        positionId: null,
        detail: `proposal ${proposal.id} is PENDING but reservation ${reservation.id} status=${reservation.status}`,
      });
    }
    if ((proposal.status === "DECLINED" || proposal.status === "EXPIRED" || proposal.status === "WITHDRAWN") && reservation.status === "ACTIVE") {
      anomalies.push({
        kind: "terminal_proposal_with_active_reservation",
        proposalId: proposal.id,
        positionId: null,
        detail: `proposal ${proposal.id} is ${proposal.status} but reservation ${reservation.id} is still ACTIVE`,
      });
    }

    if (proposal.status === "ACCEPTED") {
      const position = positionsByProposalId.get(proposal.id);
      if (!position || proposal.position_id !== position.id) {
        anomalies.push({
          kind: "accepted_proposal_without_position",
          proposalId: proposal.id,
          positionId: proposal.position_id,
          detail: `proposal ${proposal.id} is ACCEPTED with position_id=${proposal.position_id}, but no matching monetary_positions row was found`,
        });
      } else if (position.market_id !== proposal.market_id) {
        anomalies.push({
          kind: "proposal_position_market_mismatch",
          proposalId: proposal.id,
          positionId: position.id,
          detail: `proposal ${proposal.id} market=${proposal.market_id} but position ${position.id} market=${position.market_id}`,
        });
      }
    }
  }

  const reservationUseCount = new Map<string, number>();
  for (const position of positions ?? []) {
    for (const reservationId of [position.proposer_reservation_id, position.recipient_reservation_id]) {
      reservationUseCount.set(reservationId, (reservationUseCount.get(reservationId) ?? 0) + 1);
    }
  }

  for (const position of positions ?? []) {
    if (position.proposer_prediction_id === position.recipient_prediction_id || position.proposer_user_id === position.recipient_user_id) {
      anomalies.push({
        kind: "position_participant_pick_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `position ${position.id} has identical proposer/recipient identity or Pick`,
      });
    }

    for (const [role, reservationId, expectedUserId] of [
      ["proposer", position.proposer_reservation_id, position.proposer_user_id],
      ["recipient", position.recipient_reservation_id, position.recipient_user_id],
    ] as const) {
      const reservation = reservationsById.get(reservationId);
      if (!reservation) {
        anomalies.push({
          kind: "position_reservation_not_active",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `position ${position.id} ${role} reservation ${reservationId} does not exist`,
        });
        continue;
      }
      if (position.settlement_status === "COMMITTED" && reservation.status !== "ACTIVE") {
        anomalies.push({
          kind: "position_reservation_not_active",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `position ${position.id} is still COMMITTED but ${role} reservation ${reservation.id} status=${reservation.status}, expected ACTIVE (a still-COMMITTED Position's reservations must never be touched except by settle_monetary_position())`,
        });
      }
      if (reservation.user_id !== expectedUserId) {
        anomalies.push({
          kind: "position_reservation_wrong_owner",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `position ${position.id} ${role} reservation ${reservation.id} owner=${reservation.user_id}, expected ${expectedUserId}`,
        });
      }
      if (reservation.amount !== position.stake) {
        anomalies.push({
          kind: "position_reservation_wrong_amount",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `position ${position.id} stake=${position.stake} but ${role} reservation ${reservation.id} amount=${reservation.amount}`,
        });
      }
      if ((reservationUseCount.get(reservationId) ?? 0) > 1) {
        anomalies.push({
          kind: "duplicate_reservation_across_positions",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `reservation ${reservationId} is referenced by more than one monetary_positions row`,
        });
      }
    }
  }

  // =====================================================================
  // Milestone R10 (§39): settlement-specific checks. `predictions` is
  // fetched once here (both Picks per Position) to determine whether a
  // still-COMMITTED Position's Market has already graded — the exact
  // eligibility settle_monetary_position() itself checks — without
  // re-running any sports-scoring logic (§46, §72: this only reads
  // already-graded, immutable Prediction rows, never recomputes a result).
  // =====================================================================
  const allPredictionIds = [...new Set((positions ?? []).flatMap((p) => [p.proposer_prediction_id, p.recipient_prediction_id]))];
  const { data: predictionRows, error: predictionsError } =
    allPredictionIds.length > 0 ? await admin.from("predictions").select("id, lifecycle_state").in("id", allPredictionIds) : { data: [], error: null };
  if (predictionsError) throw predictionsError;
  const gradedPredictionIds = new Set((predictionRows ?? []).filter((p) => p.lifecycle_state === "GRADED").map((p) => p.id));

  const { data: settlements, error: settlementsError } = await admin
    .from("monetary_position_settlements")
    .select(
      "id, position_id, market_id, outcome, winner_user_id, loser_user_id, stake, fee_bps, fee_amount, winner_credit_amount, proposer_reservation_outcome, recipient_reservation_outcome, loser_wallet_transaction_id, winner_wallet_transaction_id, house_fee_transaction_id",
    );
  if (settlementsError) throw settlementsError;

  const settlementsByPositionId = new Map<string, (typeof settlements)[number][]>();
  for (const s of settlements ?? []) {
    const list = settlementsByPositionId.get(s.position_id) ?? [];
    list.push(s);
    settlementsByPositionId.set(s.position_id, list);
  }

  for (const position of positions ?? []) {
    const positionSettlements = settlementsByPositionId.get(position.id) ?? [];

    if (positionSettlements.length > 1) {
      anomalies.push({
        kind: "duplicate_settlement_for_position",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `position ${position.id} has ${positionSettlements.length} monetary_position_settlements rows, expected at most 1`,
      });
    }

    if (position.settlement_status === "COMMITTED") {
      const bothGraded = gradedPredictionIds.has(position.proposer_prediction_id) && gradedPredictionIds.has(position.recipient_prediction_id);
      if (bothGraded) {
        anomalies.push({
          kind: "committed_position_graded_but_unsettled",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `position ${position.id} has both Picks GRADED but is still COMMITTED — settle_monetary_position() has not been run, or a prior run reported invariant_violation`,
        });
      }
      if (positionSettlements.length > 0) {
        anomalies.push({
          kind: "settlement_without_terminal_position",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `position ${position.id} has a settlement row but settlement_status is still COMMITTED`,
        });
      }
      continue;
    }

    // settlement_status is SETTLED or VOIDED from here on — a settlement row must exist.
    if (positionSettlements.length === 0 || !position.settlement_id) {
      anomalies.push({
        kind: "terminal_position_without_settlement",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `position ${position.id} is ${position.settlement_status} but has no monetary_position_settlements row`,
      });
      continue;
    }

    const settlement = positionSettlements[0];

    if (settlement.market_id !== position.market_id) {
      anomalies.push({
        kind: "settlement_position_market_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `settlement ${settlement.id} market=${settlement.market_id} but position ${position.id} market=${position.market_id}`,
      });
    }

    // VOID always charges zero fee regardless of the fee_bps snapshot
    // stored on the row (fee_bps there is preserved purely as an accurate
    // historical record of what rate was in effect — see the SQL
    // function's own VOID branch) — the stake*bps formula only applies to
    // a WIN settlement's actual fee calculation.
    const expectedFeeAmount = settlement.outcome === "VOID" ? 0 : Math.floor((settlement.stake * settlement.fee_bps) / 10000);
    if (settlement.fee_amount !== expectedFeeAmount) {
      anomalies.push({
        kind: "settlement_fee_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `settlement ${settlement.id} fee_amount=${settlement.fee_amount}, expected ${expectedFeeAmount}`,
      });
    }

    const expectedWinnerCredit = settlement.outcome === "VOID" ? 0 : settlement.stake - settlement.fee_amount;
    if (settlement.winner_credit_amount !== expectedWinnerCredit) {
      anomalies.push({
        kind: "settlement_conservation_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `settlement ${settlement.id} winner_credit_amount=${settlement.winner_credit_amount}, expected ${expectedWinnerCredit} (stake - fee)`,
      });
    }

    if (settlement.outcome !== "VOID") {
      if (!settlement.loser_wallet_transaction_id) {
        anomalies.push({
          kind: "settlement_missing_ledger_transaction",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `settlement ${settlement.id} outcome=${settlement.outcome} but loser_wallet_transaction_id is null`,
        });
      }
      if (settlement.winner_credit_amount > 0 && !settlement.winner_wallet_transaction_id) {
        anomalies.push({
          kind: "settlement_missing_ledger_transaction",
          proposalId: position.proposal_id,
          positionId: position.id,
          detail: `settlement ${settlement.id} winner_credit_amount=${settlement.winner_credit_amount} but winner_wallet_transaction_id is null`,
        });
      }
    }
    if (settlement.fee_amount > 0 && !settlement.house_fee_transaction_id) {
      anomalies.push({
        kind: "settlement_missing_ledger_transaction",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `settlement ${settlement.id} fee_amount=${settlement.fee_amount} but house_fee_transaction_id is null`,
      });
    }

    const expectedProposerOutcome = settlement.outcome === "RECIPIENT_WINS" ? "CONSUMED" : "RELEASED";
    const expectedRecipientOutcome = settlement.outcome === "PROPOSER_WINS" ? "CONSUMED" : "RELEASED";
    if (settlement.proposer_reservation_outcome !== expectedProposerOutcome) {
      anomalies.push({
        kind: "settlement_reservation_outcome_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `settlement ${settlement.id} outcome=${settlement.outcome} but proposer_reservation_outcome=${settlement.proposer_reservation_outcome}, expected ${expectedProposerOutcome}`,
      });
    }
    if (settlement.recipient_reservation_outcome !== expectedRecipientOutcome) {
      anomalies.push({
        kind: "settlement_reservation_outcome_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `settlement ${settlement.id} outcome=${settlement.outcome} but recipient_reservation_outcome=${settlement.recipient_reservation_outcome}, expected ${expectedRecipientOutcome}`,
      });
    }

    // The actual reservation rows should now reflect that same outcome.
    const proposerReservation = reservationsById.get(position.proposer_reservation_id);
    const recipientReservation = reservationsById.get(position.recipient_reservation_id);
    if (proposerReservation && proposerReservation.status !== expectedProposerOutcome) {
      anomalies.push({
        kind: "settlement_reservation_outcome_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `position ${position.id} proposer reservation ${proposerReservation.id} status=${proposerReservation.status}, expected ${expectedProposerOutcome} per settlement ${settlement.id}`,
      });
    }
    if (recipientReservation && recipientReservation.status !== expectedRecipientOutcome) {
      anomalies.push({
        kind: "settlement_reservation_outcome_mismatch",
        proposalId: position.proposal_id,
        positionId: position.id,
        detail: `position ${position.id} recipient reservation ${recipientReservation.id} status=${recipientReservation.status}, expected ${expectedRecipientOutcome} per settlement ${settlement.id}`,
      });
    }
  }

  return {
    checkedProposals: proposals?.length ?? 0,
    checkedPositions: positions?.length ?? 0,
    anomalies,
  };
}
