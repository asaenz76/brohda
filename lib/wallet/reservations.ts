import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R8 (docs/BROHDA_2_0_MILESTONE_MAP.md, Wallet Reservation
// Layer) — the sole query/mutation surface for `wallet_reservations`,
// matching this codebase's one-repository-per-table convention. Every
// mutation wraps a service-role-only SQL function
// (reserve_funds/release_reservation/consume_reservation,
// supabase/migrations/20260101000155_wallet_reservations.sql) — never a
// plain insert/update here, exactly like every other wallet-adjacent
// table in this codebase.

export type WalletReservationStatus = "ACTIVE" | "RELEASED" | "CONSUMED";
// "monetary_position" added by Milestone R9's migration
// (20260101000156_monetary_challenge_position.sql) — propose_money()/
// accept_monetary_proposal() reserve funds under this purpose via the
// exact same reserve_funds()/release_reservation() primitives R8 built.
export type WalletReservationPurpose = "withdrawal_request" | "monetary_position";

export interface WalletReservation {
  id: string;
  userId: string;
  amount: number;
  status: WalletReservationStatus;
  purpose: WalletReservationPurpose;
  consumedTransactionId: string | null;
  releasedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Total owned balance, the sum of currently-ACTIVE reservations, and the derived spendable remainder — the one canonical shape every presentation and every spending-eligibility check should read (§31: "do not let components independently calculate balance - something in multiple places"). */
export interface WalletBalanceSummary {
  total: number;
  reserved: number;
  available: number;
}

interface WalletReservationRow {
  id: string;
  user_id: string;
  amount: number;
  status: WalletReservationStatus;
  purpose: WalletReservationPurpose;
  consumed_transaction_id: string | null;
  released_at: string | null;
  consumed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: WalletReservationRow): WalletReservation {
  return {
    id: row.id,
    userId: row.user_id,
    amount: row.amount,
    status: row.status,
    purpose: row.purpose,
    consumedTransactionId: row.consumed_transaction_id,
    releasedAt: row.released_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The one canonical way to read total/reserved/available (§31). `reserved`
 * comes straight off `wallet_balances.reserved_balance` — a materialized
 * total maintained transactionally by the three RPCs below, not summed
 * live from `wallet_reservations` on every read (see this table's own
 * migration comment for why: apply_wallet_transaction already holds this
 * exact row locked, so reading a column on it is free, whereas summing a
 * second table would be a second query and a second lock). `available` is
 * always derived (`total - reserved`), never its own stored column, so it
 * can never itself drift out of sync with the two numbers that define it.
 */
export async function getWalletBalanceSummary(userId: string): Promise<WalletBalanceSummary> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("wallet_balances")
    .select("balance, reserved_balance")
    .eq("user_id", userId)
    .eq("account_type", "user")
    .single();
  if (error) throw error;
  return { total: data.balance, reserved: data.reserved_balance, available: data.balance - data.reserved_balance };
}

export interface ReserveFundsInput {
  userId: string;
  amount: number;
  purpose: WalletReservationPurpose;
  idempotencyKey: string;
}

/**
 * Wraps reserve_funds() (§8). Throws `insufficient_available_balance` when
 * the amount exceeds available, or `amount must be positive` for a
 * non-positive amount — both real exceptions, not a composite outcome,
 * since (unlike accept/consume) there is no "materialize a state change,
 * then report a non-success outcome" hazard here: a rejected reservation
 * never partially exists.
 *
 * Deliberately no `walletRequestId` input: a reservation must exist BEFORE
 * the wallet_requests row that references it can be inserted (§11's own
 * "reserve first, then record the request" ordering), so a reservation
 * can never itself hold a real FK to a request that doesn't exist yet at
 * the moment it's created — the correlation is one-way,
 * `wallet_requests.reservation_id`, which is sufficient for every query
 * this domain needs (both "which reservation backs this request" and,
 * via a reverse lookup, "which request does this reservation belong to").
 */
export async function reserveFunds(input: ReserveFundsInput): Promise<WalletReservation> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("reserve_funds", {
      p_user_id: input.userId,
      p_amount: input.amount,
      p_purpose: input.purpose,
      p_idempotency_key: input.idempotencyKey,
    })
    .single();
  if (error) throw error;
  return toDomain(data as WalletReservationRow);
}

export type ReleaseReservationOutcome = "released" | "already_released" | "already_consumed";

export interface ReleaseReservationResult {
  reservation: WalletReservation;
  outcome: ReleaseReservationOutcome;
}

interface ReleaseReservationRpcRow {
  reservation: WalletReservationRow;
  outcome: ReleaseReservationOutcome;
}

/** Wraps release_reservation() (§15). Idempotent: releasing an already-RELEASED reservation returns `already_released` rather than erroring; releasing an already-CONSUMED one (the other, mutually-exclusive terminal state — §23) returns `already_consumed` rather than silently pretending it worked. */
export async function releaseReservation(reservationId: string): Promise<ReleaseReservationResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("release_reservation", { p_reservation_id: reservationId }).single();
  if (error) throw error;
  const row = data as ReleaseReservationRpcRow;
  return { reservation: toDomain(row.reservation), outcome: row.outcome };
}

export type ConsumeReservationOutcome = "consumed" | "already_consumed" | "already_released";

export interface ConsumeReservationResult {
  reservation: WalletReservation;
  /** The resulting debit — present whenever the reservation is (or already was) CONSUMED; null only for `already_released`. */
  walletTransactionId: string | null;
  outcome: ConsumeReservationOutcome;
}

interface ConsumeReservationRpcRow {
  reservation: WalletReservationRow;
  wallet_transaction: { id: string } | null;
  outcome: ConsumeReservationOutcome;
}

export interface ConsumeReservationInput {
  reservationId: string;
  walletTransactionType: string;
  adminId: string | null;
  reason: string;
  idempotencyKey: string;
  destination?: string | null;
}

/** Wraps consume_reservation() (§16) — converts the hold into a real debit, atomically, correlating the two (§44). Idempotent: a retry against an already-CONSUMED reservation returns the SAME `walletTransactionId` rather than debiting twice. */
export async function consumeReservation(input: ConsumeReservationInput): Promise<ConsumeReservationResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("consume_reservation", {
      p_reservation_id: input.reservationId,
      p_wallet_txn_type: input.walletTransactionType,
      p_wallet_txn_admin_id: input.adminId,
      p_wallet_txn_reason: input.reason,
      p_wallet_txn_idempotency_key: input.idempotencyKey,
      p_wallet_txn_destination: input.destination ?? null,
    })
    .single();
  if (error) throw error;
  const row = data as ConsumeReservationRpcRow;
  return { reservation: toDomain(row.reservation), walletTransactionId: row.wallet_transaction?.id ?? null, outcome: row.outcome };
}

export async function getReservationById(id: string): Promise<WalletReservation | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("wallet_reservations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as WalletReservationRow) : null;
}

/** A user's reservation history, most recent first — the "why are my funds unavailable" surface (§33), and the source list for any future audit tooling. Bounded, matching this codebase's other defensive-cap-not-real-pagination precedent (listUserPredictions, listResolvedChallenges). */
export async function listUserReservations(userId: string, limit = 50): Promise<WalletReservation[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("wallet_reservations")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as WalletReservationRow[]).map(toDomain);
}
