/**
 * Integration tests for the leaderboard (Phase 7 of the Instagram-style
 * redesign): confirm_pool_settlement's correct_predictions_count/streak/
 * correct_prediction_log maintenance, reverse_pool_settlement's rollback
 * of the same, and get_leaderboard's scope/range filtering. Run with:
 * pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createTestPlayer(
  email: string,
  balanceCents = 5000,
  role: "player" | "admin" | "super_admin" = "player",
) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    role,
    is_active: true,
  });

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

  return { userId: data.user.id as string };
}

async function deactivate(userId: string) {
  await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
}

const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

async function createTestFixture(homeScore: number, awayScore: number): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `leaderboard-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      home_team_external_id: "home-1",
      away_team_external_id: "away-1",
      scheduled_start_utc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      internal_status: "COMPLETED",
      regulation_home_score: homeScore,
      regulation_away_score: awayScore,
      venue_timezone: "America/Costa_Rica",
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

function enter(poolId: string, userId: string, optionId: string) {
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: 1000,
    p_idempotency_key: randomUUID(),
  });
}

async function settlePool(poolId: string, adminId: string) {
  await admin.from("pools").update({ status: "AWAITING_RESULT" }).eq("id", poolId);
  const { data: settlement } = await admin.rpc("prepare_pool_settlement", { p_pool_id: poolId });
  const { error } = await admin.rpc("confirm_pool_settlement", {
    p_pool_id: poolId,
    p_admin_id: adminId,
    p_grading_version: settlement.grading_version,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return settlement;
}

// Enters a filler-backed pool (min_total_entries needs 2) for `userId`,
// settling it as a win or a loss. Returns the filler's userId so the
// caller can queue it for cleanup.
async function playAndSettle(userId: string, willWin: boolean, adminId: string): Promise<string> {
  const fixtureId = willWin ? await createTestFixture(1, 0) : await createTestFixture(0, 1);
  const { poolId, options } = await createTestPool(fixtureId, adminId);
  await enter(poolId, userId, options[0].id); // always picks "home"
  const filler = await createTestPlayer(`lb-playandsettle-filler-${randomUUID()}@example.com`);
  await enter(poolId, filler.userId, options[2].id);
  await settlePool(poolId, adminId);
  return filler.userId;
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

async function getProfile(userId: string) {
  const { data } = await admin
    .from("user_profiles")
    .select("correct_predictions_count, current_streak, best_streak")
    .eq("id", userId)
    .single();
  return data!;
}

describe.skipIf(!SERVICE_ROLE_KEY)("leaderboard", () => {
  let adminId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      const { data: settlements } = await admin
        .from("settlements")
        .select("id")
        .in("pool_id", createdPoolIds);
      const settlementIds = settlements?.map((s) => s.id) ?? [];
      if (settlementIds.length > 0) {
        await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
        await admin.from("correct_prediction_log").delete().in("settlement_id", settlementIds);
      }
      await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
    await Promise.all(createdUserIds.map(deactivate));
  });

  it("a settlement increments correct_predictions_count/current_streak/best_streak for winners and resets the loser's streak, logging one row per win", async () => {
    const fixtureId = await createTestFixture(2, 0);
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    const winner = await createTestPlayer(`lb-basic-winner-${Date.now()}@example.com`);
    const loser = await createTestPlayer(`lb-basic-loser-${Date.now()}@example.com`);
    createdUserIds.push(winner.userId, loser.userId);

    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    await settlePool(poolId, adminId);

    const winnerProfile = await getProfile(winner.userId);
    expect(winnerProfile.correct_predictions_count).toBe(1);
    expect(winnerProfile.current_streak).toBe(1);
    expect(winnerProfile.best_streak).toBe(1);

    const loserProfile = await getProfile(loser.userId);
    expect(loserProfile.correct_predictions_count).toBe(0);
    expect(loserProfile.current_streak).toBe(0);

    const { data: logRows } = await admin
      .from("correct_prediction_log")
      .select("id")
      .eq("pool_id", poolId)
      .eq("user_id", winner.userId);
    expect(logRows?.length).toBe(1);
  });

  it("a streak survives across wins and resets to 0 (best_streak retained) on a loss", async () => {
    const player = await createTestPlayer(`lb-streak-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);

    // Win twice in a row.
    for (let i = 0; i < 2; i++) {
      const fixtureId = await createTestFixture(1, 0);
      const { poolId, options } = await createTestPool(fixtureId, adminId);
      await enter(poolId, player.userId, options[0].id);
      // Needs a second entrant so min_total_entries is satisfied.
      const filler = await createTestPlayer(`lb-streak-filler-${i}-${Date.now()}@example.com`);
      createdUserIds.push(filler.userId);
      await enter(poolId, filler.userId, options[2].id);
      await settlePool(poolId, adminId);
    }

    let profile = await getProfile(player.userId);
    expect(profile.current_streak).toBe(2);
    expect(profile.best_streak).toBe(2);

    // Now lose.
    const fixtureId = await createTestFixture(0, 1);
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    await enter(poolId, player.userId, options[0].id); // picks home, away wins
    const filler = await createTestPlayer(`lb-streak-filler-loss-${Date.now()}@example.com`);
    createdUserIds.push(filler.userId);
    await enter(poolId, filler.userId, options[2].id);
    await settlePool(poolId, adminId);

    profile = await getProfile(player.userId);
    expect(profile.current_streak).toBe(0);
    expect(profile.best_streak).toBe(2);
    expect(profile.correct_predictions_count).toBe(2);
  });

  it("reversing a settlement undoes the count/streak/log for its winners", async () => {
    const fixtureId = await createTestFixture(3, 1);
    const { poolId, options } = await createTestPool(fixtureId, adminId);
    const [home, , away] = options;

    const winner = await createTestPlayer(`lb-reverse-winner-${Date.now()}@example.com`);
    const loser = await createTestPlayer(`lb-reverse-loser-${Date.now()}@example.com`);
    createdUserIds.push(winner.userId, loser.userId);

    await enter(poolId, winner.userId, home.id);
    await enter(poolId, loser.userId, away.id);

    await settlePool(poolId, adminId);
    expect((await getProfile(winner.userId)).correct_predictions_count).toBe(1);

    const { error: reversalError } = await admin.rpc("reverse_pool_settlement", {
      p_pool_id: poolId,
      p_admin_id: adminId,
      p_reason: "test reversal",
      p_idempotency_key: randomUUID(),
    });
    expect(reversalError).toBeNull();

    const profile = await getProfile(winner.userId);
    expect(profile.correct_predictions_count).toBe(0);
    expect(profile.current_streak).toBe(0);

    const { data: logRows } = await admin
      .from("correct_prediction_log")
      .select("id")
      .eq("pool_id", poolId)
      .eq("user_id", winner.userId);
    expect(logRows?.length).toBe(0);
  });

  it("get_leaderboard 'global'/'all_time' ranks by correct_predictions_count desc", async () => {
    const fixtureId = await createTestFixture(1, 0);
    const { poolId, options } = await createTestPool(fixtureId, adminId);

    const topPlayer = await createTestPlayer(`lb-rank-top-${Date.now()}@example.com`);
    const bottomPlayer = await createTestPlayer(`lb-rank-bottom-${Date.now()}@example.com`);
    createdUserIds.push(topPlayer.userId, bottomPlayer.userId);

    await enter(poolId, topPlayer.userId, options[0].id);
    await enter(poolId, bottomPlayer.userId, options[2].id);
    await settlePool(poolId, adminId);

    const { data: rows, error } = await admin.rpc("get_leaderboard", {
      p_scope: "global",
      p_range: "all_time",
      p_caller_id: topPlayer.userId,
    });
    expect(error).toBeNull();

    const topRow = rows!.find((r: { user_id: string }) => r.user_id === topPlayer.userId);
    const bottomRow = rows!.find((r: { user_id: string }) => r.user_id === bottomPlayer.userId);
    expect(topRow.correct_count).toBe(1);
    expect(bottomRow.correct_count).toBe(0);
    expect(topRow.rank).toBeLessThan(bottomRow.rank);
  });

  it("get_leaderboard ranks by win rate, not raw correct count — 2/2 (100%) beats 2/4 (50%)", async () => {
    const highRate = await createTestPlayer(`lb-winrate-high-${Date.now()}@example.com`);
    const lowRate = await createTestPlayer(`lb-winrate-low-${Date.now()}@example.com`);
    createdUserIds.push(highRate.userId, lowRate.userId);

    // highRate: 2 wins, 0 losses -> 2/2 = 100%.
    createdUserIds.push(await playAndSettle(highRate.userId, true, adminId));
    createdUserIds.push(await playAndSettle(highRate.userId, true, adminId));

    // lowRate: 2 wins, 2 losses -> 2/4 = 50%. Same raw correct count as
    // highRate, worse rate.
    createdUserIds.push(await playAndSettle(lowRate.userId, true, adminId));
    createdUserIds.push(await playAndSettle(lowRate.userId, true, adminId));
    createdUserIds.push(await playAndSettle(lowRate.userId, false, adminId));
    createdUserIds.push(await playAndSettle(lowRate.userId, false, adminId));

    const { data: rows } = await admin.rpc("get_leaderboard", {
      p_scope: "global",
      p_range: "all_time",
      p_caller_id: highRate.userId,
    });

    const highRow = rows!.find((r: { user_id: string }) => r.user_id === highRate.userId);
    const lowRow = rows!.find((r: { user_id: string }) => r.user_id === lowRate.userId);

    expect(highRow.correct_count).toBe(2);
    expect(highRow.total_count).toBe(2);
    expect(lowRow.correct_count).toBe(2);
    expect(lowRow.total_count).toBe(4);
    expect(highRow.rank).toBeLessThan(lowRow.rank);
  });

  it("get_leaderboard breaks an equal-rate tie by total_count — 3/3 outranks 1/1", async () => {
    const morePlayed = await createTestPlayer(`lb-tiebreak-more-${Date.now()}@example.com`);
    const lessPlayed = await createTestPlayer(`lb-tiebreak-less-${Date.now()}@example.com`);
    createdUserIds.push(morePlayed.userId, lessPlayed.userId);

    // Both 100%, but morePlayed has a bigger sample — should rank strictly
    // ahead of lessPlayed despite the identical rate.
    createdUserIds.push(await playAndSettle(morePlayed.userId, true, adminId));
    createdUserIds.push(await playAndSettle(morePlayed.userId, true, adminId));
    createdUserIds.push(await playAndSettle(morePlayed.userId, true, adminId));
    createdUserIds.push(await playAndSettle(lessPlayed.userId, true, adminId));

    const { data: rows } = await admin.rpc("get_leaderboard", {
      p_scope: "global",
      p_range: "all_time",
      p_caller_id: morePlayed.userId,
    });

    const moreRow = rows!.find((r: { user_id: string }) => r.user_id === morePlayed.userId);
    const lessRow = rows!.find((r: { user_id: string }) => r.user_id === lessPlayed.userId);

    expect(moreRow.correct_count).toBe(3);
    expect(moreRow.total_count).toBe(3);
    expect(lessRow.correct_count).toBe(1);
    expect(lessRow.total_count).toBe(1);
    expect(moreRow.rank).toBeLessThan(lessRow.rank);
  });

  it("get_leaderboard gives a genuinely identical record (same rate, same correct, same total) the same rank number", async () => {
    const playerA = await createTestPlayer(`lb-truetie-a-${Date.now()}@example.com`);
    const playerB = await createTestPlayer(`lb-truetie-b-${Date.now()}@example.com`);
    createdUserIds.push(playerA.userId, playerB.userId);

    createdUserIds.push(await playAndSettle(playerA.userId, true, adminId));
    createdUserIds.push(await playAndSettle(playerB.userId, true, adminId));

    const { data: rows } = await admin.rpc("get_leaderboard", {
      p_scope: "global",
      p_range: "all_time",
      p_caller_id: playerA.userId,
    });

    const rowA = rows!.find((r: { user_id: string }) => r.user_id === playerA.userId);
    const rowB = rows!.find((r: { user_id: string }) => r.user_id === playerB.userId);

    expect(rowA.correct_count).toBe(rowB.correct_count);
    expect(rowA.total_count).toBe(rowB.total_count);
    expect(rowA.rank).toBe(rowB.rank);
  });

  it("get_leaderboard 'following' scope only includes the caller and who they follow", async () => {
    const fixtureId = await createTestFixture(1, 0);
    const { poolId, options } = await createTestPool(fixtureId, adminId);

    const caller = await createTestPlayer(`lb-follow-caller-${Date.now()}@example.com`);
    const followed = await createTestPlayer(`lb-follow-followed-${Date.now()}@example.com`);
    const stranger = await createTestPlayer(`lb-follow-stranger-${Date.now()}@example.com`);
    createdUserIds.push(caller.userId, followed.userId, stranger.userId);

    await admin.from("follows").insert({ follower_id: caller.userId, followee_id: followed.userId });

    await enter(poolId, followed.userId, options[0].id);
    await enter(poolId, stranger.userId, options[2].id);
    await settlePool(poolId, adminId);

    const { data: rows } = await admin.rpc("get_leaderboard", {
      p_scope: "following",
      p_range: "all_time",
      p_caller_id: caller.userId,
    });

    const userIds = rows!.map((r: { user_id: string }) => r.user_id);
    expect(userIds).toContain(caller.userId);
    expect(userIds).toContain(followed.userId);
    expect(userIds).not.toContain(stranger.userId);
  });

  it("get_leaderboard excludes admin/super_admin accounts even with correct picks, including from their own view", async () => {
    const adminPlayer = await createTestPlayer(`lb-admin-${Date.now()}@example.com`, 5000, "admin");
    const superAdminPlayer = await createTestPlayer(
      `lb-superadmin-${Date.now()}@example.com`,
      5000,
      "super_admin",
    );
    const regularPlayer = await createTestPlayer(`lb-regular-${Date.now()}@example.com`);
    createdUserIds.push(adminPlayer.userId, superAdminPlayer.userId, regularPlayer.userId);

    // Admins can't earn correct picks through the normal entry/settlement
    // flow anymore (create_pool_entry rejects admin/super_admin) — set the
    // counter directly to prove the leaderboard filter is role-based, not
    // just "nobody with admin accounts happens to have picks".
    await admin
      .from("user_profiles")
      .update({ correct_predictions_count: 5 })
      .in("id", [adminPlayer.userId, superAdminPlayer.userId]);

    const { data: globalRows } = await admin.rpc("get_leaderboard", {
      p_scope: "global",
      p_range: "all_time",
      p_caller_id: regularPlayer.userId,
    });
    const globalUserIds = globalRows!.map((r: { user_id: string }) => r.user_id);
    expect(globalUserIds).not.toContain(adminPlayer.userId);
    expect(globalUserIds).not.toContain(superAdminPlayer.userId);

    const { data: ownRows } = await admin.rpc("get_leaderboard", {
      p_scope: "global",
      p_range: "all_time",
      p_caller_id: adminPlayer.userId,
    });
    const ownUserIds = ownRows!.map((r: { user_id: string }) => r.user_id);
    expect(ownUserIds).not.toContain(adminPlayer.userId);
  });
});
