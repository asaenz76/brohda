/**
 * Integration tests for Milestone R8 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Wallet Reservation Layer) — reserve_funds()/release_reservation()/
 * consume_reservation(), apply_wallet_transaction()'s strengthened
 * available-balance check, reconciliation, and security. Real local
 * Supabase throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { reserveFunds, releaseReservation, consumeReservation, getWalletBalanceSummary, getReservationById, listUserReservations } from "@/lib/wallet/reservations";
import { checkWalletReservationConsistency } from "@/lib/wallet/reconciliation";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();

const createdUserIds: string[] = [];

async function createUser(label = "r8") {
  const email = `${label}-${randomUUID()}@test.local`;
  const password = "integration-test-password-123";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  await client.auth.signInWithPassword({ email, password });
  return { userId: data.user.id, client };
}

// A self-contained test super_admin, not a lookup of whatever happens to be
// active in the shared local DB at this point in the run — the latter made
// this file's own pass/fail depend on which other test files had run (and
// deactivated their own admins) first.
async function getAdminId(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `r8-admin-${randomUUID()}@test.local`,
    password: "integration-test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create admin");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "r8-admin", role: "super_admin", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function deposit(userId: string, amount: number, idempotencyKey = randomUUID()) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amount,
    p_admin_id: null,
    p_reason: "test funding",
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
}

async function debit(userId: string, amount: number, idempotencyKey = randomUUID()) {
  return admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "pool_entry_debit",
    p_direction: "debit",
    p_amount: amount,
    p_admin_id: null,
    p_reason: "test debit",
    p_idempotency_key: idempotencyKey,
  });
}

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await admin.from("wallet_reservations").delete().in("user_id", createdUserIds);
    for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
    createdUserIds.length = 0;
  }
});

describe("Migration", () => {
  it("existing wallet balances are preserved with reserved_balance = 0", async () => {
    const { userId } = await createUser();
    await deposit(userId, 5000);
    const summary = await getWalletBalanceSummary(userId);
    expect(summary).toEqual({ total: 5000, reserved: 0, available: 5000 });
  });
});

describe("Reserve", () => {
  it("reserving within available succeeds", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    expect(reservation.status).toBe("ACTIVE");
    expect(reservation.amount).toBe(2000);
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 2000, available: 8000 });
  });

  it("reserving exactly the available amount succeeds", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 10000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 10000, available: 0 });
  });

  it("reserving above available fails", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await expect(reserveFunds({ userId, amount: 10001, purpose: "withdrawal_request", idempotencyKey: randomUUID() })).rejects.toThrow(/insufficient_available_balance/);
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 0, available: 10000 });
  });

  it("a zero-amount reservation is rejected", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await expect(reserveFunds({ userId, amount: 0, purpose: "withdrawal_request", idempotencyKey: randomUUID() })).rejects.toThrow(/amount must be positive/);
  });

  it("a negative-amount reservation is rejected", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await expect(reserveFunds({ userId, amount: -500, purpose: "withdrawal_request", idempotencyKey: randomUUID() })).rejects.toThrow(/amount must be positive/);
  });

  it("a duplicate idempotency key does not double-reserve", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const key = randomUUID();
    const first = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: key });
    const second = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: key });
    expect(second.id).toBe(first.id);
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 2000, available: 8000 });
  });
});

describe("Release", () => {
  it("ACTIVE transitions to RELEASED and restores availability without changing total", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const result = await releaseReservation(reservation.id);
    expect(result.outcome).toBe("released");
    expect(result.reservation.status).toBe("RELEASED");
    expect(result.reservation.releasedAt).not.toBeNull();
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 0, available: 10000 }); // NOT 12000
  });

  it("a second release is a safe no-op (idempotent)", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    await releaseReservation(reservation.id);
    const second = await releaseReservation(reservation.id);
    expect(second.outcome).toBe("already_released");
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 0, available: 10000 });
  });

  it("a CONSUMED reservation cannot be released", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    await consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    const result = await releaseReservation(reservation.id);
    expect(result.outcome).toBe("already_consumed");
  });
});

describe("Consume", () => {
  it("ACTIVE transitions to CONSUMED, reducing total exactly once and removing the hold", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const result = await consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    expect(result.outcome).toBe("consumed");
    expect(result.reservation.status).toBe("CONSUMED");
    expect(result.reservation.consumedAt).not.toBeNull();
    expect(result.walletTransactionId).not.toBeNull();
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 8000, reserved: 0, available: 8000 });
  });

  it("correlates the reservation to the exact ledger transaction it produced", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const result = await consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    const { data: txn } = await admin.from("wallet_transactions").select("amount, direction, user_id").eq("id", result.walletTransactionId!).single();
    expect(txn).toEqual({ amount: 2000, direction: "debit", user_id: userId });
    const stored = await getReservationById(reservation.id);
    expect(stored?.consumedTransactionId).toBe(result.walletTransactionId);
  });

  it("a second consume is a safe no-op — does not debit twice", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const first = await consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    const second = await consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    expect(second.outcome).toBe("already_consumed");
    expect(second.walletTransactionId).toBe(first.walletTransactionId);
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 8000, reserved: 0, available: 8000 });
  });

  it("a RELEASED reservation cannot be consumed", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    await releaseReservation(reservation.id);
    const result = await consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    expect(result.outcome).toBe("already_released");
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 0, available: 10000 });
  });
});

describe("Concurrency", () => {
  it("two concurrent reservations that would jointly overcommit — only one succeeds", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const results = await Promise.allSettled([
      reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() }),
      reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() }),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBe(1);
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 8000, available: 2000 });
  });

  it("reserve vs. an ordinary debit — cannot jointly overcommit", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const [reserveResult, debitResult] = await Promise.allSettled([
      reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() }),
      debit(userId, 5000),
    ]);
    const reserveOk = reserveResult.status === "fulfilled";
    const debitOk = debitResult.status === "fulfilled" && !(debitResult.value as { error: unknown }).error;
    // 8000 + 5000 > 10000 — both cannot have won.
    expect(reserveOk && debitOk).toBe(false);
    const summary = await getWalletBalanceSummary(userId);
    expect(summary.available).toBeGreaterThanOrEqual(0);
    expect(summary.reserved).toBeGreaterThanOrEqual(0);
  });

  it("reserve vs. an admin ad-hoc withdrawal debit — cannot jointly overcommit", async () => {
    const { userId } = await createUser();
    const adminId = await getAdminId();
    await deposit(userId, 10000);
    const withdraw = () =>
      admin.rpc("apply_wallet_transaction", {
        p_account_type: "user", p_user_id: userId, p_type: "manual_withdrawal", p_direction: "debit", p_amount: 5000,
        p_admin_id: adminId, p_reason: "test", p_idempotency_key: randomUUID(),
      });
    const [reserveResult, withdrawResult] = await Promise.allSettled([
      reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() }),
      withdraw(),
    ]);
    const reserveOk = reserveResult.status === "fulfilled";
    const withdrawOk = withdrawResult.status === "fulfilled" && !(withdrawResult.value as { error: unknown }).error;
    expect(reserveOk && withdrawOk).toBe(false);
  });

  it("release vs. consume on one ACTIVE reservation — exactly one terminal transition wins", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 2000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });

    const [releaseResult, consumeResult] = await Promise.allSettled([
      releaseReservation(reservation.id),
      consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() }),
    ]);

    const outcomes = [
      releaseResult.status === "fulfilled" ? releaseResult.value.outcome : null,
      consumeResult.status === "fulfilled" ? consumeResult.value.outcome : null,
    ];
    // Exactly one of the two must report having performed the real transition.
    const realTransitions = outcomes.filter((o) => o === "released" || o === "consumed");
    expect(realTransitions).toHaveLength(1);

    const final = await getReservationById(reservation.id);
    expect(["RELEASED", "CONSUMED"]).toContain(final?.status);
    // No double availability, no double debit: reserved is 0 either way, and total reflects exactly one branch.
    const summary = await getWalletBalanceSummary(userId);
    expect(summary.reserved).toBe(0);
    expect(summary.total === 10000 || summary.total === 8000).toBe(true);
  });

  it("consuming a reservation and an unrelated ordinary debit may both succeed if their combined amount is covered, but an over-large unrelated debit fails (§24)", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });

    const { error: exactErr } = await debit(userId, 2000);
    expect(exactErr).toBeNull();
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 8000, reserved: 8000, available: 0 });

    const consumeResult = await consumeReservation({ reservationId: reservation.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    expect(consumeResult.outcome).toBe("consumed");
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 0, reserved: 0, available: 0 });
  });

  it("an unrelated debit larger than available fails outright, leaving the reservation untouched", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const { error } = await debit(userId, 3000);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("insufficient_balance");
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 8000, available: 2000 });
  });
});

describe("Ordinary debits respect available balance", () => {
  it("a pool_entry_debit-shaped debit of exactly the available amount succeeds", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 6000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const { error } = await debit(userId, 4000);
    expect(error).toBeNull();
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 6000, reserved: 6000, available: 0 });
  });

  it("a pool_entry_debit-shaped debit above the available amount fails, funds unchanged", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 6000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const { error } = await debit(userId, 4001);
    expect(error).not.toBeNull();
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 6000, available: 4000 });
  });
});

describe("Deposits", () => {
  it("a deposit increases total without touching reservation state", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    await deposit(userId, 5000);
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 15000, reserved: 8000, available: 7000 });
  });
});

describe("Admin mutation cannot corrupt the reservation invariant", () => {
  it("an admin ad-hoc debit cannot dip below the currently-reserved floor", async () => {
    const { userId } = await createUser();
    const adminId = await getAdminId();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });

    const { error } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user", p_user_id: userId, p_type: "manual_withdrawal", p_direction: "debit", p_amount: 3000,
      p_admin_id: adminId, p_reason: "ad-hoc correction", p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("insufficient_balance");
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 10000, reserved: 8000, available: 2000 });
  });

  it("an admin ad-hoc debit within available still succeeds normally", async () => {
    const { userId } = await createUser();
    const adminId = await getAdminId();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 8000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });

    const { error } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user", p_user_id: userId, p_type: "manual_withdrawal", p_direction: "debit", p_amount: 1500,
      p_admin_id: adminId, p_reason: "ad-hoc correction", p_idempotency_key: randomUUID(),
    });
    expect(error).toBeNull();
    expect(await getWalletBalanceSummary(userId)).toEqual({ total: 8500, reserved: 8000, available: 500 });
  });
});

describe("Reconciliation", () => {
  it("reports no anomalies for a clean set of reservations", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 3000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const report = await checkWalletReservationConsistency();
    const anomaliesForUser = report.anomalies.filter((a) => a.userId === userId);
    expect(anomaliesForUser).toEqual([]);
  });

  it("detects a materialized reserved_balance that has drifted from the live sum of ACTIVE reservations", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    await reserveFunds({ userId, amount: 3000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });

    // Simulate drift by writing directly to wallet_balances, bypassing
    // every RPC — exactly the class of bug this check exists to catch.
    await admin.from("wallet_balances").update({ reserved_balance: 9999 }).eq("user_id", userId).eq("account_type", "user");

    const report = await checkWalletReservationConsistency();
    const anomaly = report.anomalies.find((a) => a.userId === userId && a.kind === "materialized_reserved_mismatch");
    expect(anomaly).toBeDefined();

    // Repair for cleanup's own sake before this test's afterEach runs.
    await admin.from("wallet_balances").update({ reserved_balance: 3000 }).eq("user_id", userId).eq("account_type", "user");
  });
});

describe("Property tests: value is never created or destroyed by reserve/release alone", () => {
  it("a sequence of credit/reserve/release/consume/debit always satisfies total = 0-basis invariants", async () => {
    const { userId } = await createUser();
    let expectedTotal = 0;

    async function assertInvariants() {
      const summary = await getWalletBalanceSummary(userId);
      expect(summary.total).toBeGreaterThanOrEqual(0);
      expect(summary.reserved).toBeGreaterThanOrEqual(0);
      expect(summary.available).toBeGreaterThanOrEqual(0);
      expect(summary.available).toBe(summary.total - summary.reserved);
      expect(summary.total).toBe(expectedTotal);
    }

    await deposit(userId, 10000);
    expectedTotal = 10000;
    await assertInvariants();

    const r1 = await reserveFunds({ userId, amount: 4000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    await assertInvariants(); // reserve alone never changes total

    await releaseReservation(r1.id);
    await assertInvariants(); // release alone never changes total

    const r2 = await reserveFunds({ userId, amount: 3000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    await consumeReservation({ reservationId: r2.id, walletTransactionType: "manual_withdrawal", adminId: null, reason: "test", idempotencyKey: randomUUID() });
    expectedTotal -= 3000;
    await assertInvariants(); // consume changes total by exactly the reservation amount

    const { error } = await debit(userId, 1000);
    expect(error).toBeNull();
    expectedTotal -= 1000;
    await assertInvariants();

    await deposit(userId, 2000);
    expectedTotal += 2000;
    await assertInvariants();
  });
});

describe("Security", () => {
  it("no authenticated client can call reserve_funds/release_reservation/consume_reservation directly (service_role only)", async () => {
    const { userId, client } = await createUser();
    await deposit(userId, 10000);

    const { error: reserveErr } = await client.rpc("reserve_funds", { p_user_id: userId, p_amount: 1000, p_purpose: "withdrawal_request", p_idempotency_key: randomUUID() });
    expect(reserveErr).not.toBeNull();

    const reservation = await reserveFunds({ userId, amount: 1000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const { error: releaseErr } = await client.rpc("release_reservation", { p_reservation_id: reservation.id });
    expect(releaseErr).not.toBeNull();
    const { error: consumeErr } = await client.rpc("consume_reservation", {
      p_reservation_id: reservation.id, p_wallet_txn_type: "manual_withdrawal", p_wallet_txn_admin_id: null, p_wallet_txn_reason: "test", p_wallet_txn_idempotency_key: randomUUID(),
    });
    expect(consumeErr).not.toBeNull();
  });

  it("a user can read their own reservations via RLS but not another user's", async () => {
    const { userId, client } = await createUser();
    const other = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 1000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });

    const { data: own } = await client.from("wallet_reservations").select("id").eq("id", reservation.id);
    expect(own).toHaveLength(1);
    const { data: others } = await other.client.from("wallet_reservations").select("id").eq("id", reservation.id);
    expect(others ?? []).toHaveLength(0);
  });

  it("no authenticated client can insert or update wallet_reservations directly", async () => {
    const { userId, client } = await createUser();
    await deposit(userId, 10000);

    const { data: insertData } = await client.from("wallet_reservations").insert({ user_id: userId, amount: 1000, purpose: "withdrawal_request", idempotency_key: randomUUID() }).select();
    expect(insertData ?? []).toHaveLength(0);

    const reservation = await reserveFunds({ userId, amount: 1000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const { error: updateErr } = await client.from("wallet_reservations").update({ status: "CONSUMED" }).eq("id", reservation.id);
    expect(updateErr).not.toBeNull();
    const stored = await getReservationById(reservation.id);
    expect(stored?.status).toBe("ACTIVE");
  });

  it("anon cannot read wallet_reservations at all", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const reservation = await reserveFunds({ userId, amount: 1000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });

    const anon = getTestAnonClient();
    const { data } = await anon.from("wallet_reservations").select("id").eq("id", reservation.id);
    expect(data ?? []).toEqual([]);
  });
});

describe("Read helpers", () => {
  it("listUserReservations returns a user's reservation history, most recent first", async () => {
    const { userId } = await createUser();
    await deposit(userId, 10000);
    const r1 = await reserveFunds({ userId, amount: 1000, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const r2 = await reserveFunds({ userId, amount: 500, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const list = await listUserReservations(userId);
    expect(list.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });
});
