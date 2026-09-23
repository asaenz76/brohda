import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  MonetaryProposal,
  MonetaryProposalStatus,
  MonetaryPosition,
  MonetaryPositionSettlementStatus,
  MonetaryPositionSettlement,
  MonetaryPositionSettlementOutcome,
} from "./types";
import type { PredictionOutcome } from "@/lib/predictions/types";

// Milestone R9 — the sole query/mutation surface for `monetary_proposals`/
// `monetary_positions`, matching this codebase's one-repository-per-table
// convention. Mutations go through propose_money()/accept_monetary_
// proposal()/decline_monetary_proposal()/withdraw_monetary_proposal()
// (SQL functions, service-role only) — never a plain insert/update here.

interface MonetaryProposalRow {
  id: string;
  market_id: string;
  proposer_user_id: string;
  recipient_user_id: string;
  proposer_prediction_id: string;
  recipient_prediction_id: string;
  proposer_selection_snapshot: PredictionOutcome;
  recipient_selection_snapshot: PredictionOutcome;
  stake: number;
  source_challenge_id: string | null;
  proposer_reservation_id: string;
  status: MonetaryProposalStatus;
  position_id: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  expired_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MonetaryPositionRow {
  id: string;
  proposal_id: string;
  market_id: string;
  proposer_user_id: string;
  recipient_user_id: string;
  proposer_prediction_id: string;
  recipient_prediction_id: string;
  proposer_selection_snapshot: PredictionOutcome;
  recipient_selection_snapshot: PredictionOutcome;
  stake: number;
  proposer_reservation_id: string;
  recipient_reservation_id: string;
  fee_bps: number;
  settlement_status: MonetaryPositionSettlementStatus;
  settled_at: string | null;
  settlement_id: string | null;
  committed_at: string;
  updated_at: string;
}

interface MonetaryPositionSettlementRow {
  id: string;
  position_id: string;
  market_id: string;
  proposer_user_id: string;
  recipient_user_id: string;
  outcome: MonetaryPositionSettlementOutcome;
  winner_user_id: string | null;
  loser_user_id: string | null;
  stake: number;
  fee_bps: number;
  fee_amount: number;
  winner_credit_amount: number;
  market_result: PredictionOutcome | "VOID";
  proposer_prediction_result: "CORRECT" | "INCORRECT" | "VOID";
  recipient_prediction_result: "CORRECT" | "INCORRECT" | "VOID";
  proposer_reservation_outcome: "RELEASED" | "CONSUMED";
  recipient_reservation_outcome: "RELEASED" | "CONSUMED";
  loser_wallet_transaction_id: string | null;
  winner_wallet_transaction_id: string | null;
  house_fee_transaction_id: string | null;
  settled_at: string;
}

function toProposalDomain(row: MonetaryProposalRow): MonetaryProposal {
  return {
    id: row.id,
    marketId: row.market_id,
    proposerUserId: row.proposer_user_id,
    recipientUserId: row.recipient_user_id,
    proposerPredictionId: row.proposer_prediction_id,
    recipientPredictionId: row.recipient_prediction_id,
    proposerSelectionSnapshot: row.proposer_selection_snapshot,
    recipientSelectionSnapshot: row.recipient_selection_snapshot,
    stake: row.stake,
    sourceChallengeId: row.source_challenge_id,
    proposerReservationId: row.proposer_reservation_id,
    status: row.status,
    positionId: row.position_id,
    acceptedAt: row.accepted_at,
    declinedAt: row.declined_at,
    expiredAt: row.expired_at,
    withdrawnAt: row.withdrawn_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPositionDomain(row: MonetaryPositionRow): MonetaryPosition {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    marketId: row.market_id,
    proposerUserId: row.proposer_user_id,
    recipientUserId: row.recipient_user_id,
    proposerPredictionId: row.proposer_prediction_id,
    recipientPredictionId: row.recipient_prediction_id,
    proposerSelectionSnapshot: row.proposer_selection_snapshot,
    recipientSelectionSnapshot: row.recipient_selection_snapshot,
    stake: row.stake,
    proposerReservationId: row.proposer_reservation_id,
    recipientReservationId: row.recipient_reservation_id,
    feeBps: row.fee_bps,
    settlementStatus: row.settlement_status,
    settledAt: row.settled_at,
    settlementId: row.settlement_id,
    committedAt: row.committed_at,
    updatedAt: row.updated_at,
  };
}

function toSettlementDomain(row: MonetaryPositionSettlementRow): MonetaryPositionSettlement {
  return {
    id: row.id,
    positionId: row.position_id,
    marketId: row.market_id,
    proposerUserId: row.proposer_user_id,
    recipientUserId: row.recipient_user_id,
    outcome: row.outcome,
    winnerUserId: row.winner_user_id,
    loserUserId: row.loser_user_id,
    stake: row.stake,
    feeBps: row.fee_bps,
    feeAmount: row.fee_amount,
    winnerCreditAmount: row.winner_credit_amount,
    marketResult: row.market_result,
    proposerPredictionResult: row.proposer_prediction_result,
    recipientPredictionResult: row.recipient_prediction_result,
    proposerReservationOutcome: row.proposer_reservation_outcome,
    recipientReservationOutcome: row.recipient_reservation_outcome,
    loserWalletTransactionId: row.loser_wallet_transaction_id,
    winnerWalletTransactionId: row.winner_wallet_transaction_id,
    houseFeeTransactionId: row.house_fee_transaction_id,
    settledAt: row.settled_at,
  };
}

export type ProposeMoneyOutcome = { ok: true; proposal: MonetaryProposal } | { ok: false; error: string };

/**
 * Wraps propose_money() (§12-13, §63). The only client-meaningful inputs
 * are the recipient's Pick id, the stake, and an optional source
 * Challenge id — everything else the RPC derives server-side. Rejections
 * surface as plain exceptions from the SQL function (no partial state to
 * preserve on that path) — normalized here into a typed result, mirroring
 * lib/challenges/repository.ts's own callBS() shape exactly.
 */
export async function proposeMoney(
  proposerUserId: string,
  recipientPredictionId: string,
  stake: number,
  idempotencyKey: string,
  sourceChallengeId: string | null = null,
): Promise<ProposeMoneyOutcome> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("propose_money", {
      p_proposer_user_id: proposerUserId,
      p_recipient_prediction_id: recipientPredictionId,
      p_stake: stake,
      p_idempotency_key: idempotencyKey,
      p_source_challenge_id: sourceChallengeId,
    })
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, proposal: toProposalDomain(data as MonetaryProposalRow) };
}

export type AcceptMonetaryProposalOutcome =
  | "accepted"
  | "not_pending"
  | "rejected_cutoff"
  | "rejected_invalidated"
  | "proposer_reservation_invalid"
  | "insufficient_recipient_balance";

export interface AcceptMonetaryProposalResult {
  proposal: MonetaryProposal;
  position: MonetaryPosition | null;
  outcome: AcceptMonetaryProposalOutcome;
}

interface AcceptMonetaryProposalRpcRow {
  proposal: MonetaryProposalRow;
  position: MonetaryPositionRow | null;
  outcome: AcceptMonetaryProposalOutcome;
}

/** Wraps accept_monetary_proposal() — the atomic acceptance transaction (§31). Throws only for a genuine security violation (`not_recipient`) or a missing row (`proposal_not_found`); every ordinary business outcome comes back through the typed `outcome` field instead. */
export async function acceptMonetaryProposal(proposalId: string, recipientUserId: string): Promise<AcceptMonetaryProposalResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("accept_monetary_proposal", { p_proposal_id: proposalId, p_recipient_user_id: recipientUserId })
    .single();
  if (error) throw error;
  const row = data as AcceptMonetaryProposalRpcRow;
  return { proposal: toProposalDomain(row.proposal), position: row.position ? toPositionDomain(row.position) : null, outcome: row.outcome };
}

/** Wraps decline_monetary_proposal() (§27) — plain PENDING -> DECLINED, releasing the proposer's reservation atomically. Throws for every rejection (`not_recipient`, `not_pending`, `proposal_not_found`) — nothing partial to preserve on rejection. */
export async function declineMonetaryProposal(proposalId: string, recipientUserId: string): Promise<MonetaryProposal> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("decline_monetary_proposal", { p_proposal_id: proposalId, p_recipient_user_id: recipientUserId })
    .single();
  if (error) throw error;
  return toProposalDomain(data as MonetaryProposalRow);
}

/** Wraps withdraw_monetary_proposal() (§29) — plain PENDING -> WITHDRAWN, releasing the proposer's own reservation. Only the proposer may call this. */
export async function withdrawMonetaryProposal(proposalId: string, proposerUserId: string): Promise<MonetaryProposal> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("withdraw_monetary_proposal", { p_proposal_id: proposalId, p_proposer_user_id: proposerUserId })
    .single();
  if (error) throw error;
  return toProposalDomain(data as MonetaryProposalRow);
}

export async function getMonetaryProposalById(id: string): Promise<MonetaryProposal | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("monetary_proposals").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toProposalDomain(data as MonetaryProposalRow) : null;
}

export async function getMonetaryPositionById(id: string): Promise<MonetaryPosition | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("monetary_positions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toPositionDomain(data as MonetaryPositionRow) : null;
}

/** Every currently-visible proposal (any status) between this user and a specific Market's participants — used to compute per-participant `canProposeMoney` and current relationship state without a second round-trip per participant (mirrors lib/challenges/repository.ts's own listChallengesForMarketAndUser). */
export async function listMonetaryProposalsForMarketAndUser(marketId: string, userId: string): Promise<MonetaryProposal[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("monetary_proposals")
    .select("*")
    .eq("market_id", marketId)
    .or(`proposer_user_id.eq.${userId},recipient_user_id.eq.${userId}`);
  if (error) throw error;
  return (data as MonetaryProposalRow[]).map(toProposalDomain);
}

/** This user's Positions, most recent first (§56, wallet hold context) — a defensive cap, not real pagination, matching this codebase's other such precedents. */
export async function listMonetaryPositionsForUser(userId: string, limit = 50): Promise<MonetaryPosition[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("monetary_positions")
    .select("*")
    .or(`proposer_user_id.eq.${userId},recipient_user_id.eq.${userId}`)
    .order("committed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as MonetaryPositionRow[]).map(toPositionDomain);
}

// =====================================================================
// Milestone R10 — P2P Settlement.
// =====================================================================

export type SettleMonetaryPositionOutcome = "settled_win" | "settled_void" | "already_settled" | "not_eligible" | "invariant_violation";

export interface SettleMonetaryPositionResult {
  position: MonetaryPosition;
  settlement: MonetaryPositionSettlement | null;
  outcome: SettleMonetaryPositionOutcome;
}

interface SettleMonetaryPositionRpcRow {
  position: MonetaryPositionRow;
  settlement: MonetaryPositionSettlementRow | null;
  outcome: SettleMonetaryPositionOutcome;
}

/**
 * Wraps settle_monetary_position() (R10's own atomic settlement
 * transaction). `not_eligible` (Market not yet graded) and
 * `invariant_violation` (a detected financial-state anomaly — see the SQL
 * function's own comment) both leave the Position completely untouched,
 * safe to retry later; `already_settled` is the ordinary idempotent-retry
 * path. Throws only for a genuine data-integrity impossibility
 * (`position_not_found`) — every ordinary outcome comes back typed.
 */
export async function settleMonetaryPosition(positionId: string): Promise<SettleMonetaryPositionResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("settle_monetary_position", { p_position_id: positionId }).single();
  if (error) throw error;
  const row = data as SettleMonetaryPositionRpcRow;
  return {
    position: toPositionDomain(row.position),
    settlement: row.settlement ? toSettlementDomain(row.settlement) : null,
    outcome: row.outcome,
  };
}

export async function getMonetaryPositionSettlementById(id: string): Promise<MonetaryPositionSettlement | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("monetary_position_settlements").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toSettlementDomain(data as MonetaryPositionSettlementRow) : null;
}

/** Batch lookup for a set of Position ids — used by MarketParticipants.tsx to resolve every opposing participant's settlement state in one round trip rather than one query per row. */
export async function listMonetaryPositionsByIds(ids: string[]): Promise<MonetaryPosition[]> {
  if (ids.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("monetary_positions").select("*").in("id", ids);
  if (error) throw error;
  return (data as MonetaryPositionRow[]).map(toPositionDomain);
}

/** Batch lookup mirroring listMonetaryPositionsByIds — keyed by position_id, not settlement id, since callers always start from a Position. */
export async function listMonetaryPositionSettlementsByPositionIds(positionIds: string[]): Promise<MonetaryPositionSettlement[]> {
  if (positionIds.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("monetary_position_settlements").select("*").in("position_id", positionIds);
  if (error) throw error;
  return (data as MonetaryPositionSettlementRow[]).map(toSettlementDomain);
}

export async function getMonetaryPositionSettlementByPositionId(positionId: string): Promise<MonetaryPositionSettlement | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("monetary_position_settlements").select("*").eq("position_id", positionId).maybeSingle();
  if (error) throw error;
  return data ? toSettlementDomain(data as MonetaryPositionSettlementRow) : null;
}

/**
 * Every COMMITTED Position whose both underlying Picks are already
 * GRADED — the exact eligibility settle_monetary_position() itself
 * re-verifies under lock, used here only to build a bounded candidate
 * batch for the runner script (§69-71) so it doesn't need to call the
 * RPC against every COMMITTED Position in the system on every run.
 * Read-only; never itself decides an outcome.
 */
export async function listSettlementEligiblePositionIds(limit?: number): Promise<string[]> {
  const admin = createAdminClient();
  // Milestone R12 (§36, §82): closes the R10 batch-size caveat —
  // `platform_settings.settlement_batch_size` (default 500, matching this
  // function's own former hard-coded default exactly) is now the
  // canonical source, live-read on every call, changeable by an operator
  // with no deployment. An explicit `limit` argument still overrides it
  // (used by tests that need a smaller, deterministic batch).
  let effectiveLimit: number = limit ?? 500;
  if (limit === undefined) {
    const { data: settingsRow } = await admin.from("platform_settings").select("settlement_batch_size").eq("id", true).single();
    effectiveLimit = settingsRow?.settlement_batch_size ?? 500;
  }
  const { data: positions, error } = await admin
    .from("monetary_positions")
    .select("id, proposer_prediction_id, recipient_prediction_id")
    .eq("settlement_status", "COMMITTED")
    .order("committed_at", { ascending: true })
    .limit(effectiveLimit);
  if (error) throw error;
  if (!positions || positions.length === 0) return [];

  const predictionIds = [...new Set(positions.flatMap((p) => [p.proposer_prediction_id, p.recipient_prediction_id]))];
  const { data: predictions, error: predictionsError } = await admin.from("predictions").select("id, lifecycle_state").in("id", predictionIds);
  if (predictionsError) throw predictionsError;
  const gradedIds = new Set((predictions ?? []).filter((p) => p.lifecycle_state === "GRADED").map((p) => p.id));

  return positions.filter((p) => gradedIds.has(p.proposer_prediction_id) && gradedIds.has(p.recipient_prediction_id)).map((p) => p.id);
}
