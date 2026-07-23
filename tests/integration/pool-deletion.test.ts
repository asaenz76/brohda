/**
 * Integration tests for delete_terminal_pool, the atomic SQL function
 * deletePoolAction/bulkDeletePoolsAction (lib/actions/pool-lifecycle.ts)
 * call — the actions themselves call requireSuperAdmin(), which needs a
 * real Next.js request/cookie context and can't be invoked directly from a
 * Vitest process (same limitation as every other requireSuperAdmin-gated
 * action in this codebase, verified live in the browser instead). What CAN
 * be verified here — and is the riskiest part to get right — is the
 * function itself: the FK-dependency deletion order, the guard that blocks
 * deleting a pool that's still mid-lifecycle, and the leaderboard-stat
 * rollback for a settled pool's WON entries.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

function enter(poolId: string, userId: string, optionId: string, amount = 1000) {
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: amount,
    p_idempotency_key: randomUUID(),
  });
}

const createdPoolIds: string[] = [];

async function createComboPoolForDeletion(creatorId: string) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: null,
      created_by: creatorId,
      pool_type: "COMBO",
      title: "Deletion test pool",
      question: "Will this pool get deleted cleanly?",
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

  const { data: options } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Yes", sort_order: 0 },
      { pool_id: pool.id, label: "No", sort_order: 1 },
    ])
    .select("id, label");

  await admin
    .from("pool_combo_legs")
    .insert([{ pool_id: pool.id, label: "Leg A", sort_order: 0 }]);

  return { poolId: pool.id as string, options: options ?? [] };
}

describe.skipIf(!SERVICE_ROLE_KEY)("delete_terminal_pool", () => {
  let adminId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    // Anything left over on failure — best-effort, same shape as every
    // other suite's afterAll.
    if (createdPoolIds.length > 0) {
      await admin.from("pool_combo_legs").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
  });

  it("deletes a zero-entry COMBO pool (options + legs + likes cascade, notification pool_id nulled)", async () => {
    const player = await createTestPlayer(`pool-delete-${Date.now()}@example.com`);
    const { poolId } = await createComboPoolForDeletion(adminId);

    await admin.from("pool_likes").insert({ pool_id: poolId, user_id: player.userId });
    const { data: notification } = await admin
      .from("notifications")
      .insert({
        user_id: player.userId,
        type: "TEST",
        title: "Test notification",
        body: "Referencing the soon-to-be-deleted pool.",
        pool_id: poolId,
      })
      .select("id")
      .single();

    const { error } = await admin.rpc("delete_terminal_pool", {
      p_pool_id: poolId,
      p_admin_id: adminId,
    });
    expect(error).toBeNull();

    const { data: pool } = await admin.from("pools").select("id").eq("id", poolId).maybeSingle();
    expect(pool).toBeNull();

    const { data: options } = await admin.from("pool_options").select("id").eq("pool_id", poolId);
    expect(options).toEqual([]);

    const { data: legs } = await admin.from("pool_combo_legs").select("id").eq("pool_id", poolId);
    expect(legs).toEqual([]);

    // pool_likes has ON DELETE CASCADE — removed automatically with the pool.
    const { data: likes } = await admin.from("pool_likes").select("id").eq("pool_id", poolId);
    expect(likes).toEqual([]);

    // Notification history is kept, just detached from the deleted pool.
    const { data: keptNotification } = await admin
      .from("notifications")
      .select("id, pool_id, body")
      .eq("id", notification!.id)
      .single();
    expect(keptNotification?.pool_id).toBeNull();
    expect(keptNotification?.body).toBe("Referencing the soon-to-be-deleted pool.");

    createdPoolIds.splice(createdPoolIds.indexOf(poolId), 1);
    await deactivate(player.userId);
  });

  it("also deletes a zero-total-entries settlement (Grade Manually's no-winners-refund row) without an FK error", async () => {
    const { poolId } = await createComboPoolForDeletion(adminId);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    // Mirrors prepare_pool_settlement_manual's own zero-entries branch —
    // a settlement row can exist even though first_entry_at was never set.
    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", {
      p_pool_id: poolId,
    });
    expect(settlement.outcome).toBe("NO_WINNING_ENTRIES_REFUND");

    const { data: settlementBefore } = await admin
      .from("settlements")
      .select("id")
      .eq("pool_id", poolId);
    expect(settlementBefore).toHaveLength(1);

    const { error } = await admin.rpc("delete_terminal_pool", {
      p_pool_id: poolId,
      p_admin_id: adminId,
    });
    expect(error).toBeNull();

    const { data: settlementAfter } = await admin
      .from("settlements")
      .select("id")
      .eq("pool_id", poolId);
    expect(settlementAfter).toEqual([]);

    const { data: pool } = await admin.from("pools").select("id").eq("id", poolId).maybeSingle();
    expect(pool).toBeNull();

    createdPoolIds.splice(createdPoolIds.indexOf(poolId), 1);
  });

  it("refuses to delete a pool that's still mid-lifecycle (real entries, not yet settled/voided/cancelled)", async () => {
    const player = await createTestPlayer(`pool-delete-active-${Date.now()}@example.com`, 5000);
    const { poolId, options } = await createComboPoolForDeletion(adminId);
    await enter(poolId, player.userId, options[0].id);

    const { error } = await admin.rpc("delete_terminal_pool", {
      p_pool_id: poolId,
      p_admin_id: adminId,
    });
    expect(error?.message).toContain("pool_not_deletable");

    const { data: pool } = await admin.from("pools").select("id").eq("id", poolId).maybeSingle();
    expect(pool).not.toBeNull();

    await deactivate(player.userId);
  });

  it("raises pool_not_found for a nonexistent id", async () => {
    const { error } = await admin.rpc("delete_terminal_pool", {
      p_pool_id: randomUUID(),
      p_admin_id: adminId,
    });
    expect(error?.message).toContain("pool_not_found");
  });

  // Defense-in-depth: this RPC is service_role-only, so today the app-layer
  // requireSuperAdmin() check is the only thing standing between a player
  // and pool deletion. Proves the function rejects a non-super-admin caller
  // itself, independent of that app-layer gate.
  it("rejects deletion when p_admin_id isn't a super admin", async () => {
    const player = await createTestPlayer(`pool-delete-unauthorized-${Date.now()}@example.com`);
    const { poolId } = await createComboPoolForDeletion(adminId);

    const { error } = await admin.rpc("delete_terminal_pool", {
      p_pool_id: poolId,
      p_admin_id: player.userId,
    });
    expect(error?.message).toContain("not_authorized");

    const { data: pool } = await admin.from("pools").select("id").eq("id", poolId).maybeSingle();
    expect(pool).not.toBeNull();

    await deactivate(player.userId);
  });

  // The real reason this cleanup path needs to be atomic and not a plain
  // JS-side cascade: it can now touch a pool's real settlement history,
  // and the leaderboard's correct_predictions_count/current_streak must
  // stay accurate afterward — reusing the exact decrement
  // reverse_pool_settlement already performs when undoing a confirmed
  // settlement's effects (best_streak is a historical high-water mark and
  // is deliberately left alone, same precedent).
  it("deleting a SETTLED pool with a WON entry rolls back correct_predictions_count/current_streak, leaves best_streak untouched", async () => {
    const winner = await createTestPlayer(`pool-delete-winner-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`pool-delete-loser-${Date.now()}@example.com`, 5000);
    const { poolId, options } = await createComboPoolForDeletion(adminId);
    const yesId = options.find((o) => o.label === "Yes")!.id as string;
    const noId = options.find((o) => o.label === "No")!.id as string;

    await enter(poolId, winner.userId, yesId);
    await enter(poolId, loser.userId, noId);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);
    await admin.from("pool_combo_legs").update({ is_met: true }).eq("pool_id", poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    const { error: settleError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: yesId,
    });
    expect(settleError).toBeNull();

    const { data: statsBefore } = await admin
      .from("user_profiles")
      .select("correct_predictions_count, current_streak, best_streak")
      .eq("id", winner.userId)
      .single();
    expect(statsBefore?.correct_predictions_count).toBeGreaterThan(0);
    expect(statsBefore?.current_streak).toBeGreaterThan(0);

    const { data: poolBefore } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(poolBefore?.status).toBe("SETTLED");

    const { error: deleteError } = await admin.rpc("delete_terminal_pool", {
      p_pool_id: poolId,
      p_admin_id: adminId,
    });
    expect(deleteError).toBeNull();

    const { data: statsAfter } = await admin
      .from("user_profiles")
      .select("correct_predictions_count, current_streak, best_streak")
      .eq("id", winner.userId)
      .single();
    expect(statsAfter?.correct_predictions_count).toBe(statsBefore!.correct_predictions_count - 1);
    expect(statsAfter?.current_streak).toBe(statsBefore!.current_streak - 1);
    // best_streak is a historical high-water mark — untouched by deletion,
    // same as reverse_pool_settlement's own precedent.
    expect(statsAfter?.best_streak).toBe(statsBefore?.best_streak);

    const { data: log } = await admin
      .from("correct_prediction_log")
      .select("id")
      .eq("pool_id", poolId);
    expect(log).toEqual([]);

    const { data: pool } = await admin.from("pools").select("id").eq("id", poolId).maybeSingle();
    expect(pool).toBeNull();

    createdPoolIds.splice(createdPoolIds.indexOf(poolId), 1);
    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });
});
