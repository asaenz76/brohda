/**
 * Integration tests for the platform-wide admin analytics RPCs
 * (lib/analytics/adminAnalyticsService.ts +
 * 20260101000074_platform_analytics_functions.sql).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { url: SUPABASE_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

async function createTestPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: "test-password-123" });
  if (signInError) throw signInError;

  return { userId: data.user.id as string, client };
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

async function createFixture(competitionName: string) {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `admin-analytics-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      competition_name: competitionName,
      scheduled_start_utc: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      internal_status: "COMPLETED",
      regulation_home_score: 1,
      regulation_away_score: 0,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  return data.id as string;
}

async function createPool(
  adminId: string,
  fixtureId: string,
  optionAmounts: [number, number],
  analyticsCategory: string = "MATCH_RESULT",
) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: "REGULATION_RESULT",
      analytics_category: analyticsCategory,
      question: "test question",
      entry_fee: 100,
      min_total_entries: 2,
      open_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      locks_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      status: "SETTLED",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create pool");

  const { data: options, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Option A", sort_order: 0, total_entry_amount: optionAmounts[0], entry_count: 1 },
      { pool_id: pool.id, label: "Option B", sort_order: 1, total_entry_amount: optionAmounts[1], entry_count: 0 },
    ])
    .select("id, label");
  if (optionsError || !options) throw optionsError ?? new Error("failed to create options");

  const { data: settlement, error: settlementError } = await admin
    .from("settlements")
    .insert({ pool_id: pool.id, grading_version: 1, provider_status: "TEST" })
    .select("id")
    .single();
  if (settlementError || !settlement) throw settlementError ?? new Error("failed to create settlement");

  return {
    poolId: pool.id as string,
    optionAId: options.find((o) => o.label === "Option A")!.id as string,
    settlementId: settlement.id as string,
  };
}

async function createEntry(userId: string, poolId: string, optionId: string, amount: number, status: string) {
  const { data, error } = await admin
    .from("entries")
    .insert({ pool_id: poolId, user_id: userId, option_id: optionId, amount, status, idempotency_key: randomUUID() })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create entry");
  return data.id as string;
}

async function createPayout(settlementId: string, entryId: string, amount: number, userId: string, poolId: string) {
  const { error } = await admin.from("settlement_payouts").insert({ settlement_id: settlementId, entry_id: entryId, amount });
  if (error) throw error;

  const { error: walletError } = await admin.from("wallet_transactions").insert({
    account_type: "user",
    user_id: userId,
    type: "pool_payout_credit",
    direction: "credit",
    amount,
    balance_before: 0,
    balance_after: amount,
    pool_id: poolId,
    entry_id: entryId,
    settlement_id: settlementId,
    idempotency_key: randomUUID(),
  });
  if (walletError) throw walletError;
}

const deactivatedIds: string[] = [];
const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

describe.skipIf(!SERVICE_ROLE_KEY)("platform-wide admin analytics RPCs", () => {
  let adminId: string;

  beforeAll(async () => {
    adminId = await getAdminId();
  });

  afterAll(async () => {
    for (const id of deactivatedIds) await deactivate(id);
    if (createdPoolIds.length > 0) {
      const { data: settlementRows } = await admin.from("settlements").select("id").in("pool_id", createdPoolIds);
      const settlementIds = (settlementRows ?? []).map((s) => s.id);
      if (settlementIds.length > 0) {
        await admin.from("settlement_payouts").delete().in("settlement_id", settlementIds);
      }
      await admin.from("wallet_transactions").delete().in("pool_id", createdPoolIds);
      await admin.from("settlements").delete().in("pool_id", createdPoolIds);
      await admin.from("entries").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_options").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
  });

  it("aggregates across every player, not just one user's slice", async () => {
    const playerA = await createTestPlayer(`admin-analytics-a-${Date.now()}@example.com`);
    const playerB = await createTestPlayer(`admin-analytics-b-${Date.now()}@example.com`);
    deactivatedIds.push(playerA.userId, playerB.userId);

    const fixture = await createFixture("Platform Analytics League");
    createdFixtureIds.push(fixture);

    const poolA = await createPool(adminId, fixture, [1000, 1000]);
    const poolB = await createPool(adminId, fixture, [500, 500], "DISCIPLINE");
    createdPoolIds.push(poolA.poolId, poolB.poolId);

    // Player A wins pool A; player B loses pool B — proves the platform
    // functions sum across both users, unlike get_user_* which only ever
    // sees the caller's own auth.uid() row.
    const entryA = await createEntry(playerA.userId, poolA.poolId, poolA.optionAId, 1000, "WON");
    await createPayout(poolA.settlementId, entryA, 1800, playerA.userId, poolA.poolId);
    await createEntry(playerB.userId, poolB.poolId, poolB.optionAId, 500, "LOST");

    // Pin both settlements to the same controlled instant and query a tight
    // window around it, so ambient data from other tests/seed runs can't
    // leak into the unscoped platform-wide aggregate below.
    const settledAt = new Date().toISOString();
    const { error: settledAtError } = await admin
      .from("settlements")
      .update({ created_at: settledAt })
      .in("id", [poolA.settlementId, poolB.settlementId]);
    if (settledAtError) throw settledAtError;

    const wideFrom = new Date(Date.parse(settledAt) - 1000).toISOString();
    const wideTo = new Date(Date.parse(settledAt) + 1000).toISOString();

    const { data: overviewRows, error: overviewError } = await admin.rpc("get_platform_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    expect(overviewError).toBeNull();
    const overview = overviewRows![0];
    expect(overview.pools_entered).toBeGreaterThanOrEqual(2);
    expect(overview.wins).toBeGreaterThanOrEqual(1);
    expect(overview.losses).toBeGreaterThanOrEqual(1);

    const { data: financialRows } = await admin.rpc("get_platform_financial_overview", {
      p_date_from: wideFrom,
      p_date_to: wideTo,
    });
    // (1800 - 1000) from A's win + (-500) from B's loss, plus whatever
    // else exists in the DB from other tests — assert the two entries'
    // combined contribution is present via a >= floor rather than an
    // exact total, since this function deliberately has no per-user scope.
    expect(financialRows![0].net_result).toBeGreaterThanOrEqual(300);

    const { data: categoryRows } = await admin.rpc("get_platform_category_performance", {
      p_date_from: null,
      p_date_to: null,
    });
    const discipline = categoryRows!.find((r: { category: string }) => r.category === "DISCIPLINE");
    expect(discipline).toBeDefined();
    expect(discipline.losses).toBeGreaterThanOrEqual(1);

    const { data: topUsersRows } = await admin.rpc("get_platform_top_users", {
      p_date_from: wideFrom,
      p_date_to: wideTo,
      p_order: "net_result",
      p_limit: 50,
    });
    const rowA = topUsersRows!.find((r: { user_id: string }) => r.user_id === playerA.userId);
    const rowB = topUsersRows!.find((r: { user_id: string }) => r.user_id === playerB.userId);
    expect(rowA).toMatchObject({ entries: 1, entry_volume: 1000, net_result: 800, wins: 1, losses: 0 });
    expect(rowB).toMatchObject({ entries: 1, entry_volume: 500, net_result: -500, wins: 0, losses: 1 });
  });

  it("rejects a regular authenticated session — these RPCs are service_role-only, unlike get_user_*", async () => {
    const player = await createTestPlayer(`admin-analytics-unauthorized-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const { data, error } = await player.client.rpc("get_platform_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});
