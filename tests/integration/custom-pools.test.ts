/**
 * Integration tests for CUSTOM (from-scratch, no-fixture) pools and the
 * new super_admin "Grade Manually" path (prepare_pool_settlement_manual).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
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

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `custom-pool-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  return data.id as string;
}

const createdPoolIds: string[] = [];

async function createCustomPool(
  creatorId: string,
  options: string[],
  overrides: Partial<{ status: string }> = {},
) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: null,
      created_by: creatorId,
      pool_type: "CUSTOM",
      question: "Who will win the election?",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: overrides.status ?? "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create custom pool");
  createdPoolIds.push(pool.id as string);

  const { data: optionRows, error: optionsError } = await admin
    .from("pool_options")
    .insert(options.map((label, i) => ({ pool_id: pool.id, label, sort_order: i })))
    .select("id");
  if (optionsError || !optionRows) throw optionsError ?? new Error("failed to create options");

  return { poolId: pool.id as string, optionIds: optionRows.map((o) => o.id as string) };
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

async function getBalance(userId: string): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("user_id", userId).single();
  return data!.balance as number;
}

describe.skipIf(!SERVICE_ROLE_KEY)("CUSTOM pools + manual grading", () => {
  let adminId: string;
  let fixtureId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
    fixtureId = await createTestFixture();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      // settlement_payouts FKs to both entries and settlements, so it must
      // be deleted before either — deleting entries first (as an earlier
      // version of this cleanup did) fails on that FK, and since none of
      // these results were checked, the failure was silently swallowed and
      // every later delete in this list cascaded into failing too.
      const { data: settlementRows } = await admin
        .from("settlements")
        .select("id")
        .in("pool_id", createdPoolIds);
      const settlementIds = (settlementRows ?? []).map((s) => s.id);

      if (settlementIds.length > 0) {
        const { error } = await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
        if (error) throw error;
      }

      // Also FKs to settlements (and independently to pools) — must clear
      // before settlements can be deleted.
      let result = await admin.from("correct_prediction_log").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("entries").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("pools").delete().in("id", createdPoolIds);
      if (result.error) throw result.error;
    }
    await admin.from("fixtures").delete().eq("id", fixtureId);
  });

  it("creates a CUSTOM pool with no fixture and 3 free-text options", async () => {
    const { poolId, optionIds } = await createCustomPool(adminId, ["Alice", "Bob", "Carol"]);

    const { data: pool } = await admin.from("pools").select("fixture_id, pool_type, question").eq("id", poolId).single();
    expect(pool?.fixture_id).toBeNull();
    expect(pool?.pool_type).toBe("CUSTOM");
    expect(optionIds).toHaveLength(3);
  });

  it("progresses DRAFT -> OPEN -> LOCKED with no fixture dependency", async () => {
    const { poolId } = await createCustomPool(adminId, ["Yes", "No"], { status: "DRAFT" });

    let { error } = await admin.from("pools").update({ status: "OPEN" }).eq("id", poolId).eq("status", "DRAFT");
    expect(error).toBeNull();

    ({ error } = await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId).eq("status", "OPEN"));
    expect(error).toBeNull();

    const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(pool?.status).toBe("LOCKED");
  });

  it("prepare_pool_settlement_manual refuses a pool that isn't LOCKED or AWAITING_RESULT", async () => {
    const { poolId } = await createCustomPool(adminId, ["Yes", "No"], { status: "OPEN" });

    const { error } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    expect(error?.message).toContain("pool_not_gradable");
  });

  it("prepare_pool_settlement_manual on a pool with zero entries routes straight to refund, not a winner pick", async () => {
    const { poolId } = await createCustomPool(adminId, ["Yes", "No"], { status: "LOCKED" });

    const { data: settlement, error } = await admin.rpc("prepare_pool_settlement_manual", {
      p_pool_id: poolId,
    });
    expect(error).toBeNull();
    // No entries -> no possible winner regardless of what gets picked later,
    // so this must NOT ask an admin to pick one (that would always fail
    // confirm_pool_settlement's own no-winner guard afterwards).
    expect(settlement.requires_manual_verification).toBe(false);
    expect(settlement.outcome).toBe("NO_WINNING_ENTRIES_REFUND");
    expect(settlement.winning_option_id).toBeNull();
    expect(settlement.provider_status).toBe("MANUAL");

    const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(pool?.status).toBe("READY_FOR_REVIEW");
  });

  it("prepare_pool_settlement_manual on a pool with real entries requires manual verification", async () => {
    const p1 = await createTestPlayer(`custom-manual-a-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createCustomPool(adminId, ["Yes", "No"], { status: "OPEN" });

    await enter(poolId, p1.userId, optionIds[0]);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    const { data: settlement, error } = await admin.rpc("prepare_pool_settlement_manual", {
      p_pool_id: poolId,
    });
    expect(error).toBeNull();
    expect(settlement.requires_manual_verification).toBe(true);
    expect(settlement.outcome).toBe("NORMAL");
    expect(settlement.winning_option_id).toBeNull();

    await deactivate(p1.userId);
  });

  it("is idempotent: a repeat call at the same snapshot_version returns the existing settlement", async () => {
    const { poolId } = await createCustomPool(adminId, ["Yes", "No"], { status: "LOCKED" });

    const first = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    const second = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });

    expect(second.data.id).toBe(first.data.id);
  });

  // undo_pool_grading (lib/actions/settlements.ts's undoPoolGradingAction):
  // a pure state-machine revert for an unconfirmed READY_FOR_REVIEW pool —
  // no wallet transaction has run yet at this point, so this is safe and
  // reversible, unlike the separate (money-moving) Settlement Reversal flow
  // for an already-confirmed settlement.
  it("undo_pool_grading reverts an unconfirmed pool back to LOCKED and removes its settlement", async () => {
    const { poolId } = await createCustomPool(adminId, ["Yes", "No"], { status: "LOCKED" });

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    const { data: poolAfterPrepare } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(poolAfterPrepare?.status).toBe("READY_FOR_REVIEW");

    const { data: reverted, error } = await admin.rpc("undo_pool_grading", {
      p_pool_id: poolId,
      p_admin_id: adminId,
    });
    expect(error).toBeNull();
    expect(reverted?.status).toBe("LOCKED");

    const { data: settlementAfter } = await admin
      .from("settlements")
      .select("id")
      .eq("id", settlement.id)
      .maybeSingle();
    expect(settlementAfter).toBeNull();

    // Re-grading from a clean slate works — same snapshot_version, no
    // leftover settlement blocking a fresh prepare call.
    const { data: secondAttempt, error: secondError } = await admin.rpc("prepare_pool_settlement_manual", {
      p_pool_id: poolId,
    });
    expect(secondError).toBeNull();
    expect(secondAttempt.id).not.toBe(settlement.id);
  });

  it("undo_pool_grading refuses a pool that isn't pending review", async () => {
    const { poolId } = await createCustomPool(adminId, ["Yes", "No"], { status: "LOCKED" });

    const { error } = await admin.rpc("undo_pool_grading", { p_pool_id: poolId, p_admin_id: adminId });
    expect(error?.message).toContain("pool_not_pending_review");
  });

  it("undo_pool_grading refuses once the settlement is already confirmed", async () => {
    const { poolId } = await createCustomPool(adminId, ["Yes", "No"], { status: "LOCKED" });

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "NO_WINNING_ENTRIES",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });

    // Defensive-only scenario (every real confirm path also advances the
    // pool off READY_FOR_REVIEW in the same call, so this combination can't
    // occur through the app) — forced here to prove the confirmed_at guard
    // itself works, not just the status guard above it.
    await admin.from("pools").update({ status: "READY_FOR_REVIEW" }).eq("id", poolId);

    const { error } = await admin.rpc("undo_pool_grading", { p_pool_id: poolId, p_admin_id: adminId });
    expect(error?.message).toContain("settlement_already_confirmed");
  });

  it("confirm_pool_settlement with a chosen winner pays out correctly for a CUSTOM pool", async () => {
    const p1 = await createTestPlayer(`custom-payout-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`custom-payout-b-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createCustomPool(adminId, ["Alice", "Bob"], { status: "OPEN" });

    await enter(poolId, p1.userId, optionIds[0]);
    await enter(poolId, p2.userId, optionIds[1]);

    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    expect(settlement.requires_manual_verification).toBe(true);

    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: optionIds[0],
    });
    expect(confirmError).toBeNull();

    // Pot: 2000 gross, 10% house fee -> 1800 net, 1 winner -> full 1800 payout.
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  // Reproduces a real bug reported live: an admin manually picking a
  // winning option that happens to have zero entries (nobody backed the
  // actually-correct side) got a dead-end "may be stale" error with no way
  // to complete grading, because confirm_pool_settlement's own no-winner
  // guard has no recovery path baked in — the app layer (confirmSettlementAction)
  // must detect this beforehand and route to confirm_pool_refund instead.
  // This test protects the RPC-level contract that fix depends on: the
  // exact rejection reason, and that confirm_pool_refund cleanly recovers
  // at the same grading_version with a full no-fee refund.
  it("confirm_pool_settlement refuses a manually-picked winner with zero entries, recoverable via confirm_pool_refund with no fee taken", async () => {
    const p1 = await createTestPlayer(`custom-zero-winner-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createCustomPool(adminId, ["Yes", "No"], { status: "OPEN" });

    await enter(poolId, p1.userId, optionIds[1]); // picks "No"
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    expect(settlement.requires_manual_verification).toBe(true);

    const { error: settleError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: optionIds[0], // "Yes" — zero entries
    });
    expect(settleError?.message).toContain("no_or_all_winner_use_confirm_pool_refund");

    const { data: pool, error: refundError } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "NO_WINNING_ENTRIES",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });
    expect(refundError).toBeNull();
    expect(pool?.status).toBe("VOIDED");
    expect(pool?.void_reason).toBe("NO_WINNING_ENTRIES");

    // Full refund, no platform fee taken — per product decision, unlike
    // COMBO's confirm_combo_refund_fee_retained.
    expect(await getBalance(p1.userId)).toBe(5000);

    await deactivate(p1.userId);
  });

  it("also grades a real-fixture pool manually while LOCKED, before any score exists", async () => {
    const p1 = await createTestPlayer(`real-fixture-manual-${Date.now()}@example.com`, 5000);

    const { data: pool, error } = await admin
      .from("pools")
      .insert({
        fixture_id: fixtureId,
        created_by: adminId,
        pool_type: "WHO_WILL_ADVANCE",
        question: "Who will advance?",
        entry_fee: 1000,
        house_fee_bps: 1000,
        min_total_entries: 2,
        open_at: new Date().toISOString(),
        locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        status: "OPEN",
      })
      .select("id")
      .single();
    if (error || !pool) throw error ?? new Error("failed to create real-fixture test pool");
    createdPoolIds.push(pool.id as string);

    const { data: options } = await admin
      .from("pool_options")
      .insert([
        { pool_id: pool.id, label: "Home Test FC", sort_order: 0 },
        { pool_id: pool.id, label: "Away Test FC", sort_order: 1 },
      ])
      .select("id");

    await enter(pool.id, p1.userId, options![0].id);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", pool.id);

    const { data: settlement, error: gradeError } = await admin.rpc(
      "prepare_pool_settlement_manual",
      { p_pool_id: pool.id },
    );
    expect(gradeError).toBeNull();
    expect(settlement.requires_manual_verification).toBe(true);
    expect(settlement.outcome).toBe("NORMAL");

    const { data: poolAfter } = await admin.from("pools").select("status").eq("id", pool.id).single();
    expect(poolAfter?.status).toBe("READY_FOR_REVIEW");

    await deactivate(p1.userId);
  });

  it("cancels an OPEN CUSTOM pool via confirm_pool_refund(ADMIN_MANUAL_CANCEL), refunding the active entry", async () => {
    const p1 = await createTestPlayer(`custom-cancel-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createCustomPool(adminId, ["Yes", "No"], { status: "OPEN" });

    await enter(poolId, p1.userId, optionIds[0]);
    expect(await getBalance(p1.userId)).toBe(4000);

    const { data: cancelledPool, error } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "ADMIN_MANUAL_CANCEL",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
    });
    expect(error).toBeNull();
    expect(cancelledPool.status).toBe("CANCELLED");

    const { data: entry } = await admin
      .from("entries")
      .select("status")
      .eq("pool_id", poolId)
      .eq("user_id", p1.userId)
      .single();
    expect(entry?.status).toBe("REFUNDED");
    expect(await getBalance(p1.userId)).toBe(5000);

    await deactivate(p1.userId);
  });

  it("reverses a manually-graded CUSTOM pool's settlement back to READY_FOR_REVIEW instead of erroring fixture_not_found", async () => {
    const p1 = await createTestPlayer(`custom-reverse-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`custom-reverse-b-${Date.now()}@example.com`, 5000);
    const { poolId, optionIds } = await createCustomPool(adminId, ["Alice", "Bob"], { status: "OPEN" });

    await enter(poolId, p1.userId, optionIds[0]);
    await enter(poolId, p2.userId, optionIds[1]);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: optionIds[0],
    });
    expect(confirmError).toBeNull();
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);

    const { data: reversedPool, error: reverseError } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "test reversal",
      p_idempotency_key: randomUUID(),
    });
    expect(reverseError).toBeNull();
    // Before the fixture_id branch fix, this call would have errored
    // fixture_not_found instead of landing back on READY_FOR_REVIEW.
    expect(reversedPool.status).toBe("READY_FOR_REVIEW");
    expect(reversedPool.snapshot_version).toBe(settlement.grading_version + 1);
    expect(await getBalance(p1.userId)).toBe(5000 - 1000);

    const { data: newSettlement } = await admin
      .from("settlements")
      .select("*")
      .eq("pool_id", poolId)
      .eq("grading_version", reversedPool.snapshot_version)
      .single();
    expect(newSettlement?.requires_manual_verification).toBe(true);
    expect(newSettlement?.outcome).toBe("NORMAL");

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("reverses a real-fixture pool that was settled via Grade Manually using the automatic re-settle path", async () => {
    const p1 = await createTestPlayer(`real-fixture-reverse-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`real-fixture-reverse-b-${Date.now()}@example.com`, 5000);

    const { data: pool, error } = await admin
      .from("pools")
      .insert({
        fixture_id: fixtureId,
        created_by: adminId,
        pool_type: "WHO_WILL_ADVANCE",
        question: "Who will advance? (reversal test)",
        entry_fee: 1000,
        house_fee_bps: 1000,
        min_total_entries: 2,
        open_at: new Date().toISOString(),
        locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        status: "OPEN",
      })
      .select("id")
      .single();
    if (error || !pool) throw error ?? new Error("failed to create real-fixture test pool");
    createdPoolIds.push(pool.id as string);

    const { data: options } = await admin
      .from("pool_options")
      .insert([
        { pool_id: pool.id, label: "Home Test FC", sort_order: 0 },
        { pool_id: pool.id, label: "Away Test FC", sort_order: 1 },
      ])
      .select("id");

    await enter(pool.id, p1.userId, options![0].id);
    await enter(pool.id, p2.userId, options![1].id);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", pool.id);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: pool.id });
    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: pool.id,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: options![0].id,
    });
    expect(confirmError).toBeNull();

    const { data: reversedPool, error: reverseError } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: pool.id,
      p_admin_id: adminId,
      p_reason: "test reversal — real fixture",
      p_idempotency_key: randomUUID(),
    });
    expect(reverseError).toBeNull();
    expect(reversedPool.status).toBe("READY_FOR_REVIEW");

    // fixture_id is not null, so the automatic path (prepare_pool_settlement)
    // must have been used, not prepare_pool_settlement_manual — this
    // fixture's scores are still null, so the automatic derivation can't
    // pick a winner and falls back to requiring manual verification, but
    // critically the call succeeds at all (proves the branch picked the
    // automatic path rather than erroring on a null-checked manual-only field).
    const { data: newSettlement } = await admin
      .from("settlements")
      .select("*")
      .eq("pool_id", pool.id)
      .eq("grading_version", reversedPool.snapshot_version)
      .single();
    expect(newSettlement?.requires_manual_verification).toBe(true);
    expect(newSettlement?.provider_status).not.toBe("MANUAL");

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });
});
