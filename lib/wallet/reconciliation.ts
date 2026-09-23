import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R8 (docs/BROHDA_2_0_MILESTONE_MAP.md, Wallet Reservation
// Layer), §45: a deterministic consistency check, not a finance
// operations dashboard. Most of these conditions are already impossible
// by construction (schema CHECK/UNIQUE constraints — see
// supabase/migrations/20260101000155_wallet_reservations.sql) — this
// function exists as an independent, queryable proof that those
// constraints are doing their job, and as the one check that ISN'T
// schema-enforced: that the materialized wallet_balances.reserved_balance
// actually equals the live sum of that user's ACTIVE wallet_reservations
// rows (§30's own "materialized vs derived" tension — the two must never
// be allowed to drift, and this is how that gets verified rather than
// assumed).

export interface WalletReservationAnomaly {
  kind:
    | "materialized_reserved_mismatch"
    | "reserved_exceeds_balance"
    | "negative_reserved"
    | "negative_amount"
    | "invalid_terminal_timestamp"
    | "consumed_without_transaction"
    | "duplicate_idempotency_key";
  userId: string | null;
  detail: string;
}

export interface WalletReservationConsistencyReport {
  checkedWallets: number;
  checkedReservations: number;
  anomalies: WalletReservationAnomaly[];
}

/**
 * Read-only. Safe to run at any time, including against a live database —
 * it never writes anything. Bounded per call (§45's own "do not build a
 * giant dashboard" — this is a point-in-time integrity query, not a
 * continuous monitor); a very large wallet population would need paging,
 * not something this milestone's actual data volume demonstrates a need
 * for yet.
 */
export async function checkWalletReservationConsistency(): Promise<WalletReservationConsistencyReport> {
  const admin = createAdminClient();
  const anomalies: WalletReservationAnomaly[] = [];

  const { data: wallets, error: walletsError } = await admin
    .from("wallet_balances")
    .select("user_id, balance, reserved_balance")
    .eq("account_type", "user");
  if (walletsError) throw walletsError;

  const { data: activeReservations, error: activeError } = await admin
    .from("wallet_reservations")
    .select("user_id, amount")
    .eq("status", "ACTIVE");
  if (activeError) throw activeError;

  const derivedReservedByUser = new Map<string, number>();
  for (const row of activeReservations ?? []) {
    derivedReservedByUser.set(row.user_id, (derivedReservedByUser.get(row.user_id) ?? 0) + row.amount);
  }

  for (const wallet of wallets ?? []) {
    if (wallet.user_id === null) continue;
    const derived = derivedReservedByUser.get(wallet.user_id) ?? 0;

    if (wallet.reserved_balance !== derived) {
      anomalies.push({
        kind: "materialized_reserved_mismatch",
        userId: wallet.user_id,
        detail: `wallet_balances.reserved_balance=${wallet.reserved_balance} but live sum of ACTIVE reservations=${derived}`,
      });
    }
    if (wallet.reserved_balance > wallet.balance) {
      anomalies.push({ kind: "reserved_exceeds_balance", userId: wallet.user_id, detail: `reserved=${wallet.reserved_balance} > balance=${wallet.balance}` });
    }
    if (wallet.reserved_balance < 0) {
      anomalies.push({ kind: "negative_reserved", userId: wallet.user_id, detail: `reserved=${wallet.reserved_balance}` });
    }
  }

  const { data: allReservations, error: allError } = await admin
    .from("wallet_reservations")
    .select("id, user_id, amount, status, released_at, consumed_at, consumed_transaction_id, idempotency_key");
  if (allError) throw allError;

  const seenIdempotencyKeys = new Set<string>();
  for (const r of allReservations ?? []) {
    if (r.amount <= 0) {
      anomalies.push({ kind: "negative_amount", userId: r.user_id, detail: `reservation ${r.id} amount=${r.amount}` });
    }
    if ((r.status === "RELEASED") !== (r.released_at !== null)) {
      anomalies.push({ kind: "invalid_terminal_timestamp", userId: r.user_id, detail: `reservation ${r.id} status=${r.status} released_at=${r.released_at}` });
    }
    if ((r.status === "CONSUMED") !== (r.consumed_at !== null)) {
      anomalies.push({ kind: "invalid_terminal_timestamp", userId: r.user_id, detail: `reservation ${r.id} status=${r.status} consumed_at=${r.consumed_at}` });
    }
    if (r.status === "CONSUMED" && !r.consumed_transaction_id) {
      anomalies.push({ kind: "consumed_without_transaction", userId: r.user_id, detail: `reservation ${r.id} is CONSUMED with no consumed_transaction_id` });
    }
    if (seenIdempotencyKeys.has(r.idempotency_key)) {
      anomalies.push({ kind: "duplicate_idempotency_key", userId: r.user_id, detail: `idempotency_key ${r.idempotency_key} appears on more than one reservation` });
    }
    seenIdempotencyKeys.add(r.idempotency_key);
  }

  return {
    checkedWallets: wallets?.length ?? 0,
    checkedReservations: allReservations?.length ?? 0,
    anomalies,
  };
}
