/**
 * Integration tests for settlement (spec §16's atomic settlement, §16.8's
 * minimum/no-winner/all-winner outcomes, X.7's anomaly void machinery, and
 * §16.6's optimistic-concurrency review). Run with:
 * pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
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

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password: "test-password-123",
  });
  if (signInError) throw signInError;

  return { userId: data.user.id as string, client };
}

async function deactivate(userId: string) {
  await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
}

const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

async function createTestFixture(
  overrides: Partial<{
    homeExternalId: string;
    awayExternalId: string;
    internalStatus: string;
    regulationHomeScore: number | null;
    regulationAwayScore: number | null;
    extraTimeHomeScore: number | null;
    extraTimeAwayScore: number | null;
    penaltyHomeScore: number | null;
    penaltyAwayScore: number | null;
    homeScore: number | null;
    awayScore: number | null;
    scheduledStartUtc: string;
    venueTimezone: string;
  }> = {},
): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `settle-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      home_team_external_id: overrides.homeExternalId ?? "home-1",
      away_team_external_id: overrides.awayExternalId ?? "away-1",
      scheduled_start_utc:
        overrides.scheduledStartUtc ?? new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      internal_status: overrides.internalStatus ?? "COMPLETED",
      regulation_home_score: overrides.regulationHomeScore ?? null,
      regulation_away_score: overrides.regulationAwayScore ?? null,
      extra_time_home_score: overrides.extraTimeHomeScore ?? null,
      extra_time_away_score: overrides.extraTimeAwayScore ?? null,
      penalty_home_score: overrides.penaltyHomeScore ?? null,
      penalty_away_score: overrides.penaltyAwayScore ?? null,
      home_score: overrides.homeScore ?? null,
      away_score: overrides.awayScore ?? null,
      venue_timezone: overrides.venueTimezone ?? "America/Costa_Rica",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  createdFixtureIds.push(data.id as string);
  return data.id as string;
}

async function createTestPool(
  fixtureId: string,
  adminId: string,
  poolType: "WHO_WILL_ADVANCE" | "REGULATION_RESULT",
  overrides: Partial<{
    entryFee: number;
    minTotalEntries: number;
    homeExternalId: string;
    awayExternalId: string;
  }> = {},
) {
  const homeExt = overrides.homeExternalId ?? "home-1";
  const awayExt = overrides.awayExternalId ?? "away-1";

  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: poolType,
      question:
        poolType === "WHO_WILL_ADVANCE" ? "Who will advance?" : "What will the result be after regulation?",
      entry_fee: overrides.entryFee ?? 1000,
      house_fee_bps: 1000,
      min_total_entries: overrides.minTotalEntries ?? 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create test pool");
  createdPoolIds.push(pool.id as string);

  const optionRows =
    poolType === "WHO_WILL_ADVANCE"
      ? [
          { pool_id: pool.id, label: "Home Test FC", external_team_id: homeExt, sort_order: 0 },
          { pool_id: pool.id, label: "Away Test FC", external_team_id: awayExt, sort_order: 1 },
        ]
      : [
          { pool_id: pool.id, label: "Home Test FC", external_team_id: homeExt, sort_order: 0 },
          { pool_id: pool.id, label: "Draw", external_team_id: null, sort_order: 1 },
          { pool_id: pool.id, label: "Away Test FC", external_team_id: awayExt, sort_order: 2 },
        ];

  const { data: options, error: optionsError } = await admin
    .from("pool_options")
    .insert(optionRows)
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

async function moveToAwaitingResult(poolId: string) {
  await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);
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

describe.skipIf(!SERVICE_ROLE_KEY)("settlement", () => {
  let adminId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("settlement_payouts").delete().in(
        "settlement_id",
        (await admin.from("settlements").select("id").in("pool_id", createdPoolIds)).data?.map((s) => s.id) ?? [],
      );
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

  it("settles a REGULATION_RESULT pool: home wins, remainder credited to the house", async () => {
    const fixtureId = await createTestFixture({ regulationHomeScore: 2, regulationAwayScore: 0 });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "REGULATION_RESULT");
    const [home, , away] = options;

    const winnerA = await createTestPlayer(`settle-reg-a-${Date.now()}@example.com`, 5000);
    const winnerB = await createTestPlayer(`settle-reg-b-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`settle-reg-c-${Date.now()}@example.com`, 5000);

    await enter(poolId, winnerA.userId, home.id);
    await enter(poolId, winnerB.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    await moveToAwaitingResult(poolId);

    const { data: settlement, error: prepareError } = await admin.rpc("prepare_pool_settlement", {
      p_pool_id: poolId,
    });
    expect(prepareError).toBeNull();
    expect(settlement.outcome).toBe("NORMAL");
    expect(settlement.winning_option_id).toBe(home.id);
    expect(settlement.winning_option_reason).toBe("REGULATION_HOME_WIN");
    expect(settlement.gross_pool).toBe(3000);
    expect(settlement.house_fee_amount).toBe(300);
    expect(settlement.net_prize_pool).toBe(2700);
    expect(settlement.payout_per_entry).toBe(1350);
    expect(settlement.rounding_remainder).toBe(0);

    const { data: pool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(pool!.status).toBe("READY_FOR_REVIEW");

    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
    });
    expect(confirmError).toBeNull();

    expect(await getBalance(winnerA.userId)).toBe(5000 - 1000 + 1350);
    expect(await getBalance(winnerB.userId)).toBe(5000 - 1000 + 1350);
    expect(await getBalance(loser.userId)).toBe(5000 - 1000);

    const { data: settledPool } = await admin.from("pools").select("status").eq("id", poolId).single();
    expect(settledPool!.status).toBe("SETTLED");

    const { data: winningOption } = await admin
      .from("pool_options")
      .select("is_winning_option")
      .eq("id", home.id)
      .single();
    expect(winningOption!.is_winning_option).toBe(true);

    const { data: houseTx } = await admin
      .from("wallet_transactions")
      .select("type, amount")
      .eq("settlement_id", settlement.id)
      .eq("account_type", "house");
    expect(houseTx?.find((t) => t.type === "house_fee_credit")?.amount).toBe(300);

    await deactivate(winnerA.userId);
    await deactivate(winnerB.userId);
    await deactivate(loser.userId);
  });

  it("settles a WHO_WILL_ADVANCE pool decided on penalties, crediting the sole winner", async () => {
    const fixtureId = await createTestFixture({
      homeScore: 1,
      awayScore: 1,
      penaltyHomeScore: 4,
      penaltyAwayScore: 3,
    });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "WHO_WILL_ADVANCE");
    const [home, away] = options;

    const winner = await createTestPlayer(`settle-pens-a-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`settle-pens-b-${Date.now()}@example.com`, 5000);

    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);
    await moveToAwaitingResult(poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
    expect(settlement.winning_option_id).toBe(home.id);
    expect(settlement.winning_option_reason).toBe("ADVANCED_ON_PENALTIES");
    expect(settlement.payout_per_entry).toBe(1800); // gross 2000, 10% fee, 1 winner

    await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
    });

    expect(await getBalance(winner.userId)).toBe(5000 - 1000 + 1800);

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });

  it("requires manual verification when the regulation score is ambiguous, then accepts the admin's choice", async () => {
    const fixtureId = await createTestFixture({ regulationHomeScore: null, regulationAwayScore: null });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "REGULATION_RESULT");
    const [home, , away] = options;

    const p1 = await createTestPlayer(`settle-manual-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`settle-manual-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, p1.userId, home.id);
    await enter(poolId, p2.userId, away.id);
    await moveToAwaitingResult(poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
    expect(settlement.requires_manual_verification).toBe(true);
    expect(settlement.winning_option_id).toBeNull();

    const { error: missingOptionError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
    });
    expect(missingOptionError).not.toBeNull();
    expect(missingOptionError!.message).toContain("winning_option_required");

    const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
      p_winning_option_id: home.id,
    });
    expect(confirmError).toBeNull();
    expect(await getBalance(p1.userId)).toBe(5000 - 1000 + 1800);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("is idempotent: confirming an already-settled pool again never double-pays", async () => {
    const fixtureId = await createTestFixture({ regulationHomeScore: 1, regulationAwayScore: 0 });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "REGULATION_RESULT");
    const [home, , away] = options;

    const winner = await createTestPlayer(`settle-idem-a-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`settle-idem-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);
    await moveToAwaitingResult(poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });

    await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: "fixed-key-1",
    });
    const balanceAfterFirst = await getBalance(winner.userId);

    const { error } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: "fixed-key-1",
    });
    expect(error).toBeNull();
    expect(await getBalance(winner.userId)).toBe(balanceAfterFirst);

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });

  it("rejects confirmation against a stale snapshot version", async () => {
    const fixtureId = await createTestFixture({ regulationHomeScore: 1, regulationAwayScore: 0 });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "REGULATION_RESULT");
    const [home, , away] = options;

    const winner = await createTestPlayer(`settle-stale-a-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`settle-stale-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);
    await moveToAwaitingResult(poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
    const staleVersion = settlement.grading_version;

    // Simulate the snapshot having moved on since the admin loaded the page.
    await admin.from("pools").update({ snapshot_version: staleVersion + 1 }).eq("id", poolId);

    const { error } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: staleVersion,
      p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("stale_snapshot");

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });

  it("proposes a refund when no valid entry picked the winning option, and executes it on confirm", async () => {
    const fixtureId = await createTestFixture({ regulationHomeScore: 1, regulationAwayScore: 0 });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "REGULATION_RESULT");
    const [, draw, away] = options;

    const p1 = await createTestPlayer(`settle-nowinner-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`settle-nowinner-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, p1.userId, draw.id); // nobody picks "home", which wins
    await enter(poolId, p2.userId, away.id);
    await moveToAwaitingResult(poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
    expect(settlement.outcome).toBe("NO_WINNING_ENTRIES_REFUND");

    const { error: wrongPathError } = await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
    });
    expect(wrongPathError).not.toBeNull();
    expect(wrongPathError!.message).toContain("use_confirm_pool_refund");

    const { data: refundedPool, error: refundError } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "NO_WINNING_ENTRIES",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });
    expect(refundError).toBeNull();
    expect(refundedPool.status).toBe("VOIDED");
    expect(refundedPool.void_reason).toBe("NO_WINNING_ENTRIES");
    expect(await getBalance(p1.userId)).toBe(5000);
    expect(await getBalance(p2.userId)).toBe(5000);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("proposes a refund when every valid entry picked the winning option", async () => {
    const fixtureId = await createTestFixture({ regulationHomeScore: 1, regulationAwayScore: 0 });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "REGULATION_RESULT");
    const [home] = options;

    const p1 = await createTestPlayer(`settle-allwinner-a-${Date.now()}@example.com`, 5000);
    const p2 = await createTestPlayer(`settle-allwinner-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, p1.userId, home.id);
    await enter(poolId, p2.userId, home.id);
    await moveToAwaitingResult(poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
    expect(settlement.outcome).toBe("ALL_ENTRIES_WINNING_REFUND");

    const { data: refundedPool, error } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "ALL_ENTRIES_WINNING",
      p_idempotency_key: randomUUID(),
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
    });
    expect(error).toBeNull();
    expect(refundedPool.status).toBe("VOIDED");
    expect(await getBalance(p1.userId)).toBe(5000);
    expect(await getBalance(p2.userId)).toBe(5000);

    await deactivate(p1.userId);
    await deactivate(p2.userId);
  });

  it("cancels (not voids) a pool below its minimum entry count, with a full refund", async () => {
    const fixtureId = await createTestFixture();
    const { poolId, options } = await createTestPool(fixtureId, adminId, "WHO_WILL_ADVANCE", {
      minTotalEntries: 3,
    });
    const [home] = options;

    const player = await createTestPlayer(`settle-min-${Date.now()}@example.com`, 5000);
    await enter(poolId, player.userId, home.id);
    await admin.from("pools").update({ status: "LOCKED" }).eq("id", poolId);

    const { data: pool, error } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "MINIMUM_ENTRIES_NOT_REACHED",
      p_idempotency_key: `${poolId}:void:MINIMUM_ENTRIES_NOT_REACHED`,
    });
    expect(error).toBeNull();
    expect(pool.status).toBe("CANCELLED");
    expect(await getBalance(player.userId)).toBe(5000);

    const { data: entry } = await admin.from("entries").select("status").eq("pool_id", poolId).single();
    expect(entry!.status).toBe("REFUNDED");

    await deactivate(player.userId);
  });

  it("voids a pool for an X.7 anomaly reason and is idempotent on repeated calls (no double refund)", async () => {
    const fixtureId = await createTestFixture({ internalStatus: "POSTPONED" });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "WHO_WILL_ADVANCE");
    const [home] = options;

    const player = await createTestPlayer(`settle-anomaly-${Date.now()}@example.com`, 5000);
    await enter(poolId, player.userId, home.id);
    await moveToAwaitingResult(poolId);

    const idempotencyKey = `${poolId}:void:MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY`;
    const first = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
      p_idempotency_key: idempotencyKey,
    });
    expect(first.error).toBeNull();
    expect(first.data.status).toBe("VOIDED");
    expect(await getBalance(player.userId)).toBe(5000);

    // A repeated cron pass over the same (already-terminal) pool must not
    // refund a second time.
    const second = await admin.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY",
      p_idempotency_key: idempotencyKey,
    });
    expect(second.error).toBeNull();
    expect(await getBalance(player.userId)).toBe(5000);

    await deactivate(player.userId);
  });

  it("RLS: a player cannot read another player's settlement payout or notifications", async () => {
    const fixtureId = await createTestFixture({ regulationHomeScore: 1, regulationAwayScore: 0 });
    const { poolId, options } = await createTestPool(fixtureId, adminId, "REGULATION_RESULT");
    const [home, , away] = options;

    const winner = await createTestPlayer(`settle-rls-a-${Date.now()}@example.com`, 5000);
    const loser = await createTestPlayer(`settle-rls-b-${Date.now()}@example.com`, 5000);
    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);
    await moveToAwaitingResult(poolId);

    const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
    await admin.rpc("confirm_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_grading_version: settlement.grading_version,
      p_idempotency_key: randomUUID(),
    });

    await admin.from("notifications").insert({
      user_id: winner.userId,
      type: "SETTLED_WON",
      title: "You won!",
      body: "test",
      pool_id: poolId,
    });

    const { data: winnerEntry } = await admin
      .from("entries")
      .select("id")
      .eq("pool_id", poolId)
      .eq("user_id", winner.userId)
      .single();
    const { data: payoutRow } = await admin
      .from("settlement_payouts")
      .select("id")
      .eq("entry_id", winnerEntry!.id)
      .single();

    const { data: loserSeesPayout } = await loser.client
      .from("settlement_payouts")
      .select("*")
      .eq("id", payoutRow!.id);
    expect(loserSeesPayout).toEqual([]);

    const { data: winnerSeesPayout } = await winner.client
      .from("settlement_payouts")
      .select("*")
      .eq("id", payoutRow!.id);
    expect(winnerSeesPayout).toHaveLength(1);

    const { data: loserSeesNotifications } = await loser.client
      .from("notifications")
      .select("*")
      .eq("pool_id", poolId);
    expect(loserSeesNotifications).toEqual([]);

    const { data: winnerSeesNotifications } = await winner.client
      .from("notifications")
      .select("*")
      .eq("pool_id", poolId);
    expect(winnerSeesNotifications).toHaveLength(1);

    await deactivate(winner.userId);
    await deactivate(loser.userId);
  });
});
