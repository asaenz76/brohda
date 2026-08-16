/**
 * Integration tests for settlement reversal (spec §17's dry-run-then-
 * execute-or-block workflow, re-settlement with an incremented snapshot
 * version, and the abort path). Run with:
 * pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

async function createTestPlayer(email: string, balanceCents = 0) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    role: "player",
    is_active: true,
  });

  if (balanceCents > 0) {
    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: data.user.id,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: balanceCents,
      p_admin_id: null,
      p_reason: "test funding",
      p_idempotency_key: randomUUID(),
    });
  }

  return { userId: data.user.id as string };
}

async function deactivate(userId: string) {
  await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
}

const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

async function createTestFixture(
  overrides: Partial<{
    regulationHomeScore: number | null;
    regulationAwayScore: number | null;
  }> = {},
): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `reversal-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      home_team_external_id: "home-1",
      away_team_external_id: "away-1",
      scheduled_start_utc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      internal_status: "COMPLETED",
      regulation_home_score: overrides.regulationHomeScore ?? 2,
      regulation_away_score: overrides.regulationAwayScore ?? 0,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  createdFixtureIds.push(data.id as string);
  return data.id as string;
}

async function createTestPool(fixtureId: string, adminId: string) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: "REGULATION_RESULT",
      question: "What will the result be after regulation?",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create test pool");
  createdPoolIds.push(pool.id as string);

  const { data: options, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Home Test FC", external_team_id: "home-1", sort_order: 0 },
      { pool_id: pool.id, label: "Draw", external_team_id: null, sort_order: 1 },
      { pool_id: pool.id, label: "Away Test FC", external_team_id: "away-1", sort_order: 2 },
    ])
    .select("id, label, external_team_id, sort_order")
    .order("sort_order");
  if (optionsError || !options) throw optionsError ?? new Error("failed to create test options");

  return { poolId: pool.id as string, options };
}

function enter(poolId: string, userId: string, optionId: string, amount = 1000) {
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amount,
    p_idempotency_key: randomUUID(),
  });
}

async function getAdminId(): Promise<string> {
  const { data } = await admin
    .from("user_profiles")
    .select("id")
    .eq("role", "super_admin")
    .eq("is_active", true)
    .limit(1)
    .single();
  return data!.id as string;
}

async function getBalance(userId: string): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("user_id", userId).single();
  return data!.balance as number;
}

async function settlePool(poolId: string, homeOptionId: string, adminId: string) {
  await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);
  const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
  await admin.rpc("confirm_pool_settlement", {
    p_pool_id: poolId,
    p_admin_id: adminId,
    p_grading_version: settlement.grading_version,
    p_idempotency_key: randomUUID(),
  });
  return settlement;
}

describe.skipIf(!SERVICE_ROLE_KEY)("settlement reversal", () => {
  let adminId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      const { data: settlementRows } = await admin
        .from("settlements")
        .select("id")
        .in("pool_id", createdPoolIds);
      const settlementIds = (settlementRows ?? []).map((s) => s.id);
      if (settlementIds.length > 0) {
        await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
      }
      await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      await admin.from("notifications").delete().in("pool_id", createdPoolIds);
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
  });

  it("reverses a settlement, debiting the winner and house, and re-settles with a new snapshot", async () => {
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    const winner = await createTestPlayer(`reversal-happy-a-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`reversal-happy-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    const originalSettlement = await settlePool(poolId, home.id, adminId);
    expect(await getBalance(winner.userId)).toBe(5000 - 1000 + 1800);

    const { data: pool, error } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "corrected result",
      p_idempotency_key: randomUUID(),
    });
    expect(error).toBeNull();
    expect(pool.status).toBe("READY_FOR_REVIEW");
    expect(pool.snapshot_version).toBe(originalSettlement.grading_version + 1);

    // Winner's payout and the house's cut were clawed back.
    expect(await getBalance(winner.userId)).toBe(5000 - 1000);

    const { data: reversedSettlement } = await admin
      .from("settlements")
      .select("*")
      .eq("id", originalSettlement.id)
      .single();
    expect(reversedSettlement!.reversed_at).not.toBeNull();
    expect(reversedSettlement!.reversal_reason).toBe("corrected result");

    // Entries were reset so the fresh settlement grades from a clean slate.
    const { data: entryStatuses } = await admin.from("entries").select("status").eq("pool_id", poolId);
    expect(entryStatuses?.every((e) => e.status === "ACTIVE")).toBe(true);

    // Re-confirm the new snapshot — settles correctly a second time.
    const { data: newSettlement } = await admin
      .from("settlements")
      .select("*")
      .eq("pool_id", poolId)
      .eq("grading_version", pool.snapshot_version)
      .single();
    expect(newSettlement!.winning_option_id).toBe(home.id);

    await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: newSettlement!.grading_version,
      p_idempotency_key: randomUUID(),
    });
    expect(await getBalance(winner.userId)).toBe(5000 - 1000 + 1800);

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });

  it("blocks the reversal when a winner's balance can't absorb it, with a correct shortfall report and no wallet writes", async () => {
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    // Winner starts with just enough to enter, then spends their winnings
    // via a withdrawal so the reversal can't be absorbed.
    const winner = await createTestPlayer(`reversal-blocked-a-${Date.now()}@example.com`, 1000);
    const loser = await createTestPlayer(`reversal-blocked-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    await settlePool(poolId, home.id, adminId);
    const balanceAfterSettlement = await getBalance(winner.userId); // 0 + 1800 = 1800

    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: winner.userId,
      p_type: "manual_withdrawal",
      p_direction: "debit",
      p_amount: 1700,
      p_admin_id: adminId,
      p_reason: "spent winnings",
      p_idempotency_key: randomUUID(),
    });
    const balanceBeforeReversal = await getBalance(winner.userId); // 100

    const { data: pool, error } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "attempted reversal",
      p_idempotency_key: randomUUID(),
    });
    expect(error).toBeNull();
    expect(pool.status).toBe("REVERSAL_FAILED_MANUAL_REVIEW");

    // No money moved.
    expect(await getBalance(winner.userId)).toBe(balanceBeforeReversal);

    const { data: settlement } = await admin
      .from("settlements")
      .select("reversal_shortfall_report")
      .eq("pool_id", poolId)
      .eq("grading_version", pool.snapshot_version)
      .single();
    const report = settlement!.reversal_shortfall_report as Array<{
      userId: string;
      creditedAmount: number;
      currentBalance: number;
      shortfall: number;
    }>;
    const winnerRow = report.find((r) => r.userId === winner.userId)!;
    expect(winnerRow.creditedAmount).toBe(1800);
    expect(winnerRow.currentBalance).toBe(balanceBeforeReversal);
    expect(winnerRow.shortfall).toBe(1800 - balanceBeforeReversal);
    void balanceAfterSettlement;

    // Retry after the admin tops the winner back up — succeeds.
    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: winner.userId,
      p_type: "admin_adjustment_credit",
      p_direction: "credit",
      p_amount: 1700,
      p_admin_id: adminId,
      p_reason: "restoring for reversal retry",
      p_idempotency_key: randomUUID(),
    });

    const { data: retriedPool, error: retryError } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "retry after top-up",
      p_idempotency_key: randomUUID(),
    });
    expect(retryError).toBeNull();
    expect(retriedPool.status).toBe("READY_FOR_REVIEW");
    // 100 (pre-topup) + 1700 (topup) - 1800 (clawback) = 0
    expect(await getBalance(winner.userId)).toBe(0);

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });

  it("aborts a blocked reversal back to SETTLED with no financial effect", async () => {
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    const winner = await createTestPlayer(`reversal-abort-a-${Date.now()}@example.com`, 1000);
    const loser = await createTestPlayer(`reversal-abort-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    await settlePool(poolId, home.id, adminId);

    // Drain most of the payout so the reversal can't be absorbed.
    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: winner.userId,
      p_type: "manual_withdrawal",
      p_direction: "debit",
      p_amount: 1000,
      p_admin_id: adminId,
      p_reason: "spent some winnings",
      p_idempotency_key: randomUUID(),
    });
    const balanceAfterSettlement = await getBalance(winner.userId);

    const { data: blockedPool } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "will be aborted",
      p_idempotency_key: randomUUID(),
    });
    expect(blockedPool.status).toBe("REVERSAL_FAILED_MANUAL_REVIEW");

    const { data: abortedPool, error } = await admin.rpc("abort_pool_reversal", {
      p_pool_id: poolId,
      p_admin_id: adminId,
    });
    expect(error).toBeNull();
    expect(abortedPool.status).toBe("SETTLED");
    expect(await getBalance(winner.userId)).toBe(balanceAfterSettlement);

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });

  it("rejects reversing a pool that has already moved past SETTLED (no double-debit)", async () => {
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    const winner = await createTestPlayer(`reversal-twice-a-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`reversal-twice-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);
    await settlePool(poolId, home.id, adminId);

    const first = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "first reversal",
      p_idempotency_key: randomUUID(),
    });
    expect(first.error).toBeNull();
    const balanceAfterFirstReversal = await getBalance(winner.userId);

    // The pool is now READY_FOR_REVIEW, not SETTLED/REVERSAL_FAILED_MANUAL_REVIEW.
    const second = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "second attempt",
      p_idempotency_key: randomUUID(),
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain("pool_not_reversible");
    expect(await getBalance(winner.userId)).toBe(balanceAfterFirstReversal);

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });
});
