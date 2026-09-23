/**
 * Integration tests for Milestone R8 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Wallet Reservation Layer) — reserve_funds()/release_reservation()/
 * consume_reservation(), apply_wallet_transaction()'s strengthened
 * available-balance check, reverse_pool_settlement()'s reservation-aware
 * dry-run extension, reconciliation, and security. Real local Supabase
 * throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { reserveFunds, releaseReservation, consumeReservation, getWalletBalanceSummary, getReservationById, listUserReservations } from "@/lib/wallet/reservations";
import { checkWalletReservationConsistency } from "@/lib/wallet/reconciliation";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();

const createdUserIds: string[] = [];
const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

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

async function getAdminId(): Promise<string> {
  const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
  return data!.id as string;
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
  if (createdPoolIds.length > 0) {
    const { data: settlementRows } = await admin.from("settlements").select("id").in("pool_id", createdPoolIds);
    const settlementIds = (settlementRows ?? []).map((s) => s.id);
    if (settlementIds.length > 0) await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
    await admin.from("settlements").delete().in("pool_id", createdPoolIds);
    await admin.from("notifications").delete().in("pool_id", createdPoolIds);
    await admin.from("entries").delete().in("pool_id", createdPoolIds);
    await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
    await admin.from("pools").delete().in("id", createdPoolIds);
    createdPoolIds.length = 0;
  }
  if (createdFixtureIds.length > 0) {
    await admin.from("fixtures").delete().in("id", createdFixtureIds);
    createdFixtureIds.length = 0;
  }
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

describe("Reversal remains a deliberately trusted path, but never silently violates the reservation invariant", () => {
  async function createTestFixture(): Promise<string> {
    const { data, error } = await admin
      .from("fixtures")
      .insert({
        external_fixture_id: `r8-reversal-${randomUUID()}`,
        home_team_name: "Home Test FC",
        away_team_name: "Away Test FC",
        home_team_external_id: "home-1",
        away_team_external_id: "away-1",
        scheduled_start_utc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        internal_status: "COMPLETED",
        regulation_home_score: 2,
        regulation_away_score: 0,
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("failed to create fixture");
    createdFixtureIds.push(data.id);
    return data.id;
  }

  async function createTestPool(fixtureId: string, adminId: string) {
    const { data: pool, error } = await admin
      .from("pools")
      .insert({
        fixture_id: fixtureId, created_by: adminId, pool_type: "CUSTOM", question: "What will the result be after regulation?",
        entry_fee: 1000, house_fee_bps: 1000, min_total_entries: 2,
        open_at: new Date().toISOString(), locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), status: "OPEN",
      })
      .select("id")
      .single();
    if (error || !pool) throw error ?? new Error("failed to create pool");
    createdPoolIds.push(pool.id);
    const { data: options, error: optionsError } = await admin
      .from("pool_options")
      .insert([
        { pool_id: pool.id, label: "Home Test FC", external_team_id: "home-1", sort_order: 0 },
        { pool_id: pool.id, label: "Draw", external_team_id: null, sort_order: 1 },
        { pool_id: pool.id, label: "Away Test FC", external_team_id: "away-1", sort_order: 2 },
      ])
      .select("id, label, external_team_id, sort_order")
      .order("sort_order");
    if (optionsError || !options) throw optionsError ?? new Error("failed to create options");
    return { poolId: pool.id as string, options };
  }

  function enter(poolId: string, userId: string, optionId: string, amount = 1000) {
    return admin.rpc("create_pool_entry", { p_pool_id: poolId, p_user_id: userId, p_option_id: optionId, p_amount: amount, p_idempotency_key: randomUUID() });
  }

  async function settlePool(poolId: string, adminId: string) {
    await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);
    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
    await admin.rpc("confirm_pool_settlement", { p_pool_id: poolId, p_admin_id: adminId, p_grading_version: settlement.grading_version, p_idempotency_key: randomUUID() });
    return settlement;
  }

  it("blocks a reversal that would push a winner's balance below their own ACTIVE reservation, with zero wallet writes", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    const winner = await createUser("r8-reversal-winner");
    const loser = await createUser("r8-reversal-loser");
    await deposit(winner.userId, 1000);
    await deposit(loser.userId, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    await settlePool(poolId, adminId);
    const summaryAfterSettlement = await getWalletBalanceSummary(winner.userId); // 0 + 1800 = 1800

    // The winner reserves nearly all of their fresh winnings (e.g. a
    // withdrawal request already in flight) before the reversal is
    // attempted.
    await reserveFunds({ userId: winner.userId, amount: 1700, purpose: "withdrawal_request", idempotencyKey: randomUUID() });
    const summaryBeforeReversal = await getWalletBalanceSummary(winner.userId);
    expect(summaryBeforeReversal).toEqual({ total: summaryAfterSettlement.total, reserved: 1700, available: summaryAfterSettlement.total - 1700 });

    const { data: pool, error } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId, p_admin_id: adminId, p_reason: "reservation-conflict test", p_idempotency_key: randomUUID(),
    });
    expect(error).toBeNull();
    expect(pool.status).toBe("REVERSAL_FAILED_MANUAL_REVIEW");

    // No money moved, and the reservation is untouched — this is a fail-safe abort, not a partial reversal.
    expect(await getWalletBalanceSummary(winner.userId)).toEqual(summaryBeforeReversal);

    const { data: settlement } = await admin
      .from("settlements")
      .select("reversal_shortfall_report")
      .eq("pool_id", poolId)
      .eq("grading_version", pool.snapshot_version)
      .single();
    const report = settlement!.reversal_shortfall_report as Array<{ userId: string; creditedAmount: number; currentBalance: number; reservedBalance: number; shortfall: number }>;
    const winnerRow = report.find((r) => r.userId === winner.userId)!;
    expect(winnerRow.reservedBalance).toBe(1700);
    expect(winnerRow.shortfall).toBeGreaterThan(0);
  });

  it("a reversal that does NOT conflict with a reservation still succeeds exactly as before this milestone", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    const winner = await createUser("r8-reversal-clean-winner");
    const loser = await createUser("r8-reversal-clean-loser");
    await deposit(winner.userId, 5000);
    await deposit(loser.userId, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    await settlePool(poolId, adminId);
    const before = await getWalletBalanceSummary(winner.userId); // 4000 + 1800 = 5800

    const { data: pool, error } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId, p_admin_id: adminId, p_reason: "clean reversal", p_idempotency_key: randomUUID(),
    });
    expect(error).toBeNull();
    expect(pool.status).toBe("READY_FOR_REVIEW");
    expect(await getWalletBalanceSummary(winner.userId)).toEqual({ total: before.total - 1800, reserved: 0, available: before.total - 1800 });
  });
});

/**
 * Milestone R13 (§27, §84) — legacy pools (PAID `create_pool_entry`) and
 * Brohda 2.0 P2P (`propose_money`/its reservation) are two independently
 * built products that share one `wallet_balances` row per user. §84 calls
 * stress-testing this interaction launch-critical. Architecturally this is
 * already safe by construction — `create_pool_entry` debits the wallet by
 * calling the SAME `apply_wallet_transaction()` R8 already hardened with
 * the available-balance check (supabase/migrations/
 * 20260101000128_free_mode_create_pool_entry.sql), not a second
 * independent implementation — but this suite proves it end-to-end through
 * both real RPCs rather than resting on that architectural argument alone.
 */
describe("Cross-product: legacy pool entries and P2P reservations share one wallet coherently", () => {
  async function createTestFixture(): Promise<string> {
    const { data, error } = await admin
      .from("fixtures")
      .insert({
        external_fixture_id: `r13-cross-${randomUUID()}`,
        home_team_name: "Home Test FC",
        away_team_name: "Away Test FC",
        home_team_external_id: "home-1",
        away_team_external_id: "away-1",
        scheduled_start_utc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        internal_status: "NOT_STARTED",
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("failed to create fixture");
    createdFixtureIds.push(data.id);
    return data.id;
  }

  async function createTestPool(fixtureId: string, adminId: string) {
    const { data: pool, error } = await admin
      .from("pools")
      .insert({
        fixture_id: fixtureId, created_by: adminId, pool_type: "CUSTOM", question: "Cross-product test pool",
        entry_fee: 1000, house_fee_bps: 500, min_total_entries: 1,
        open_at: new Date().toISOString(), locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), status: "OPEN",
      })
      .select("id")
      .single();
    if (error || !pool) throw error ?? new Error("failed to create pool");
    createdPoolIds.push(pool.id);
    const { data: options, error: optionsError } = await admin
      .from("pool_options")
      .insert([
        { pool_id: pool.id, label: "Home Test FC", external_team_id: "home-1", sort_order: 0 },
        { pool_id: pool.id, label: "Away Test FC", external_team_id: "away-1", sort_order: 1 },
      ])
      .select("id, label, sort_order")
      .order("sort_order");
    if (optionsError || !options) throw optionsError ?? new Error("failed to create options");
    return { poolId: pool.id as string, options };
  }

  function enter(poolId: string, userId: string, optionId: string, amount = 1000) {
    return admin.rpc("create_pool_entry", { p_pool_id: poolId, p_user_id: userId, p_option_id: optionId, p_amount: amount, p_idempotency_key: randomUUID() });
  }

  const createdMarketIds: string[] = [];

  beforeEach(async () => {
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, monetary_proposal_rate_limit_window_seconds: 60, monetary_proposal_rate_limit_max_attempts: 10, p2p_fee_bps: 0 }).eq("id", true);
  });

  async function createMarket(): Promise<string> {
    const { data: fixture, error: fixtureErr } = await admin
      .from("fixtures")
      .insert({
        external_fixture_id: `r13-cross-market-${randomUUID()}`,
        home_team_name: "Home Test NFL",
        away_team_name: "Away Test NFL",
        scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        internal_status: "NOT_STARTED",
      })
      .select("id")
      .single();
    if (fixtureErr || !fixture) throw fixtureErr ?? new Error("failed to create fixture");
    createdFixtureIds.push(fixture.id);

    const { data: market, error: marketErr } = await admin
      .from("markets")
      .insert({
        provider: "r13_cross",
        provider_market_id: `active_${randomUUID()}`,
        question: `R13 cross-product test: ${randomUUID()}`,
        status: "ACTIVE",
        fixture_id: fixture.id,
        market_template: "MONEYLINE",
        yes_side: "HOME",
        yes_price: 0.6,
        no_price: 0.4,
        liquidity: 1000,
        last_synced_at: new Date().toISOString(),
        ingestion_source: "test",
        provider_metadata: {},
      })
      .select("id")
      .single();
    if (marketErr || !market) throw marketErr ?? new Error("failed to create market");
    createdMarketIds.push(market.id);
    return market.id as string;
  }

  async function pick(userId: string, marketId: string, selectedOutcome: "YES" | "NO") {
    const { data, error } = await admin
      .from("predictions")
      .insert({
        user_id: userId,
        market_id: marketId,
        selected_outcome: selectedOutcome,
        yes_probability_snapshot: 0.6,
        no_probability_snapshot: 0.4,
        market_question_snapshot: "q",
        market_close_at_snapshot: null,
        market_status_snapshot: "ACTIVE",
        idempotency_key: randomUUID(),
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("pick failed");
    return data.id as string;
  }

  afterEach(async () => {
    if (createdMarketIds.length > 0) {
      await admin.from("monetary_proposals").delete().in("market_id", createdMarketIds);
      await admin.from("predictions").delete().in("market_id", createdMarketIds);
      await admin.from("markets").delete().in("id", createdMarketIds);
      createdMarketIds.length = 0;
    }
  });

  it("a P2P proposal that would overcommit funds already tied up in a real PAID pool entry is rejected", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const marketId = await createMarket();

    const proposer = await createUser("r13-cross-proposer");
    const recipient = await createUser("r13-cross-recipient");
    await deposit(proposer.userId, 1500);
    await deposit(recipient.userId, 5000);

    // Real legacy PAID pool entry — debits 1000 via apply_wallet_transaction, leaving 500 available.
    const { error: entryError } = await enter(poolId, proposer.userId, options[0].id, 1000);
    expect(entryError).toBeNull();
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 500, reserved: 0, available: 500 });

    const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
    const recipientPredictionId = await pick(recipient.userId, marketId, "NO");

    // A P2P proposal for 800 exceeds the 500 actually available after the pool entry — must be rejected by propose_money's own reservation, not silently allowed to overcommit.
    const { error: proposeError } = await admin.rpc("propose_money", {
      p_proposer_user_id: proposer.userId,
      p_recipient_prediction_id: recipientPredictionId,
      p_stake: 800,
      p_idempotency_key: randomUUID(),
      p_source_challenge_id: null,
    });
    expect(proposeError).not.toBeNull();
    expect(proposeError!.message).toContain("insufficient_available_balance");
    // Nothing changed — the failed proposal left no reservation and no wallet write.
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 500, reserved: 0, available: 500 });
    void proposerPredictionId;
  });

  it("a P2P proposal within actual available funds succeeds and coexists correctly with the pool entry's own debit", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const marketId = await createMarket();

    const proposer = await createUser("r13-cross-proposer2");
    const recipient = await createUser("r13-cross-recipient2");
    await deposit(proposer.userId, 1500);
    await deposit(recipient.userId, 5000);

    const { error: entryError } = await enter(poolId, proposer.userId, options[0].id, 1000);
    expect(entryError).toBeNull();
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 500, reserved: 0, available: 500 });

    const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
    const recipientPredictionId = await pick(recipient.userId, marketId, "NO");

    const { error: proposeError } = await admin.rpc("propose_money", {
      p_proposer_user_id: proposer.userId,
      p_recipient_prediction_id: recipientPredictionId,
      p_stake: 500,
      p_idempotency_key: randomUUID(),
      p_source_challenge_id: null,
    });
    expect(proposeError).toBeNull();
    // The pool entry's debit (total -1000) and the P2P reservation (reserved +500) both hold simultaneously, correctly, on the one shared wallet.
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 500, reserved: 500, available: 0 });

    // A second, unrelated ordinary debit attempt now correctly fails — available is genuinely 0 across both products combined.
    const { error: overdraftError } = await debit(proposer.userId, 1);
    expect(overdraftError).not.toBeNull();
    void proposerPredictionId;
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
