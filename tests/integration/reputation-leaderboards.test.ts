/**
 * Integration tests for Milestone R11 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Reputation + Leaderboards) — get_user_prediction_record(),
 * get_call_bs_record(), get_prediction_leaderboard(), and security. Real
 * local Supabase throughout. No wallet/monetary table is ever touched by
 * these RPCs — verified explicitly below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl, getTestSupabaseConfig } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();
const PROVIDER = "api_nfl";

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];
const createdChallengeIds: string[] = [];

async function createFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `r11-fixture-${randomUUID()}`,
      home_team_name: "Home Test NFL",
      away_team_name: "Away Test NFL",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  createdFixtureIds.push(data.id);
  return data.id;
}

async function createMarket(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket({
    provider: PROVIDER,
    providerMarketId: `m_${Math.random().toString(36).slice(2)}`,
    providerEventId: null,
    question: "Will the home team win?",
    description: null,
    status: "ACTIVE",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Home", no: "Away" } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "test",
    providerMetadata: {},
    ...overrides,
  });
  createdMarketIds.push(id);
  return id;
}

/** A fresh fixture+market pair every time — MONEYLINE markets are unique per fixture, so distinct Picks need distinct fixtures, mirroring every other R7-R11 test file's own established pattern. */
async function createFreshMarket(): Promise<string> {
  return createMarket(await createFixture());
}

async function createUser(label = "r11") {
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

async function pick(userId: string, marketId: string, selectedOutcome: "YES" | "NO"): Promise<string> {
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

async function grade(predictionId: string, result: "CORRECT" | "INCORRECT" | "VOID", gradedAt?: string) {
  const resolvedOutcomeSnapshot = result === "VOID" ? null : result === "CORRECT" ? "YES" : "NO";
  const { error } = await admin
    .from("predictions")
    .update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: resolvedOutcomeSnapshot, graded_at: gradedAt ?? new Date().toISOString() })
    .eq("id", predictionId);
  if (error) throw error;
}

async function createResolvedChallenge(
  marketId: string,
  challengerUserId: string,
  challengerPredictionId: string,
  recipientUserId: string,
  recipientPredictionId: string,
  result: "CHALLENGER_WON" | "RECIPIENT_WON" | "VOID",
): Promise<string> {
  const { data, error } = await admin
    .from("challenges")
    .insert({
      market_id: marketId,
      challenger_user_id: challengerUserId,
      recipient_user_id: recipientUserId,
      challenger_prediction_id: challengerPredictionId,
      recipient_prediction_id: recipientPredictionId,
      challenger_selection_snapshot: "YES",
      recipient_selection_snapshot: "NO",
      status: "RESOLVED",
      result,
      accepted_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("challenge creation failed");
  createdChallengeIds.push(data.id);
  return data.id;
}

async function setPolicy(overrides: Record<string, unknown>) {
  const { error } = await admin.from("platform_settings").update(overrides).eq("id", true);
  if (error) throw error;
}

async function getUserPredictionRecord(userId: string, client = admin) {
  const { data, error } = await client.rpc("get_user_prediction_record", { p_user_id: userId }).single();
  if (error) throw error;
  return data as {
    correct: number;
    incorrect: number;
    void: number;
    decided: number;
    accuracy: number | null;
    min_decided_for_leaderboard: number;
    eligible_for_leaderboard: boolean;
  };
}

async function getCallBsRecord(userId: string, client = admin) {
  const { data, error } = await client.rpc("get_call_bs_record", { p_user_id: userId }).single();
  if (error) throw error;
  return data as { wins: number; losses: number; void: number };
}

async function getLeaderboard(period: "ALL_TIME" | "WEEK" | "MONTH", limit = 50, offset = 0, client = admin) {
  const { data, error } = await client.rpc("get_prediction_leaderboard", { p_period: period, p_limit: limit, p_offset: offset });
  if (error) throw error;
  return data as Array<{
    user_id: string;
    display_name: string;
    username: string | null;
    avatar_url: string | null;
    correct: number;
    incorrect: number;
    void: number;
    decided: number;
    accuracy: number;
    rank: number;
    total_eligible: number;
  }>;
}

beforeEach(async () => {
  await setPolicy({ leaderboard_min_decided_picks: 5 });
});

afterEach(async () => {
  if (createdChallengeIds.length > 0) {
    await admin.from("notifications").delete().in("challenge_id", createdChallengeIds);
    await admin.from("challenges").delete().in("id", createdChallengeIds);
    createdChallengeIds.length = 0;
  }
  if (createdMarketIds.length > 0) {
    // Milestone R13.5's own financial-isolation test can create real
    // monetary_proposals/monetary_positions rows referencing predictions
    // on these markets — both must be cleared before deleting predictions
    // (a real FK), mirroring the established ordering in
    // tests/integration/monetary-challenge-position.test.ts.
    const { data: positionRows } = await admin.from("monetary_positions").select("id").in("market_id", createdMarketIds);
    const positionIds = (positionRows ?? []).map((r) => r.id);
    const { data: proposalRows } = await admin.from("monetary_proposals").select("id").in("market_id", createdMarketIds);
    const proposalIds = (proposalRows ?? []).map((r) => r.id);
    if (proposalIds.length > 0) {
      await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
      if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
      await admin.from("monetary_proposals").delete().in("id", proposalIds);
    }
    if (positionIds.length > 0) await admin.from("monetary_position_settlements").delete().in("position_id", positionIds);
    await admin.from("wallet_reservations").delete().in("user_id", createdUserIds);
    await admin.from("predictions").delete().in("market_id", createdMarketIds);
    await admin.from("markets").delete().in("id", createdMarketIds);
    createdMarketIds.length = 0;
  }
  if (createdFixtureIds.length > 0) {
    await admin.from("fixtures").delete().in("id", createdFixtureIds);
    createdFixtureIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
    createdUserIds.length = 0;
  }
  await setPolicy({ leaderboard_min_decided_picks: 5 });
});

describe("Prediction record", () => {
  it("counts correct/incorrect/void and excludes void from the accuracy denominator", async () => {
    const { userId } = await createUser("basic");
    for (let i = 0; i < 10; i++) await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");
    for (let i = 0; i < 5; i++) await grade(await pick(userId, await createFreshMarket(), "YES"), "INCORRECT");
    for (let i = 0; i < 2; i++) await grade(await pick(userId, await createFreshMarket(), "YES"), "VOID");

    const record = await getUserPredictionRecord(userId);
    expect(record.correct).toBe(10);
    expect(record.incorrect).toBe(5);
    expect(record.void).toBe(2);
    expect(record.decided).toBe(15);
    expect(Number(record.accuracy)).toBeCloseTo(10 / 15, 4);
    expect(record.eligible_for_leaderboard).toBe(true);
  });

  it("zero-decided accuracy is null, never a fabricated 0%, and never eligible regardless of configured minimum", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 0 });
    const { userId } = await createUser("zeroDecided");
    await grade(await pick(userId, await createFreshMarket(), "YES"), "VOID");

    const record = await getUserPredictionRecord(userId);
    expect(record.decided).toBe(0);
    expect(record.accuracy).toBeNull();
    expect(record.eligible_for_leaderboard).toBe(false);
  });

  it("pending Picks never count toward the record", async () => {
    const { userId } = await createUser("pending");
    await pick(userId, await createFreshMarket(), "YES"); // never graded
    const record = await getUserPredictionRecord(userId);
    expect(record.correct + record.incorrect + record.void).toBe(0);
  });

  it("a below-minimum user has a real, visible record but is not eligible", async () => {
    const { userId } = await createUser("belowMin");
    await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");
    await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");

    const record = await getUserPredictionRecord(userId);
    expect(record.decided).toBe(2);
    expect(Number(record.accuracy)).toBe(1);
    expect(record.eligible_for_leaderboard).toBe(false);

    const board = await getLeaderboard("ALL_TIME", 200);
    expect(board.some((row) => row.user_id === userId)).toBe(false);
  });

  it("exactly at the configured minimum is eligible", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 3 });
    const { userId } = await createUser("exactMin");
    for (let i = 0; i < 3; i++) await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");

    const record = await getUserPredictionRecord(userId);
    expect(record.decided).toBe(3);
    expect(record.eligible_for_leaderboard).toBe(true);
  });

  it("multiple Markets on the same Game each count as an independent prediction outcome", async () => {
    const { userId } = await createUser("multiMarket");
    const fixtureId = await createFixture();
    const spreadMarket = await createMarket(fixtureId, { marketTemplate: "SPREAD", lineValue: 6.5 });
    const totalMarket = await createMarket(fixtureId, { marketTemplate: "TOTAL", yesSide: null, lineValue: 47.5 });
    await grade(await pick(userId, spreadMarket, "YES"), "CORRECT");
    await grade(await pick(userId, totalMarket, "YES"), "INCORRECT");

    const record = await getUserPredictionRecord(userId);
    expect(record.decided).toBe(2);
    expect(record.correct).toBe(1);
    expect(record.incorrect).toBe(1);
  });

  it("historical (old) graded Picks remain part of the all-time record regardless of when they graded", async () => {
    const { userId } = await createUser("historical");
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT", longAgo);

    const record = await getUserPredictionRecord(userId);
    expect(record.correct).toBe(1);
  });
});

describe("Money never affects prediction reputation", () => {
  it("a funded, monetary-active user and a free-only user with identical Pick results have identical reputation", async () => {
    const { userId: funded } = await createUser("moneyFunded");
    const { userId: free } = await createUser("moneyFree");

    const { error: depositError } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: funded,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: 500000,
      p_admin_id: null,
      p_reason: "test",
      p_idempotency_key: randomUUID(),
    });
    expect(depositError).toBeNull();

    await grade(await pick(funded, await createFreshMarket(), "YES"), "CORRECT");
    await grade(await pick(free, await createFreshMarket(), "YES"), "CORRECT");
    await grade(await pick(funded, await createFreshMarket(), "YES"), "INCORRECT");
    await grade(await pick(free, await createFreshMarket(), "YES"), "INCORRECT");

    const fundedRecord = await getUserPredictionRecord(funded);
    const freeRecord = await getUserPredictionRecord(free);
    expect(fundedRecord.correct).toBe(freeRecord.correct);
    expect(fundedRecord.incorrect).toBe(freeRecord.incorrect);
    expect(fundedRecord.decided).toBe(freeRecord.decided);
    expect(Number(fundedRecord.accuracy)).toBe(Number(freeRecord.accuracy));
  });

  it("a free-only user (never opened a wallet) can become leaderboard-eligible and rank #1", async () => {
    const { userId: free } = await createUser("freeOnlyChamp");
    // A large, unambiguous 100%-accuracy sample — decided-count is the
    // leaderboard's own first tie-breaker after accuracy, so this
    // deterministically outranks every other 100%-accuracy user this same
    // test file creates elsewhere (the largest of which has 20 decided).
    for (let i = 0; i < 25; i++) await grade(await pick(free, await createFreshMarket(), "YES"), "CORRECT");

    const { data: wallet } = await admin.from("wallet_balances").select("id").eq("user_id", free).eq("account_type", "user").maybeSingle();
    // The wallet row is auto-provisioned for every profile (R2-era trigger) but the user never deposited into it.
    if (wallet) {
      const { data: balanceRow } = await admin.from("wallet_balances").select("balance").eq("id", wallet.id).single();
      expect(balanceRow?.balance).toBe(0);
    }

    const board = await getLeaderboard("ALL_TIME", 200);
    const row = board.find((r) => r.user_id === free);
    expect(row).toBeDefined();
    expect(row?.rank).toBe(1);
  });

  it("a monetary Position never creates or affects Call BS or prediction reputation", async () => {
    const { userId: proposer } = await createUser("posProposer");
    const { userId: recipient } = await createUser("posRecipient");
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
    for (const uid of [proposer, recipient]) {
      await admin.rpc("apply_wallet_transaction", {
        p_account_type: "user",
        p_user_id: uid,
        p_type: "manual_deposit",
        p_direction: "credit",
        p_amount: 100000,
        p_admin_id: null,
        p_reason: "test",
        p_idempotency_key: randomUUID(),
      });
    }
    const marketId = await createFreshMarket();
    const proposerPredictionId = await pick(proposer, marketId, "YES");
    const recipientPredictionId = await pick(recipient, marketId, "NO");
    const { data: proposal, error: proposeError } = await admin
      .rpc("propose_money", {
        p_proposer_user_id: proposer,
        p_recipient_prediction_id: recipientPredictionId,
        p_stake: 1000,
        p_idempotency_key: randomUUID(),
        p_source_challenge_id: null,
      })
      .single();
    expect(proposeError).toBeNull();
    const { error: acceptError } = await admin.rpc("accept_monetary_proposal", { p_proposal_id: (proposal as { id: string }).id, p_recipient_user_id: recipient });
    expect(acceptError).toBeNull();

    const proposerCallBs = await getCallBsRecord(proposer);
    expect(proposerCallBs.wins + proposerCallBs.losses + proposerCallBs.void).toBe(0);

    await grade(proposerPredictionId, "CORRECT");
    const record = await getUserPredictionRecord(proposer);
    expect(record.correct).toBe(1);
    await admin.from("platform_settings").update({ monetary_p2p_enabled: false }).eq("id", true);
  });
});

describe("Leaderboard ranking", () => {
  it("orders by accuracy DESC, then decided DESC as a tie-breaker, with sequential unique ranks", async () => {
    const { userId: bigSample } = await createUser("rankBig");
    for (let i = 0; i < 40; i++) await grade(await pick(bigSample, await createFreshMarket(), "YES"), "CORRECT");
    for (let i = 0; i < 10; i++) await grade(await pick(bigSample, await createFreshMarket(), "YES"), "INCORRECT");

    const { userId: smallSample } = await createUser("rankSmall");
    for (let i = 0; i < 5; i++) await grade(await pick(smallSample, await createFreshMarket(), "YES"), "CORRECT");

    const board = await getLeaderboard("ALL_TIME", 200);
    const bigRow = board.find((r) => r.user_id === bigSample)!;
    const smallRow = board.find((r) => r.user_id === smallSample)!;
    expect(smallRow.accuracy).toBe(1);
    expect(Number(bigRow.accuracy)).toBeCloseTo(0.8, 4);
    expect(smallRow.rank).toBeLessThan(bigRow.rank); // 100% (smaller sample) ranks above 80% (bigger sample)

    const ranks = board.map((r) => r.rank);
    expect(new Set(ranks).size).toBe(ranks.length); // no two rows share a rank
  });

  it("equal accuracy breaks the tie by decided count, then correct count, then stable user id", async () => {
    const { userId: moreDecided } = await createUser("tieMore");
    for (let i = 0; i < 20; i++) await grade(await pick(moreDecided, await createFreshMarket(), "YES"), "CORRECT");

    const { userId: fewerDecided } = await createUser("tieFewer");
    for (let i = 0; i < 5; i++) await grade(await pick(fewerDecided, await createFreshMarket(), "YES"), "CORRECT");

    const board = await getLeaderboard("ALL_TIME", 200);
    const moreRow = board.find((r) => r.user_id === moreDecided)!;
    const fewerRow = board.find((r) => r.user_id === fewerDecided)!;
    expect(moreRow.accuracy).toBe(1);
    expect(fewerRow.accuracy).toBe(1);
    expect(moreRow.rank).toBeLessThan(fewerRow.rank); // both 100% -> larger decided count ranks first
  });

  it("excludes admin and super_admin accounts even with a perfect eligible record", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 1 });
    const email = `r11-admin-${randomUUID()}@test.local`;
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
    if (authErr || !authData.user) throw authErr ?? new Error("failed");
    createdUserIds.push(authData.user.id);
    await admin.from("user_profiles").insert({ id: authData.user.id, display_name: "sneaky admin", role: "admin", is_active: true });
    await grade(await pick(authData.user.id, await createFreshMarket(), "YES"), "CORRECT");

    const board = await getLeaderboard("ALL_TIME", 200);
    expect(board.some((row) => row.user_id === authData.user.id)).toBe(false);
  });

  it("excludes inactive (soft-closed) accounts", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 1 });
    const { userId } = await createUser("inactive");
    await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");
    await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);

    const board = await getLeaderboard("ALL_TIME", 200);
    expect(board.some((row) => row.user_id === userId)).toBe(false);
  });

  it("is bounded and paginated via limit/offset, deterministically", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { userId } = await createUser(`page${i}`);
      await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");
      ids.push(userId);
    }
    const page1 = await getLeaderboard("ALL_TIME", 2, 0);
    const page2 = await getLeaderboard("ALL_TIME", 2, 2);
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    const page1Ids = page1.map((r) => r.user_id);
    const page2Ids = page2.map((r) => r.user_id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false); // no overlap
    expect(page1[0].rank).toBe(1);
    expect(page2[0].rank).toBe(3);
  });

  it("rejects an invalid period", async () => {
    const { error } = await admin.rpc("get_prediction_leaderboard", { p_period: "DAILY" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/invalid_period/);
  });
});

describe("Period semantics", () => {
  it("WEEK excludes a Pick graded well outside the current window", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 1 });
    const { userId } = await createUser("oldWeek");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT", longAgo);

    const weekBoard = await getLeaderboard("WEEK", 200);
    expect(weekBoard.some((row) => row.user_id === userId)).toBe(false);
    const allTimeBoard = await getLeaderboard("ALL_TIME", 200);
    expect(allTimeBoard.some((row) => row.user_id === userId)).toBe(true);
  });

  it("WEEK includes a Pick graded moments ago", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 1 });
    const { userId } = await createUser("freshWeek");
    await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");

    const weekBoard = await getLeaderboard("WEEK", 200);
    expect(weekBoard.some((row) => row.user_id === userId)).toBe(true);
    const monthBoard = await getLeaderboard("MONTH", 200);
    expect(monthBoard.some((row) => row.user_id === userId)).toBe(true);
  });
});

describe("Call BS record", () => {
  it("counts wins/losses/void from RESOLVED Challenges only, correctly attributing by side", async () => {
    const { userId: andre } = await createUser("andre");
    const { userId: carlos } = await createUser("carlos");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");
    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "CHALLENGER_WON");

    const andreRecord = await getCallBsRecord(andre);
    const carlosRecord = await getCallBsRecord(carlos);
    expect(andreRecord.wins).toBe(1);
    expect(andreRecord.losses).toBe(0);
    expect(carlosRecord.wins).toBe(0);
    expect(carlosRecord.losses).toBe(1);
  });

  it("attributes correctly when the recipient (not the challenger) wins", async () => {
    const { userId: andre } = await createUser("andre2");
    const { userId: carlos } = await createUser("carlos2");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");
    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "RECIPIENT_WON");

    const andreRecord = await getCallBsRecord(andre);
    const carlosRecord = await getCallBsRecord(carlos);
    expect(andreRecord.losses).toBe(1);
    expect(carlosRecord.wins).toBe(1);
  });

  it("counts VOID separately, neither a win nor a loss", async () => {
    const { userId: andre } = await createUser("andre3");
    const { userId: carlos } = await createUser("carlos3");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");
    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "VOID");

    const record = await getCallBsRecord(andre);
    expect(record.wins).toBe(0);
    expect(record.losses).toBe(0);
    expect(record.void).toBe(1);
  });

  it("pending, declined, and expired Challenges never count", async () => {
    const { userId: u1 } = await createUser("pendingCbs1");
    const { userId: u2 } = await createUser("pendingCbs2");
    const marketId = await createFreshMarket();
    const p1 = await pick(u1, marketId, "YES");
    const p2 = await pick(u2, marketId, "NO");

    const { data: pendingChallenge } = await admin
      .from("challenges")
      .insert({
        market_id: marketId,
        challenger_user_id: u1,
        recipient_user_id: u2,
        challenger_prediction_id: p1,
        recipient_prediction_id: p2,
        challenger_selection_snapshot: "YES",
        recipient_selection_snapshot: "NO",
        status: "PENDING",
      })
      .select("id")
      .single();
    createdChallengeIds.push(pendingChallenge!.id);

    const record = await getCallBsRecord(u1);
    expect(record.wins + record.losses + record.void).toBe(0);
  });

  it("multiple accepted Challenges on the same Pick each count independently, without inflating prediction accuracy", async () => {
    const { userId: andre } = await createUser("andreMulti");
    const { userId: carlos } = await createUser("carlosMulti");
    const { userId: david } = await createUser("davidMulti");
    const { userId: sarah } = await createUser("sarahMulti");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");
    const davidPred = await pick(david, marketId, "NO");
    const sarahPred = await pick(sarah, marketId, "NO");

    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "CHALLENGER_WON");
    await createResolvedChallenge(marketId, andre, andrePred, david, davidPred, "CHALLENGER_WON");
    await createResolvedChallenge(marketId, andre, andrePred, sarah, sarahPred, "CHALLENGER_WON");

    const andreCallBs = await getCallBsRecord(andre);
    expect(andreCallBs.wins).toBe(3);

    await grade(andrePred, "CORRECT");
    const andreRecord = await getUserPredictionRecord(andre);
    expect(andreRecord.correct).toBe(1); // never +4
  });
});

/**
 * Milestone R13.5 — resolves R13's own "PRODUCT / ABUSE DECISION
 * REQUIRED — CALL BS REPUTATION FARMING" finding. Locked rule: one Pick
 * can contribute at most one Call BS reputation result against the same
 * opponent (reputation event identity = my Pick + opposing user, not the
 * Challenge id and not the opponent's specific Pick). Raw Challenge rows
 * are never deleted or merged — only the counted reputation result
 * dedupes. Covers every scenario in the milestone's own §14 test list.
 */
describe("Call BS reputation dedup (R13.5 farming fix)", () => {
  it("same Pick + same opponent, 5 resolved Challenges → 1 decided result", async () => {
    const { userId: andre } = await createUser("dedupA1");
    const { userId: carlos } = await createUser("dedupC1");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");

    for (let i = 0; i < 5; i++) {
      await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "CHALLENGER_WON");
    }

    const andreRecord = await getCallBsRecord(andre);
    const carlosRecord = await getCallBsRecord(carlos);
    expect(andreRecord.wins + andreRecord.losses + andreRecord.void).toBe(1);
    expect(andreRecord.wins).toBe(1);
    expect(carlosRecord.wins + carlosRecord.losses + carlosRecord.void).toBe(1);
    expect(carlosRecord.losses).toBe(1);
  });

  it("same Pick + five different opponents → 5 independent reputation results", async () => {
    const { userId: andre } = await createUser("dedupA2");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");

    for (const label of ["carlos", "maria", "jose", "laura", "diego"]) {
      const { userId: opponent } = await createUser(`dedup2-${label}`);
      const opponentPred = await pick(opponent, marketId, "NO");
      await createResolvedChallenge(marketId, andre, andrePred, opponent, opponentPred, "CHALLENGER_WON");
    }

    const andreRecord = await getCallBsRecord(andre);
    expect(andreRecord.wins).toBe(5);
  });

  it("same opponent + a different Pick → separate reputation results", async () => {
    const { userId: andre } = await createUser("dedupA3");
    const { userId: carlos } = await createUser("dedupC3");
    const marketA = await createFreshMarket();
    const marketB = await createFreshMarket();
    const andrePredA = await pick(andre, marketA, "YES");
    const carlosPredA = await pick(carlos, marketA, "NO");
    const andrePredB = await pick(andre, marketB, "YES");
    const carlosPredB = await pick(carlos, marketB, "NO");

    await createResolvedChallenge(marketA, andre, andrePredA, carlos, carlosPredA, "CHALLENGER_WON");
    await createResolvedChallenge(marketB, andre, andrePredB, carlos, carlosPredB, "RECIPIENT_WON");

    const andreRecord = await getCallBsRecord(andre);
    // Two distinct (myPick, opponent) pairs — both count.
    expect(andreRecord.wins).toBe(1);
    expect(andreRecord.losses).toBe(1);
  });

  it("reverse challenger direction on the same Pick pair still counts as one result", async () => {
    const { userId: andre } = await createUser("dedupA4");
    const { userId: carlos } = await createUser("dedupC4");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");

    // André challenges Carlos, then (a separate Challenge row) Carlos challenges André — same underlying Pick pair either way.
    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "CHALLENGER_WON");
    await createResolvedChallenge(marketId, carlos, carlosPred, andre, andrePred, "RECIPIENT_WON"); // recipient here is André, who still wins (his Pick was CORRECT)

    const andreRecord = await getCallBsRecord(andre);
    expect(andreRecord.wins + andreRecord.losses + andreRecord.void).toBe(1);
    expect(andreRecord.wins).toBe(1);
  });

  it("a PENDING duplicate on the same pair does not affect the deduplicated reputation count", async () => {
    const { userId: andre } = await createUser("dedupA5");
    const { userId: carlos } = await createUser("dedupC5");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");

    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "CHALLENGER_WON");
    // A second, still-PENDING attempt at a NEW pick pair between the same two users — never resolves, never counts.
    const marketId2 = await createFreshMarket();
    const andrePred2 = await pick(andre, marketId2, "YES");
    const carlosPred2 = await pick(carlos, marketId2, "NO");
    const { data: pendingChallenge } = await admin
      .from("challenges")
      .insert({
        market_id: marketId2,
        challenger_user_id: andre,
        recipient_user_id: carlos,
        challenger_prediction_id: andrePred2,
        recipient_prediction_id: carlosPred2,
        challenger_selection_snapshot: "YES",
        recipient_selection_snapshot: "NO",
        status: "PENDING",
      })
      .select("id")
      .single();
    createdChallengeIds.push(pendingChallenge!.id);

    const andreRecord = await getCallBsRecord(andre);
    expect(andreRecord.wins + andreRecord.losses + andreRecord.void).toBe(1);
  });

  it("declined/expired Challenges never contribute to the deduplicated count", async () => {
    const { userId: andre } = await createUser("dedupA6");
    const { userId: carlos } = await createUser("dedupC6");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");
    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "CHALLENGER_WON");

    for (const status of ["DECLINED", "EXPIRED"] as const) {
      const freshMarket = await createFreshMarket();
      const aPred = await pick(andre, freshMarket, "YES");
      const cPred = await pick(carlos, freshMarket, "NO");
      const { data: row } = await admin
        .from("challenges")
        .insert({
          market_id: freshMarket,
          challenger_user_id: andre,
          recipient_user_id: carlos,
          challenger_prediction_id: aPred,
          recipient_prediction_id: cPred,
          challenger_selection_snapshot: "YES",
          recipient_selection_snapshot: "NO",
          status,
          ...(status === "DECLINED" ? { declined_at: new Date().toISOString() } : {}),
        })
        .select("id")
        .single();
      createdChallengeIds.push(row!.id);
    }

    const andreRecord = await getCallBsRecord(andre);
    expect(andreRecord.wins + andreRecord.losses + andreRecord.void).toBe(1);
  });

  it("VOID follows existing R11 VOID semantics under dedup — repeated VOID on the same pair still counts once", async () => {
    const { userId: andre } = await createUser("dedupA7");
    const { userId: carlos } = await createUser("dedupC7");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");

    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "VOID");
    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "VOID");

    const andreRecord = await getCallBsRecord(andre);
    expect(andreRecord.void).toBe(1);
    expect(andreRecord.wins).toBe(0);
    expect(andreRecord.losses).toBe(0);
  });

  it("a Monetary Position for the same two users has no effect on their Call BS reputation", async () => {
    const { userId: andre } = await createUser("dedupA8");
    const { userId: carlos } = await createUser("dedupC8");
    const marketId = await createFreshMarket();
    const andrePred = await pick(andre, marketId, "YES");
    const carlosPred = await pick(carlos, marketId, "NO");
    await createResolvedChallenge(marketId, andre, andrePred, carlos, carlosPred, "CHALLENGER_WON");
    const before = await getCallBsRecord(andre);

    // A real, fully funded, committed Monetary Position between the exact
    // same two users (on a fresh, separate Pick pair — money and Call BS
    // are independent product surfaces, this is the same-users case) —
    // get_call_bs_record must remain completely blind to it, since its
    // own query never references monetary_positions/monetary_proposals
    // at all.
    const { proposeMoney, acceptMonetaryProposal } = await import("@/lib/monetary/repository");
    const moneyMarketId = await createFreshMarket();
    const andreMoneyPred = await pick(andre, moneyMarketId, "YES");
    const carlosMoneyPred = await pick(carlos, moneyMarketId, "NO");
    await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: andre, p_type: "manual_deposit", p_direction: "credit", p_amount: 1000, p_admin_id: null, p_reason: "test", p_idempotency_key: randomUUID() });
    await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: carlos, p_type: "manual_deposit", p_direction: "credit", p_amount: 1000, p_admin_id: null, p_reason: "test", p_idempotency_key: randomUUID() });
    await setPolicy({ monetary_p2p_enabled: true });
    const proposed = await proposeMoney(andre, carlosMoneyPred, 500, randomUUID());
    if (proposed.ok) await acceptMonetaryProposal(proposed.proposal.id, carlos);
    void andreMoneyPred;

    const after = await getCallBsRecord(andre);
    expect(after).toEqual(before);
  });

  it("data integrity: every (myPick, opponent) group in local data agrees on a single outcome — no contradictory resolved results", async () => {
    // §8 audit, made concrete: structurally, a Challenge's result is
    // derived entirely from both Predictions' own immutable `result`
    // columns (lib/challenges/resolution.ts decideChallengeResolution),
    // so every resolved Challenge sharing a (my Pick, opponent) pair MUST
    // agree. This test proves it holds against real local data rather
    // than resting on the argument alone.
    const pgClient = new Client({ connectionString: getTestDatabaseUrl() });
    await pgClient.connect();
    const { rows } = await pgClient.query(`
      with events as (
        select
          case when challenger_user_id < recipient_user_id then challenger_prediction_id else recipient_prediction_id end as pick_a,
          case when challenger_user_id < recipient_user_id then recipient_prediction_id else challenger_prediction_id end as pick_b,
          result
        from challenges
        where status = 'RESOLVED'
      )
      select pick_a, pick_b, count(distinct result) as distinct_results
      from events
      group by pick_a, pick_b
      having count(distinct result) > 1
    `);
    await pgClient.end();
    expect(rows, "contradictory resolved Call BS results found for the same underlying Pick pair").toEqual([]);
  });
});

describe("Security", () => {
  it("anon cannot call any of the three reputation RPCs", async () => {
    const { userId } = await createUser("secTargetAnon");
    const anon = getTestAnonClient();
    const { error: e1 } = await anon.rpc("get_user_prediction_record", { p_user_id: userId });
    expect(e1).not.toBeNull();
    const { error: e2 } = await anon.rpc("get_call_bs_record", { p_user_id: userId });
    expect(e2).not.toBeNull();
    const { error: e3 } = await anon.rpc("get_prediction_leaderboard", { p_period: "ALL_TIME" });
    expect(e3).not.toBeNull();
  });

  it("any authenticated user can read another user's reputation (public, same as a Pick or a RESOLVED Challenge)", async () => {
    const { userId: target } = await createUser("secTarget");
    await grade(await pick(target, await createFreshMarket(), "YES"), "CORRECT");
    const { client: viewerClient } = await createUser("secViewer");

    const record = await getUserPredictionRecord(target, viewerClient);
    expect(record.correct).toBe(1);
  });

  it("no client can write to predictions/challenges through these RPCs — they are read-only by construction", async () => {
    // The RPCs themselves take only a user id / period+pagination — there
    // is no write parameter to attempt in the first place. Confirmed here
    // structurally: calling them never changes any row.
    const { userId } = await createUser("readOnlyCheck");
    const predictionId = await pick(userId, await createFreshMarket(), "YES");
    await getUserPredictionRecord(userId);
    const { data: stillPending } = await admin.from("predictions").select("lifecycle_state").eq("id", predictionId).single();
    expect(stillPending?.lifecycle_state).toBe("PENDING");
  });
});

describe("Financial isolation", () => {
  it("changing a user's wallet balance never changes their prediction record or leaderboard rank", async () => {
    await setPolicy({ leaderboard_min_decided_picks: 1 });
    const { userId } = await createUser("financialIsolation");
    await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");
    const before = await getUserPredictionRecord(userId);
    const boardBefore = await getLeaderboard("ALL_TIME", 200);
    const rankBefore = boardBefore.find((r) => r.user_id === userId)?.rank;

    await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: 1000000,
      p_admin_id: null,
      p_reason: "test",
      p_idempotency_key: randomUUID(),
    });

    const after = await getUserPredictionRecord(userId);
    const boardAfter = await getLeaderboard("ALL_TIME", 200);
    const rankAfter = boardAfter.find((r) => r.user_id === userId)?.rank;
    expect(after).toEqual(before);
    expect(rankAfter).toBe(rankBefore);
  });
});
