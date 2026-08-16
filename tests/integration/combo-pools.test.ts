/**
 * Integration tests for COMBO pools: title field, the fixed Yes/No pair,
 * pool_combo_legs, and the two settlement edge cases specific to COMBO:
 *
 * - Zero entries on the graded-correct side: per product decision, this is
 *   now a full refund with the fee waived, same as every other pool type
 *   (via confirm_pool_refund/NO_WINNING_ENTRIES) — confirm_combo_refund_fee_retained
 *   used to retain the fee here but is no longer called by gradeComboLegsAction;
 *   it's still tested directly below since it stays defined in the DB for
 *   any historical settlement rows that used it.
 * - Did Not Play (DNP): a per-leg flag that overrides everything — if any
 *   named athlete never took the pitch, the whole pool voids and refunds in
 *   full, no fee, regardless of how the other legs graded or who's on the
 *   objectively-correct side.
 *
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

async function getBalance(userId: string): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("user_id", userId).single();
  return data!.balance as number;
}

async function getHouseBalance(): Promise<number> {
  const { data } = await admin
    .from("wallet_balances")
    .select("balance")
    .eq("account_type", "house")
    .single();
  return data!.balance as number;
}

const createdPoolIds: string[] = [];

async function createComboPool(
  creatorId: string,
  legLabels: string[],
  overrides: Partial<{ status: string; houseFeeBps: number; entryFee: number }> = {},
) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: null,
      created_by: creatorId,
      pool_type: "COMBO",
      title: "2026 World Cup Semifinal France – England",
      question: "Will Mbappé, Bellingham, Dembélé score at least 1 goal each?",
      entry_fee: overrides.entryFee ?? 1000,
      house_fee_bps: overrides.houseFeeBps ?? 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: overrides.status ?? "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create combo pool");
  createdPoolIds.push(pool.id as string);

  const { data: optionRows, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Yes", sort_order: 0 },
      { pool_id: pool.id, label: "No", sort_order: 1 },
    ])
    .select("id, label");
  if (optionsError || !optionRows) throw optionsError ?? new Error("failed to create options");

  const { data: legRows, error: legsError } = await admin
    .from("pool_combo_legs")
    .insert(legLabels.map((label, i) => ({ pool_id: pool.id, label, sort_order: i })))
    .select("id");
  if (legsError || !legRows) throw legsError ?? new Error("failed to create legs");

  const yesOptionId = optionRows.find((o) => o.label === "Yes")!.id as string;
  const noOptionId = optionRows.find((o) => o.label === "No")!.id as string;

  return {
    poolId: pool.id as string,
    yesOptionId,
    noOptionId,
    legIds: legRows.map((l) => l.id as string),
  };
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

async function gradeLegs(legIds: string[], metStates: boolean[]) {
  await Promise.all(
    legIds.map((id, i) => admin.from("pool_combo_legs").update({ is_met: metStates[i] }).eq("id", id)),
  );
}

describe.skipIf(!SERVICE_ROLE_KEY)("COMBO pools", () => {
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
        const { error } = await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
        if (error) throw error;
      }

      let result = await admin.from("correct_prediction_log").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("entries").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("pool_combo_legs").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      if (result.error) throw result.error;

      result = await admin.from("pools").delete().in("id", createdPoolIds);
      if (result.error) throw result.error;
    }
  });

  it("creates a COMBO pool with a title, fixed Yes/No options, and N legs", async () => {
    const { poolId, yesOptionId, noOptionId, legIds } = await createComboPool(adminId, [
      "Mbappé scores a goal",
      "Bellingham scores a goal",
      "Dembélé scores a goal",
    ]);

    const { data: pool } = await admin
      .from("pools")
      .select("title, question, pool_type, fixture_id")
      .eq("id", poolId)
      .single();
    expect(pool?.title).toBe("2026 World Cup Semifinal France – England");
    expect(pool?.pool_type).toBe("COMBO");
    expect(pool?.fixture_id).toBeNull();
    expect(yesOptionId).toBeTruthy();
    expect(noOptionId).toBeTruthy();
    expect(legIds).toHaveLength(3);
  });

  // Reproduces a bug reported live: grading a zero-entry COMBO pool (nobody
  // picked either side) with 2 of 3 legs met — "No" should be recorded as
  // the correct side — silently discarded the grading, leaving the
  // settlement's winning_option_id null ("Not determined") no matter what
  // was graded, since prepare_pool_settlement_manual's own zero-entries
  // branch never learns about the admin's leg selections. gradeComboLegsAction
  // (lib/actions/pool-combo.ts) now writes winning_option_id/is_winning_option
  // itself right after prepare_pool_settlement_manual returns — this test
  // mirrors that same follow-up write to protect the DB-level contract it
  // depends on (the actual server action can't be called directly here, per
  // this suite's established limitation).
  it("records the graded winning option even with zero entries, instead of leaving it 'Not determined'", async () => {
    const { poolId, noOptionId, legIds } = await createComboPool(adminId, [
      "Leg A",
      "Leg B",
      "Leg C",
    ]);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    // 2 of 3 met -> "No" should win.
    await gradeLegs(legIds, [true, true, false]);

    const { data: settlement, error } = await admin.rpc("prepare_pool_settlement_manual", {
      p_pool_id: poolId,
    });
    expect(error).toBeNull();
    expect(settlement.requires_manual_verification).toBe(false);
    expect(settlement.outcome).toBe("NO_WINNING_ENTRIES_REFUND");
    // Before the fix, this stayed null forever regardless of grading.
    expect(settlement.winning_option_id).toBeNull();

    // The follow-up write gradeComboLegsAction now performs.
    await admin
      .from("settlements")
      .update({ winning_option_id: noOptionId, winning_option_reason: "MANUAL_ADMIN_OVERRIDE" })
      .eq("id", settlement.id);
    await admin.from("pool_options").update({ is_winning_option: false }).eq("pool_id", poolId);
    await admin.from("pool_options").update({ is_winning_option: true }).eq("id", noOptionId);

    const { data: updatedSettlement } = await admin
      .from("settlements")
      .select("winning_option_id, winning_option_reason")
      .eq("id", settlement.id)
      .single();
    expect(updatedSettlement?.winning_option_id).toBe(noOptionId);
    expect(updatedSettlement?.winning_option_reason).toBe("MANUAL_ADMIN_OVERRIDE");

    const { data: options } = await admin
      .from("pool_options")
      .select("id, label, is_winning_option")
      .eq("pool_id", poolId);
    expect(options?.find((o) => o.id === noOptionId)?.is_winning_option).toBe(true);
    expect(options?.find((o) => o.label === "Yes")?.is_winning_option).toBe(false);

    // Still no money to move — confirming the refund is a no-op over zero
    // entries, same as before this fix.
    const { data: pool, error: refundError } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "NO_WINNING_ENTRIES",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });
    expect(refundError).toBeNull();
    expect(pool?.status).toBe("VOIDED");
  });

  // Reproduces the second live-reported issue: using the generic "Grade
  // manually" override on a COMBO pool (instead of its leg checkboxes)
  // stamps a settlement with no leg data at all and leaves the pool stuck
  // — the leg-checkbox card only renders for LOCKED/AWAITING_RESULT, not
  // READY_FOR_REVIEW, so there was no way back to grade it properly.
  // undo_pool_grading fixes this: reverts to LOCKED without touching the
  // legs' is_met values, so the admin's previous checkbox state is still
  // there to adjust rather than starting over from scratch.
  it("undo_pool_grading leaves leg grades untouched, so re-grading resumes from where it left off", async () => {
    const { poolId, noOptionId, legIds } = await createComboPool(adminId, ["Leg A", "Leg B", "Leg C"]);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    await gradeLegs(legIds, [true, true, false]);
    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    await admin
      .from("settlements")
      .update({ winning_option_id: noOptionId })
      .eq("id", settlement.id);
    await admin.from("pool_options").update({ is_winning_option: true }).eq("id", noOptionId);

    const { data: reverted, error } = await admin.rpc("undo_pool_grading", {
      p_pool_id: poolId,
      p_admin_id: adminId,
    });
    expect(error).toBeNull();
    expect(reverted?.status).toBe("LOCKED");

    const { data: legsAfter } = await admin
      .from("pool_combo_legs")
      .select("id, is_met")
      .eq("pool_id", poolId)
      .order("sort_order");
    expect(legsAfter?.map((l) => l.is_met)).toEqual([true, true, false]);

    // is_winning_option is cleared, though — a stale flag from the aborted
    // attempt shouldn't linger once the admin re-grades.
    const { data: optionsAfter } = await admin
      .from("pool_options")
      .select("is_winning_option")
      .eq("pool_id", poolId);
    expect(optionsAfter?.every((o) => o.is_winning_option === false)).toBe(true);
  });

  it("settles normally when Yes wins (all legs met) and someone picked Yes", async () => {
    const p1 = await createTestPlayer(`combo-yes-wins-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`combo-yes-wins-b-${Date.now()}@example.com`, 5000);
    const { poolId, yesOptionId, noOptionId, legIds } = await createComboPool(adminId, [
      "Leg A",
      "Leg B",
    ]);

    await enter(poolId, p1.userId, yesOptionId);
    await enter(poolId, p2.userId, noOptionId);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    await gradeLegs(legIds, [true, true]);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    expect(settlement.requires_manual_verification).toBe(true);

    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: yesOptionId,
    });
    expect(confirmError).toBeNull();

    // Pot: 2000 gross, 10% house fee -> 1800 net, 1 winner -> full 1800 payout.
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000);

    const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(pool?.status).toBe("SETTLED");

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("settles normally when No wins (not every leg met) and someone picked No", async () => {
    const p1 = await createTestPlayer(`combo-no-wins-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`combo-no-wins-b-${Date.now()}@example.com`, 5000);
    const { poolId, yesOptionId, noOptionId, legIds } = await createComboPool(adminId, [
      "Leg A",
      "Leg B",
    ]);

    await enter(poolId, p1.userId, yesOptionId);
    await enter(poolId, p2.userId, noOptionId);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    // Only one of two legs met -> "Yes" is NOT a winner, "No" wins.
    await gradeLegs(legIds, [true, false]);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });

    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: noOptionId,
    });
    expect(confirmError).toBeNull();

    expect(await getBalance(p1.userId)).toBe(5000 - 1000);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000 + 1800);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  // gradeComboLegsAction no longer calls this RPC (see file header) — kept
  // as a direct RPC-level test only because the function itself stays
  // defined in the DB for historical settlement rows, not because anything
  // mints new ones going forward.
  it("[retired path] confirm_combo_refund_fee_retained refunds net-of-fee when nobody picked the graded-correct side, and still credits the house its fee", async () => {
    const p1 = await createTestPlayer(`combo-zero-winners-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`combo-zero-winners-b-${Date.now()}@example.com`, 5000);
    const { poolId, noOptionId, yesOptionId, legIds } = await createComboPool(adminId, [
      "Leg A",
      "Leg B",
      "Leg C",
    ]);

    // Both players pick "No", but every leg turns out true -> "Yes" is the
    // graded-correct winner, with zero entries on it.
    await enter(poolId, p1.userId, noOptionId, 1000);
    await enter(poolId, p2.userId, noOptionId, 1000);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    await gradeLegs(legIds, [true, true, true]);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    expect(settlement.requires_manual_verification).toBe(true);

    const houseBefore = await getHouseBalance();

    const { data: voidedPool, error } = await admin.rpc("confirm_combo_refund_fee_retained", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: yesOptionId,
    });
    expect(error).toBeNull();
    expect(voidedPool.status).toBe("VOIDED");
    expect(voidedPool.void_reason).toBe("NO_WINNING_ENTRIES_FEE_RETAINED");

    // Unlike every other refund reason (full amount, no fee), this one
    // retains the 10% platform fee: $10.00 entry -> $9.00 refunded.
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 900);
    expect(await getBalance(p2.userId)).toBe(5000 - 1000 + 900);
    expect(await getHouseBalance()).toBe(houseBefore + 200); // 2 entries x $1.00 fee each

    const { data: entries } = await admin
      .from("entries")
      .select("status")
      .eq("pool_id", poolId);
    expect(entries?.every((e) => e.status === "REFUNDED")).toBe(true);

    const { data: settlementRow } = await admin
      .from("settlements")
      .select("outcome, house_fee_amount, winning_option_id, winning_entry_count")
      .eq("pool_id", poolId)
      .eq("grading_version", settlement.grading_version)
      .single();
    expect(settlementRow?.outcome).toBe("NO_WINNING_ENTRIES_FEE_RETAINED");
    expect(settlementRow?.house_fee_amount).toBe(200);
    expect(settlementRow?.winning_option_id).toBe(yesOptionId);
    expect(settlementRow?.winning_entry_count).toBe(0);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("[retired path] confirm_combo_refund_fee_retained is idempotent — a repeat call is a no-op", async () => {
    const p1 = await createTestPlayer(`combo-idempotent-${Date.now()}@example.com`, 5000);
    const { poolId, noOptionId, yesOptionId, legIds } = await createComboPool(adminId, ["Leg A"]);

    await enter(poolId, p1.userId, noOptionId, 1000);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);
    await gradeLegs(legIds, [true]);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });

    const idempotencyKey = randomUUID();
    await admin.rpc("confirm_combo_refund_fee_retained", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: idempotencyKey,
      p_winning_option_id: yesOptionId,
    });
    const balanceAfterFirst = await getBalance(p1.userId);

    const { data: secondCall, error } = await admin.rpc("confirm_combo_refund_fee_retained", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(), // different key — the guard is confirmed_at, not this
      p_winning_option_id: yesOptionId,
    });
    expect(error).toBeNull();
    expect(secondCall.status).toBe("VOIDED");
    expect(await getBalance(p1.userId)).toBe(balanceAfterFirst);

    await deactivate(p1.userId);
  });

  it("gradeComboLegsAction's current path: entries exist but none on the graded-correct side -> full refund, no fee (fee-retained reversed)", async () => {
    const p1 = await createTestPlayer(`combo-fee-waived-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`combo-fee-waived-b-${Date.now()}@example.com`, 5000);
    const { poolId, noOptionId, legIds } = await createComboPool(adminId, ["Leg A", "Leg B", "Leg C"]);

    // Both players pick "No", but every leg turns out true -> "Yes" is the
    // graded-correct winner, with zero entries on it. Mirrors
    // gradeComboLegsAction's own winningOption.entry_count === 0 branch,
    // which now calls confirm_pool_refund(NO_WINNING_ENTRIES) instead of
    // confirm_combo_refund_fee_retained.
    await enter(poolId, p1.userId, noOptionId, 1000);
    await enter(poolId, p2.userId, noOptionId, 1000);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);
    await gradeLegs(legIds, [true, true, true]);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
    expect(settlement.requires_manual_verification).toBe(true);

    const houseBefore = await getHouseBalance();

    const { data: voidedPool, error } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "NO_WINNING_ENTRIES",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });
    expect(error).toBeNull();
    expect(voidedPool.status).toBe("VOIDED");
    expect(voidedPool.void_reason).toBe("NO_WINNING_ENTRIES");

    // Full refund, no fee — unlike the retired fee-retained path above.
    expect(await getBalance(p1.userId)).toBe(5000);
    expect(await getBalance(p2.userId)).toBe(5000);
    expect(await getHouseBalance()).toBe(houseBefore);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  // Did Not Play: an absolute override, checked before any leg/winner
  // computation happens at all — even a real winning side with real
  // entries gets refunded if any leg's athlete never played.
  it("a Did Not Play leg voids the whole pool in full, no fee, even with a legitimate winning side and real entries on both options", async () => {
    const p1 = await createTestPlayer(`combo-dnp-yes-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`combo-dnp-no-${Date.now()}@example.com`, 5000);
    const { poolId, yesOptionId, noOptionId, legIds } = await createComboPool(adminId, [
      "Leg A",
      "Leg B",
    ]);

    await enter(poolId, p1.userId, yesOptionId, 1000);
    await enter(poolId, p2.userId, noOptionId, 1000);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    // Every leg is met -> "Yes" would otherwise legitimately win, with a
    // real entry on it — but leg B's athlete never took the pitch.
    await admin.from("pool_combo_legs").update({ is_met: true, did_not_play: false }).eq("id", legIds[0]);
    await admin.from("pool_combo_legs").update({ is_met: true, did_not_play: true }).eq("id", legIds[1]);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });

    const houseBefore = await getHouseBalance();

    const { data: voidedPool, error } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "COMBO_PLAYER_DID_NOT_PLAY",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });
    expect(error).toBeNull();
    expect(voidedPool.status).toBe("VOIDED");
    expect(voidedPool.void_reason).toBe("COMBO_PLAYER_DID_NOT_PLAY");

    // Both sides refunded in full, no fee — the "Yes" entry wasn't a real
    // winner despite grading true, since the pool's premise was invalidated.
    expect(await getBalance(p1.userId)).toBe(5000);
    expect(await getBalance(p2.userId)).toBe(5000);
    expect(await getHouseBalance()).toBe(houseBefore);

    const { data: entries } = await admin.from("entries").select("status").eq("pool_id", poolId);
    expect(entries?.every((e) => e.status === "REFUNDED")).toBe(true);

    // Neither option is ever marked a winner for a DNP-voided pool.
    const { data: options } = await admin.from("pool_options").select("is_winning_option").eq("pool_id", poolId);
    expect(options?.every((o) => o.is_winning_option === false)).toBe(true);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("did_not_play defaults to false and can be set independently of is_met", async () => {
    const { legIds } = await createComboPool(adminId, ["Leg A", "Leg B"]);

    const { data: legsBefore } = await admin
      .from("pool_combo_legs")
      .select("did_not_play")
      .in("id", legIds);
    expect(legsBefore?.every((l) => l.did_not_play === false)).toBe(true);

    await admin.from("pool_combo_legs").update({ is_met: false, did_not_play: true }).eq("id", legIds[0]);

    const { data: legAfter } = await admin
      .from("pool_combo_legs")
      .select("is_met, did_not_play")
      .eq("id", legIds[0])
      .single();
    expect(legAfter?.is_met).toBe(false);
    expect(legAfter?.did_not_play).toBe(true);
  });

  it("still uses the existing full-refund-no-fee path when everyone picked the graded-correct side", async () => {
    const p1 = await createTestPlayer(`combo-all-winning-${Date.now()}@example.com`, 5000);
    const { poolId, yesOptionId, legIds } = await createComboPool(adminId, ["Leg A"]);

    await enter(poolId, p1.userId, yesOptionId, 1000);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);
    await gradeLegs(legIds, [true]);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });

    const { data: voidedPool, error } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "ALL_ENTRIES_WINNING",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });
    expect(error).toBeNull();
    expect(voidedPool.status).toBe("VOIDED");

    // Existing behavior, untouched: full refund, no fee taken.
    expect(await getBalance(p1.userId)).toBe(5000);

    await deactivate(p1.userId);
  });

  it("freezes title after the first entry, same as question", async () => {
    const p1 = await createTestPlayer(`combo-freeze-${Date.now()}@example.com`, 5000);
    const { poolId, yesOptionId } = await createComboPool(adminId, ["Leg A"], { status: "OPEN" });

    await enter(poolId, p1.userId, yesOptionId);

    const { error } = await admin.from("pools").update({ title: "Changed title" }).eq("id", poolId);
    expect(error).not.toBeNull();
    expect(error?.message).toContain("frozen after the first entry");

    await deactivate(p1.userId);
  });
});
