/**
 * Integration tests for the Phase 2 user analytics RPCs
 * (lib/analytics/userAnalyticsService.ts + the 5 SQL functions from
 * 20260101000064_user_analytics_functions.sql /
 * 20260101000065_user_entry_history_chronological.sql).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
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

async function createTestPlayer(email: string) {
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

async function createFixture(competitionName: string, competitionExternalId: string | null = null) {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `user-analytics-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      competition_name: competitionName,
      competition_external_id: competitionExternalId,
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
  poolType: string,
  templateId: string | null,
  optionAmounts: [number, number],
  analyticsCategory: string = "UNKNOWN",
) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: poolType,
      template_id: templateId,
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
    .insert({
      pool_id: poolId,
      user_id: userId,
      option_id: optionId,
      amount,
      status,
      idempotency_key: randomUUID(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create entry");
  return data.id as string;
}

// Mirrors settle_pool's real behavior: a pool_payout_credit wallet
// transaction and a settlement_payouts row are written atomically, same
// amount — analytics now sources payout amounts from wallet_transactions
// (see 20260101000071), so tests must create both to reflect production.
async function createPayout(
  settlementId: string,
  entryId: string,
  amount: number,
  userId: string,
  poolId: string,
  createdAt?: string,
) {
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
    ...(createdAt ? { created_at: createdAt } : {}),
  });
  if (walletError) throw walletError;
}

const deactivatedIds: string[] = [];
const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

describe.skipIf(!SERVICE_ROLE_KEY)("user analytics RPCs", () => {
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

  it("computes overview/category/competition/entry-history numbers correctly for a real mix of outcomes", async () => {
    const player = await createTestPlayer(`user-analytics-a-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const fixtureA = await createFixture("La Liga");
    const fixtureB = await createFixture("Premier League");
    createdFixtureIds.push(fixtureA, fixtureB);

    // Pool A: legacy REGULATION_RESULT ("Match result" category) — WON.
    const poolA = await createPool(adminId, fixtureA, "REGULATION_RESULT", null, [1000, 2000], "MATCH_RESULT");
    // Pool B: TEMPLATE_GRADED / RED_CARD ("Cards" category) — LOST.
    const poolB = await createPool(adminId, fixtureB, "TEMPLATE_GRADED", "RED_CARD", [500, 1500], "DISCIPLINE");
    // Pool C: a voided entry — should count toward pools_entered/voids but
    // never toward entry_volume/net_result/category or competition rows.
    const poolC = await createPool(adminId, fixtureA, "REGULATION_RESULT", null, [300, 0], "MATCH_RESULT");
    createdPoolIds.push(poolA.poolId, poolB.poolId, poolC.poolId);

    const wonEntryId = await createEntry(player.userId, poolA.poolId, poolA.optionAId, 1000, "WON");
    await createPayout(poolA.settlementId, wonEntryId, 1800, player.userId, poolA.poolId);
    await createEntry(player.userId, poolB.poolId, poolB.optionAId, 500, "LOST");
    const voidEntryId = await createEntry(player.userId, poolC.poolId, poolC.optionAId, 300, "VOID");
    // A real void always produces a matching full-refund wallet transaction
    // via confirm_pool_refund — without it, net_result correctly reflects
    // that the stake was never actually returned (see the fee-retained
    // partial-refund test below for the other real case).
    const { error: refundError } = await admin.from("wallet_transactions").insert({
      account_type: "user",
      user_id: player.userId,
      type: "pool_refund_credit",
      direction: "credit",
      amount: 300,
      balance_before: 0,
      balance_after: 300,
      pool_id: poolC.poolId,
      entry_id: voidEntryId,
      idempotency_key: randomUUID(),
    });
    if (refundError) throw refundError;

    const { data: overviewRows, error: overviewError } = await player.client.rpc("get_user_analytics_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    expect(overviewError).toBeNull();
    const overview = overviewRows![0];
    expect(overview.pools_entered).toBe(3);
    expect(overview.graded_entries).toBe(2);
    expect(overview.wins).toBe(1);
    expect(overview.losses).toBe(1);
    expect(overview.voids).toBe(1);
    expect(overview.entry_volume).toBe(1500); // 1000 (WON) + 500 (LOST); VOID excluded

    const wideFrom = "2000-01-01T00:00:00.000Z";
    const wideTo = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data: financialRows } = await player.client.rpc("get_user_financial_overview", {
      p_date_from: wideFrom,
      p_date_to: wideTo,
    });
    expect(financialRows![0].net_result).toBe(300); // (1800 - 1000) + (-500), realization-dated

    const { data: categoryRows } = await player.client.rpc("get_user_category_performance", {
      p_date_from: null,
      p_date_to: null,
    });
    const matchResult = categoryRows!.find((r: { category: string }) => r.category === "MATCH_RESULT");
    const cards = categoryRows!.find((r: { category: string }) => r.category === "DISCIPLINE");
    expect(matchResult).toMatchObject({ entries: 1, entry_volume: 1000, net_result: 800, wins: 1, losses: 0 });
    expect(cards).toMatchObject({ entries: 1, entry_volume: 500, net_result: -500, wins: 0, losses: 1 });

    const { data: competitionRows } = await player.client.rpc("get_user_competition_performance", {
      p_date_from: null,
      p_date_to: null,
    });
    const laLiga = competitionRows!.find((r: { competition_name: string }) => r.competition_name === "La Liga");
    const premierLeague = competitionRows!.find(
      (r: { competition_name: string }) => r.competition_name === "Premier League",
    );
    expect(laLiga).toMatchObject({ entries: 1, entry_volume: 1000, net_result: 800, wins: 1, losses: 0, avg_payout: 1800 });
    expect(premierLeague).toMatchObject({ entries: 1, entry_volume: 500, net_result: -500, wins: 0, losses: 1 });

    const { data: recentHistory } = await player.client.rpc("get_user_entry_history", {
      p_date_from: null,
      p_date_to: null,
      p_order: "recent",
      p_limit: 20,
    });
    expect(recentHistory).toHaveLength(3);
    const statuses = recentHistory!.map((r: { status: string }) => r.status).sort();
    expect(statuses).toEqual(["LOST", "VOID", "WON"]);

    const { data: bestHistory } = await player.client.rpc("get_user_entry_history", {
      p_date_from: null,
      p_date_to: null,
      p_order: "best",
      p_limit: 10,
    });
    expect(bestHistory).toHaveLength(2);
    expect(bestHistory![0].status).toBe("WON");
    expect(bestHistory![0].final_option_share).toBeCloseTo(33.3, 1);

    const { data: worstHistory } = await player.client.rpc("get_user_entry_history", {
      p_date_from: null,
      p_date_to: null,
      p_order: "worst",
      p_limit: 10,
    });
    expect(worstHistory![0].status).toBe("LOST");
  });

  it("returns clean empty/null-safe values for a user with no entries at all", async () => {
    const player = await createTestPlayer(`user-analytics-empty-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const { data: overviewRows } = await player.client.rpc("get_user_analytics_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    const overview = overviewRows![0];
    expect(overview.pools_entered).toBe(0);
    expect(overview.entry_volume).toBe(0);
    expect(overview.graded_entries).toBe(0);

    const { data: financialRows } = await player.client.rpc("get_user_financial_overview", {
      p_date_from: "2000-01-01T00:00:00.000Z",
      p_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(financialRows![0].net_result).toBe(0);
    expect(financialRows![0].stake_basis).toBe(0);

    const { data: categoryRows } = await player.client.rpc("get_user_category_performance", {
      p_date_from: null,
      p_date_to: null,
    });
    expect(categoryRows).toEqual([]);

    const { data: historyRows } = await player.client.rpc("get_user_entry_history", {
      p_date_from: null,
      p_date_to: null,
      p_order: "recent",
      p_limit: 20,
    });
    expect(historyRows).toEqual([]);
  });

  it("never leaks one signed-in user's analytics to a different signed-in user", async () => {
    const owner = await createTestPlayer(`user-analytics-owner-${Date.now()}@example.com`);
    const intruder = await createTestPlayer(`user-analytics-intruder-${Date.now()}@example.com`);
    deactivatedIds.push(owner.userId, intruder.userId);

    const fixture = await createFixture("Serie A");
    createdFixtureIds.push(fixture);
    const pool = await createPool(adminId, fixture, "REGULATION_RESULT", null, [1000, 1000]);
    createdPoolIds.push(pool.poolId);

    const wonEntryId = await createEntry(owner.userId, pool.poolId, pool.optionAId, 1000, "WON");
    await createPayout(pool.settlementId, wonEntryId, 1800, owner.userId, pool.poolId);

    const wideFrom = "2000-01-01T00:00:00.000Z";
    const wideTo = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // The RPC has no parameter for "whose data" — it's always auth.uid()
    // internally, so calling it from the intruder's own signed-in session
    // must never see the owner's pool, regardless of what's passed.
    const { data: intruderOverview } = await intruder.client.rpc("get_user_analytics_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    expect(intruderOverview![0].pools_entered).toBe(0);
    const { data: intruderFinancial } = await intruder.client.rpc("get_user_financial_overview", {
      p_date_from: wideFrom,
      p_date_to: wideTo,
    });
    expect(intruderFinancial![0].net_result).toBe(0);

    const { data: ownerOverview } = await owner.client.rpc("get_user_analytics_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    expect(ownerOverview![0].pools_entered).toBe(1);
    const { data: ownerFinancial } = await owner.client.rpc("get_user_financial_overview", {
      p_date_from: wideFrom,
      p_date_to: wideTo,
    });
    expect(ownerFinancial![0].net_result).toBe(800);
  });

  it("does not double-count an entry that was settled, reversed, and re-settled", async () => {
    // Mirrors reverse_pool_settlement's real behavior: a new settlements
    // row at grading_version 2, the original settlement_payouts row left
    // in place (not deleted), and pools.snapshot_version bumped to match
    // the new current settlement. A join scoped only by entry_id would
    // fan this entry out into two rows.
    const player = await createTestPlayer(`user-analytics-reversal-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const fixture = await createFixture("Reversal League");
    createdFixtureIds.push(fixture);
    const pool = await createPool(adminId, fixture, "REGULATION_RESULT", null, [1000, 1000]);
    createdPoolIds.push(pool.poolId);

    const entryId = await createEntry(player.userId, pool.poolId, pool.optionAId, 1000, "WON");
    await createPayout(pool.settlementId, entryId, 1900, player.userId, pool.poolId);

    const { data: settlement2, error: settlement2Error } = await admin
      .from("settlements")
      .insert({ pool_id: pool.poolId, grading_version: 2, provider_status: "TEST" })
      .select("id")
      .single();
    if (settlement2Error || !settlement2) throw settlement2Error ?? new Error("failed to create second settlement");
    await createPayout(settlement2.id as string, entryId, 1900, player.userId, pool.poolId);
    await admin.from("pools").update({ snapshot_version: 2 }).eq("id", pool.poolId);

    const { data: overviewRows } = await player.client.rpc("get_user_analytics_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    const overview = overviewRows![0];
    expect(overview.pools_entered).toBe(1); // not 2 — must not fan out across both settlement_payouts rows

    const { data: financialRows } = await player.client.rpc("get_user_financial_overview", {
      p_date_from: "2000-01-01T00:00:00.000Z",
      p_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(financialRows![0].net_result).toBe(900); // 1900 - 1000, counted once (current settlement only)

    const { data: historyRows } = await player.client.rpc("get_user_entry_history", {
      p_date_from: null,
      p_date_to: null,
      p_order: "recent",
      p_limit: 20,
    });
    expect(historyRows).toHaveLength(1);
    expect(historyRows![0].net_result).toBe(900);
  });

  it("uses the actual wallet refund amount for a fee-retained VOID entry, not an assumed full refund", async () => {
    const player = await createTestPlayer(`user-analytics-void-refund-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const fixture = await createFixture("Refund League");
    createdFixtureIds.push(fixture);
    const pool = await createPool(adminId, fixture, "REGULATION_RESULT", null, [1000, 0]);
    createdPoolIds.push(pool.poolId);

    const entryId = await createEntry(player.userId, pool.poolId, pool.optionAId, 1000, "VOID");
    const { error: refundError } = await admin.from("wallet_transactions").insert({
      account_type: "user",
      user_id: player.userId,
      type: "pool_refund_credit",
      direction: "credit",
      amount: 800,
      balance_before: 0,
      balance_after: 800,
      pool_id: pool.poolId,
      entry_id: entryId,
      idempotency_key: randomUUID(),
    });
    if (refundError) throw refundError;

    const { data: overviewRows } = await player.client.rpc("get_user_analytics_overview", {
      p_date_from: null,
      p_date_to: null,
    });
    const overview = overviewRows![0];
    expect(overview.voids).toBe(1);

    const { data: financialRows } = await player.client.rpc("get_user_financial_overview", {
      p_date_from: "2000-01-01T00:00:00.000Z",
      p_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(financialRows![0].net_result).toBe(-200); // 800 actually credited - 1000 staked, not 0
  });

  it("groups competition performance by the stable provider id, not the display name", async () => {
    // Two different competitions can legitimately share a display name
    // (different countries/divisions) — grouping by competition_name alone
    // would silently merge them.
    const player = await createTestPlayer(`user-analytics-competition-key-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const fixtureEng = await createFixture("Premier League", "PL-ENG-TEST");
    const fixtureBra = await createFixture("Premier League", "PL-BRA-TEST");
    createdFixtureIds.push(fixtureEng, fixtureBra);

    const poolEng = await createPool(adminId, fixtureEng, "REGULATION_RESULT", null, [1000, 1000]);
    const poolBra = await createPool(adminId, fixtureBra, "REGULATION_RESULT", null, [1000, 1000]);
    createdPoolIds.push(poolEng.poolId, poolBra.poolId);

    const engEntryId = await createEntry(player.userId, poolEng.poolId, poolEng.optionAId, 1000, "WON");
    await createPayout(poolEng.settlementId, engEntryId, 1500, player.userId, poolEng.poolId);
    const braEntryId = await createEntry(player.userId, poolBra.poolId, poolBra.optionAId, 1000, "WON");
    await createPayout(poolBra.settlementId, braEntryId, 1600, player.userId, poolBra.poolId);

    const { data: competitionRows } = await player.client.rpc("get_user_competition_performance", {
      p_date_from: null,
      p_date_to: null,
    });
    const eng = competitionRows!.find((r: { competition_key: string }) => r.competition_key === "PL-ENG-TEST");
    const bra = competitionRows!.find((r: { competition_key: string }) => r.competition_key === "PL-BRA-TEST");
    expect(eng).toMatchObject({ competition_name: "Premier League", entries: 1, net_result: 500 });
    expect(bra).toMatchObject({ competition_name: "Premier League", entries: 1, net_result: 600 });
  });

  it("get_user_bankroll_balance seeds the series with the true opening balance, not the first in-range transaction", async () => {
    const player = await createTestPlayer(`user-analytics-bankroll-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const now = Date.now();
    const { error } = await admin.from("wallet_transactions").insert([
      {
        account_type: "user",
        user_id: player.userId,
        type: "manual_deposit",
        direction: "credit",
        amount: 500,
        balance_before: 0,
        balance_after: 500,
        idempotency_key: randomUUID(),
        created_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        account_type: "user",
        user_id: player.userId,
        type: "manual_deposit",
        direction: "credit",
        amount: 200,
        balance_before: 500,
        balance_after: 700,
        idempotency_key: randomUUID(),
        created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    if (error) throw error;

    const { data: rows } = await player.client.rpc("get_user_bankroll_balance", {
      p_date_from: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      p_date_to: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(rows![0].value).toBe(500); // opening balance carried in from before the window
    expect(rows![rows!.length - 1].value).toBe(700);
  });

  it("get_user_cumulative_pnl computes a bucketed running total entirely in SQL", async () => {
    const player = await createTestPlayer(`user-analytics-cumulative-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const fixtureA = await createFixture("Cumulative League A");
    const fixtureB = await createFixture("Cumulative League B");
    createdFixtureIds.push(fixtureA, fixtureB);
    const poolA = await createPool(adminId, fixtureA, "REGULATION_RESULT", null, [1000, 1000]);
    const poolB = await createPool(adminId, fixtureB, "REGULATION_RESULT", null, [1000, 1000]);
    createdPoolIds.push(poolA.poolId, poolB.poolId);

    const entryA = await createEntry(player.userId, poolA.poolId, poolA.optionAId, 1000, "WON");
    await createPayout(poolA.settlementId, entryA, 2000, player.userId, poolA.poolId);
    const entryB = await createEntry(player.userId, poolB.poolId, poolB.optionAId, 1000, "WON");
    await createPayout(poolB.settlementId, entryB, 2000, player.userId, poolB.poolId);

    const { data: rows } = await player.client.rpc("get_user_cumulative_pnl", {
      p_date_from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      p_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      p_granularity: "day",
      p_timezone: "UTC",
    });
    expect(rows).toHaveLength(1);
    expect(rows![0].bucket_net_result).toBe(2000); // (2000-1000) + (2000-1000)
    expect(rows![0].cumulative_net_result).toBe(2000);
  });

  // Realized ROI = graded_net_result / stake_basis, both attributed by
  // the pool's CURRENT settlement.created_at — never entry.created_at.
  // Each scenario below is isolated by querying get_user_financial_overview
  // with a date window that includes only that scenario's settlement time.
  describe("realized ROI attribution (get_user_financial_overview)", () => {
    it("covers all 5 required scenarios with independently-verifiable numbers", async () => {
      const player = await createTestPlayer(`user-analytics-roi-${Date.now()}@example.com`);
      deactivatedIds.push(player.userId);

      const juneInstant = "2026-06-15T12:00:00.000Z";
      const julyInstant = "2026-07-15T12:00:00.000Z";

      // Scenario 1: entered and settled in the same period (July).
      const fixture1 = await createFixture("ROI League 1");
      const pool1 = await createPool(adminId, fixture1, "REGULATION_RESULT", null, [1000, 1000], "MATCH_RESULT");
      const entry1 = await createEntry(player.userId, pool1.poolId, pool1.optionAId, 1000, "WON");
      await admin.from("settlements").update({ created_at: julyInstant }).eq("id", pool1.settlementId);
      await createPayout(pool1.settlementId, entry1, 1600, player.userId, pool1.poolId, julyInstant);

      // Scenario 2: entered June, settled July — must realize in July, not June.
      const fixture2 = await createFixture("ROI League 2");
      const pool2 = await createPool(adminId, fixture2, "REGULATION_RESULT", null, [1000, 1000], "MATCH_RESULT");
      const entry2Id = await createEntry(player.userId, pool2.poolId, pool2.optionAId, 1000, "LOST");
      await admin.from("entries").update({ created_at: juneInstant }).eq("id", entry2Id);
      await admin.from("settlements").update({ created_at: julyInstant }).eq("id", pool2.settlementId);
      // LOST entry: no wallet_transactions row at all (no payout, no refund).

      // Scenario 3: full refund in July — excluded from ROI's stake basis entirely.
      const fixture3 = await createFixture("ROI League 3");
      const pool3 = await createPool(adminId, fixture3, "REGULATION_RESULT", null, [1000, 0], "MATCH_RESULT");
      const entry3Id = await createEntry(player.userId, pool3.poolId, pool3.optionAId, 1000, "REFUNDED");
      await admin.from("wallet_transactions").insert({
        account_type: "user",
        user_id: player.userId,
        type: "pool_refund_credit",
        direction: "credit",
        amount: 1000,
        balance_before: 0,
        balance_after: 1000,
        pool_id: pool3.poolId,
        entry_id: entry3Id,
        idempotency_key: randomUUID(),
        created_at: julyInstant,
      });

      // Scenario 4: fee-retained partial refund in July — also excluded from ROI's stake basis.
      const fixture4 = await createFixture("ROI League 4");
      const pool4 = await createPool(adminId, fixture4, "REGULATION_RESULT", null, [1000, 0], "MATCH_RESULT");
      const entry4Id = await createEntry(player.userId, pool4.poolId, pool4.optionAId, 1000, "VOID");
      await admin.from("wallet_transactions").insert({
        account_type: "user",
        user_id: player.userId,
        type: "pool_refund_credit",
        direction: "credit",
        amount: 700,
        balance_before: 0,
        balance_after: 700,
        pool_id: pool4.poolId,
        entry_id: entry4Id,
        idempotency_key: randomUUID(),
        created_at: julyInstant,
      });

      // Scenario 5: settled, reversed, re-settled — only the CURRENT
      // settlement (grading_version 2, July) counts; the original
      // (grading_version 1) is superseded and must not double-count.
      const fixture5 = await createFixture("ROI League 5");
      const pool5 = await createPool(adminId, fixture5, "REGULATION_RESULT", null, [1000, 1000], "MATCH_RESULT");
      const entry5Id = await createEntry(player.userId, pool5.poolId, pool5.optionAId, 1000, "WON");
      await admin.from("settlements").update({ created_at: juneInstant }).eq("id", pool5.settlementId);
      await createPayout(pool5.settlementId, entry5Id, 1900, player.userId, pool5.poolId, juneInstant);
      const { data: pool5Settlement2, error: pool5Settlement2Error } = await admin
        .from("settlements")
        .insert({ pool_id: pool5.poolId, grading_version: 2, provider_status: "TEST", created_at: julyInstant })
        .select("id")
        .single();
      if (pool5Settlement2Error || !pool5Settlement2) throw pool5Settlement2Error ?? new Error("failed to create settlement 2");
      await createPayout(pool5Settlement2.id as string, entry5Id, 1900, player.userId, pool5.poolId, julyInstant);
      await admin.from("pools").update({ snapshot_version: 2 }).eq("id", pool5.poolId);

      createdFixtureIds.push(fixture1, fixture2, fixture3, fixture4, fixture5);
      createdPoolIds.push(pool1.poolId, pool2.poolId, pool3.poolId, pool4.poolId, pool5.poolId);

      const juneFrom = "2026-06-01T00:00:00.000Z";
      const juneTo = "2026-07-01T00:00:00.000Z";
      const julyFrom = "2026-07-01T00:00:00.000Z";
      const julyTo = "2026-08-01T00:00:00.000Z";

      const { data: juneRows } = await player.client.rpc("get_user_financial_overview", {
        p_date_from: juneFrom,
        p_date_to: juneTo,
      });
      // Only scenario 5's ORIGINAL settlement (June) would fall here if it
      // weren't superseded — since it's superseded by grading_version 2,
      // nothing realizes in June at all.
      expect(juneRows![0].net_result).toBe(0);
      expect(juneRows![0].graded_net_result).toBe(0);
      expect(juneRows![0].stake_basis).toBe(0);

      const { data: julyRows } = await player.client.rpc("get_user_financial_overview", {
        p_date_from: julyFrom,
        p_date_to: julyTo,
      });
      const july = julyRows![0];
      // graded_net_result / stake_basis: scenario 1 (WON, +600), scenario 2
      // (LOST, -1000), scenario 5 (WON via current settlement only, +900).
      expect(july.graded_net_result).toBe(600 - 1000 + 900);
      expect(july.stake_basis).toBe(1000 + 1000 + 1000);
      // net_result additionally includes scenario 3's full refund (0) and
      // scenario 4's fee-retained partial refund (-300), neither of which
      // touches the ROI stake basis.
      expect(july.net_result).toBe(600 - 1000 + 900 + 0 + (700 - 1000));

      const realizedRoi = july.graded_net_result / july.stake_basis;
      expect(realizedRoi).toBeCloseTo(500 / 3000, 5);
    });
  });
});
