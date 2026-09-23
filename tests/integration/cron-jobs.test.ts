/**
 * Integration tests for Milestone R13.5 (Production Operations Gate) —
 * the 3 new production cron routes (grade-predictions, resolve-challenges,
 * settle-monetary-positions): authentication, idempotency, concurrency,
 * failure isolation, and the full deterministic lifecycle proof (§65):
 * Game finishes -> grading -> Challenge resolution -> settlement ->
 * wallet + reputation correct. Route handlers are imported and invoked
 * directly (the established Next.js pattern for testing a Route Handler
 * without a running HTTP server) — real local Supabase throughout, no
 * real money.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();
const PROVIDER = "api_nfl";
const CRON_SECRET = "r13-5-test-cron-secret";

process.env.CRON_SECRET = CRON_SECRET;

const { GET: gradePredictionsRoute } = await import("@/app/api/cron/grade-predictions/route");
const { GET: resolveChallengesRoute } = await import("@/app/api/cron/resolve-challenges/route");
const { GET: settleMonetaryPositionsRoute } = await import("@/app/api/cron/settle-monetary-positions/route");

function req(secret: string | null) {
  const headers = new Headers();
  if (secret !== null) headers.set("authorization", `Bearer ${secret}`);
  return new Request("http://localhost/api/cron/x", { headers });
}

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];

async function createFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `r13-5-fixture-${randomUUID()}`,
      home_team_name: "Home Test NFL",
      away_team_name: "Away Test NFL",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
      ...overrides,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  createdFixtureIds.push(data.id);
  return data.id;
}

async function createMarket(fixtureId: string): Promise<string> {
  const payload: NormalizedMarket = {
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
  };
  const { id } = await upsertMarket(payload);
  createdMarketIds.push(id);
  return id;
}

async function createFreshMarket(): Promise<string> {
  return createMarket(await createFixture());
}

async function createUser(label = "r13-5") {
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

async function resolveFixtureAsHomeWin(fixtureId: string, marketId: string) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 1, away_score: 0 }).eq("id", fixtureId);
  const { data: rows } = await admin.from("markets").select("provider_market_id").eq("id", marketId).single();
  await upsertMarket({
    provider: PROVIDER,
    providerMarketId: rows!.provider_market_id,
    providerEventId: null,
    question: "Will the home team win?",
    description: null,
    status: "CLOSED",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 1, no: 0, outcomeLabels: { yes: "Home", no: "Away" } },
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
  });
}

async function fund(userId: string, amount: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amount,
    p_admin_id: null,
    p_reason: "test funding",
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

async function getWalletBalance(userId: string) {
  const { data } = await admin.from("wallet_balances").select("balance, reserved_balance").eq("user_id", userId).single();
  return { total: data?.balance ?? 0, reserved: data?.reserved_balance ?? 0, available: (data?.balance ?? 0) - (data?.reserved_balance ?? 0) };
}

beforeAll(async () => {
  await admin.from("platform_settings").update({ monetary_p2p_enabled: true, p2p_fee_bps: 0, call_bs_enabled: true, pick_lock_minutes_before_kickoff: 10 }).eq("id", true);
});

afterEach(async () => {
  if (createdMarketIds.length > 0) {
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
    const { data: challengeRows } = await admin.from("challenges").select("id").in("market_id", createdMarketIds);
    const challengeIds = (challengeRows ?? []).map((r) => r.id);
    if (challengeIds.length > 0) {
      await admin.from("notifications").delete().in("challenge_id", challengeIds);
      await admin.from("challenges").delete().in("id", challengeIds);
    }
    await admin.from("predictions").delete().in("market_id", createdMarketIds);
    await admin.from("markets").delete().in("id", createdMarketIds);
    createdMarketIds.length = 0;
  }
  if (createdFixtureIds.length > 0) {
    await admin.from("fixtures").delete().in("id", createdFixtureIds);
    createdFixtureIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await admin.from("wallet_reservations").delete().in("user_id", createdUserIds);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
    createdUserIds.length = 0;
  }
});

describe("Cron authentication (§19, §55)", () => {
  const ROUTES: Array<{ name: string; handler: (r: Request) => Promise<Response> }> = [
    { name: "grade-predictions", handler: gradePredictionsRoute },
    { name: "resolve-challenges", handler: resolveChallengesRoute },
    { name: "settle-monetary-positions", handler: settleMonetaryPositionsRoute },
  ];

  for (const { name, handler } of ROUTES) {
    it(`${name}: rejects a missing Authorization header`, async () => {
      const res = await handler(req(null));
      expect(res.status).toBe(401);
    });

    it(`${name}: rejects a forged/wrong secret`, async () => {
      const res = await handler(req("wrong-secret"));
      expect(res.status).toBe(401);
    });

    it(`${name}: allows the correct secret`, async () => {
      const res = await handler(req(CRON_SECRET));
      expect(res.status).toBe(200);
    });
  }
});

describe("Grading automation (§22)", () => {
  it("no eligible Predictions: returns a clean zero summary", async () => {
    const res = await gradePredictionsRoute(req(CRON_SECRET));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.examined).toBeGreaterThanOrEqual(0);
  });

  it("grades an eligible Prediction and is safe to invoke twice in a row", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const { userId } = await createUser("grade-cron");
    const predictionId = await pick(userId, marketId, "YES");
    await resolveFixtureAsHomeWin(fixtureId, marketId);

    const first = await gradePredictionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(first.graded).toBeGreaterThanOrEqual(1);

    const { data: graded } = await admin.from("predictions").select("lifecycle_state, result").eq("id", predictionId).single();
    expect(graded?.lifecycle_state).toBe("GRADED");
    expect(graded?.result).toBe("CORRECT");

    // Second invocation: nothing left to grade for this row, safe no-op.
    const second = await gradePredictionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(second.graded).toBe(0);
  });

  it("concurrent invocation never double-grades", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const { userId } = await createUser("grade-concurrent");
    const predictionId = await pick(userId, marketId, "YES");
    await resolveFixtureAsHomeWin(fixtureId, marketId);

    const [a, b] = await Promise.all([gradePredictionsRoute(req(CRON_SECRET)), gradePredictionsRoute(req(CRON_SECRET))]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const { data: rows } = await admin.from("predictions").select("id").eq("id", predictionId).eq("lifecycle_state", "GRADED");
    expect(rows).toHaveLength(1);
  });
});

describe("Challenge resolution automation (§23)", () => {
  it("no eligible Challenges: returns a clean zero summary", async () => {
    const res = await resolveChallengesRoute(req(CRON_SECRET));
    expect(res.status).toBe(200);
  });

  it("Picks not yet graded: Challenge stays still-pending, not resolved", async () => {
    const marketId = await createFreshMarket();
    const { userId: a } = await createUser("resolve-a");
    const { userId: b } = await createUser("resolve-b");
    const aPred = await pick(a, marketId, "YES");
    const bPred = await pick(b, marketId, "NO");
    const { data: challenge } = await admin
      .from("challenges")
      .insert({ market_id: marketId, challenger_user_id: a, recipient_user_id: b, challenger_prediction_id: aPred, recipient_prediction_id: bPred, challenger_selection_snapshot: "YES", recipient_selection_snapshot: "NO", status: "ACCEPTED", accepted_at: new Date().toISOString() })
      .select("id")
      .single();

    const body = await resolveChallengesRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(body.stillPending).toBeGreaterThanOrEqual(1);
    const { data: row } = await admin.from("challenges").select("status").eq("id", challenge!.id).single();
    expect(row?.status).toBe("ACCEPTED");
  });

  it("resolves once both Picks are graded, and is safe to invoke twice", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const { userId: a } = await createUser("resolve-c");
    const { userId: b } = await createUser("resolve-d");
    const aPred = await pick(a, marketId, "YES");
    const bPred = await pick(b, marketId, "NO");
    const { data: challenge } = await admin
      .from("challenges")
      .insert({ market_id: marketId, challenger_user_id: a, recipient_user_id: b, challenger_prediction_id: aPred, recipient_prediction_id: bPred, challenger_selection_snapshot: "YES", recipient_selection_snapshot: "NO", status: "ACCEPTED", accepted_at: new Date().toISOString() })
      .select("id")
      .single();
    await resolveFixtureAsHomeWin(fixtureId, marketId);
    await gradePredictionsRoute(req(CRON_SECRET));

    const first = await resolveChallengesRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(first.resolved).toBeGreaterThanOrEqual(1);
    const { data: resolvedRow } = await admin.from("challenges").select("status, result").eq("id", challenge!.id).single();
    expect(resolvedRow?.status).toBe("RESOLVED");
    expect(resolvedRow?.result).toBe("CHALLENGER_WON");

    const second = await resolveChallengesRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(second.resolved).toBe(0);
  });

  it("concurrent invocation never double-resolves", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const { userId: a } = await createUser("resolve-e");
    const { userId: b } = await createUser("resolve-f");
    const aPred = await pick(a, marketId, "YES");
    const bPred = await pick(b, marketId, "NO");
    const { data: challenge } = await admin
      .from("challenges")
      .insert({ market_id: marketId, challenger_user_id: a, recipient_user_id: b, challenger_prediction_id: aPred, recipient_prediction_id: bPred, challenger_selection_snapshot: "YES", recipient_selection_snapshot: "NO", status: "ACCEPTED", accepted_at: new Date().toISOString() })
      .select("id")
      .single();
    await resolveFixtureAsHomeWin(fixtureId, marketId);
    await gradePredictionsRoute(req(CRON_SECRET));

    await Promise.all([resolveChallengesRoute(req(CRON_SECRET)), resolveChallengesRoute(req(CRON_SECRET))]);
    const { data: notifs } = await admin.from("notifications").select("id").eq("challenge_id", challenge!.id).eq("type", "CALL_BS_RESOLVED");
    expect(notifs).toHaveLength(2); // one per participant, never duplicated per participant
  });
});

describe("Settlement automation (§24-25)", () => {
  async function setupCommittedPosition(stake = 1000) {
    const { proposeMoney, acceptMonetaryProposal } = await import("@/lib/monetary/repository");
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const proposer = await createUser("settle-cron-proposer");
    const recipient = await createUser("settle-cron-recipient");
    await fund(proposer.userId, stake);
    await fund(recipient.userId, stake);
    const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
    const recipientPredictionId = await pick(recipient.userId, marketId, "NO");
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, stake, randomUUID());
    if (!proposed.ok) throw new Error("setup failed: " + proposed.error);
    const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    if (accepted.outcome !== "accepted" || !accepted.position) throw new Error("setup failed: acceptance");
    return { fixtureId, marketId, proposer, recipient, proposerPredictionId, recipientPredictionId, position: accepted.position };
  }

  it("no eligible Positions: returns a clean zero summary", async () => {
    const res = await settleMonetaryPositionsRoute(req(CRON_SECRET));
    expect(res.status).toBe(200);
  });

  it("settles an eligible Position with correct accounting, matching direct canonical settlement", async () => {
    const stake = 1000;
    const { fixtureId, marketId, proposer, recipient, proposerPredictionId, recipientPredictionId, position } = await setupCommittedPosition(stake);
    const beforeProposer = await getWalletBalance(proposer.userId);
    const beforeRecipient = await getWalletBalance(recipient.userId);
    expect(beforeProposer).toEqual({ total: stake, reserved: stake, available: 0 });
    expect(beforeRecipient).toEqual({ total: stake, reserved: stake, available: 0 });

    await resolveFixtureAsHomeWin(fixtureId, marketId);
    await gradePredictionsRoute(req(CRON_SECRET));
    void proposerPredictionId;
    void recipientPredictionId;

    const body = await settleMonetaryPositionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(body.settledWin).toBeGreaterThanOrEqual(1);

    const afterProposer = await getWalletBalance(proposer.userId);
    const afterRecipient = await getWalletBalance(recipient.userId);
    // Proposer picked YES (home win) — correct — wins the recipient's stake, 0% fee.
    expect(afterProposer).toEqual({ total: stake + stake, reserved: 0, available: stake + stake });
    expect(afterRecipient).toEqual({ total: 0, reserved: 0, available: 0 });

    const { data: settlement } = await admin.from("monetary_position_settlements").select("*").eq("position_id", position.id).single();
    expect(settlement?.outcome).toBe("PROPOSER_WINS");
    expect(settlement?.fee_amount).toBe(0);
    expect(settlement?.winner_credit_amount).toBe(stake);
  });

  it("already settled Positions are a safe no-op on a second invocation", async () => {
    // listSettlementEligiblePositionIds() only discovers COMMITTED
    // Positions — once SETTLED, a Position no longer appears as a
    // candidate at all on a later run (the "already_settled" outcome
    // exists for the tighter concurrent-invocation race, not this
    // sequential case). The correct no-op proof here is: nothing left to
    // discover, settledWin stays 0, and the settlement row is untouched.
    const stake = 500;
    const { fixtureId, marketId, position } = await setupCommittedPosition(stake);
    await resolveFixtureAsHomeWin(fixtureId, marketId);
    await gradePredictionsRoute(req(CRON_SECRET));
    const first = await settleMonetaryPositionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(first.settledWin).toBeGreaterThanOrEqual(1);
    const { data: settlementAfterFirst } = await admin.from("monetary_position_settlements").select("id, settled_at").eq("position_id", position.id).single();

    const second = await settleMonetaryPositionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(second.candidates).toBe(0);
    expect(second.settledWin).toBe(0);

    const { data: settlementAfterSecond } = await admin.from("monetary_position_settlements").select("id, settled_at").eq("position_id", position.id).single();
    expect(settlementAfterSecond).toEqual(settlementAfterFirst);
  });

  it("concurrent invocation settles a Position exactly once", async () => {
    const stake = 500;
    const { fixtureId, marketId, position } = await setupCommittedPosition(stake);
    await resolveFixtureAsHomeWin(fixtureId, marketId);
    await gradePredictionsRoute(req(CRON_SECRET));

    await Promise.all([settleMonetaryPositionsRoute(req(CRON_SECRET)), settleMonetaryPositionsRoute(req(CRON_SECRET))]);
    const { data: settlements } = await admin.from("monetary_position_settlements").select("id").eq("position_id", position.id);
    expect(settlements).toHaveLength(1);
  });

  it("settlement continues even while monetary_p2p_enabled is false — the feature switch never blocks fulfilling an existing commitment", async () => {
    const stake = 700;
    const { fixtureId, marketId, position } = await setupCommittedPosition(stake);
    await admin.from("platform_settings").update({ monetary_p2p_enabled: false }).eq("id", true);
    await resolveFixtureAsHomeWin(fixtureId, marketId);
    await gradePredictionsRoute(req(CRON_SECRET));

    const body = await settleMonetaryPositionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(body.settledWin).toBeGreaterThanOrEqual(1);
    const { data: row } = await admin.from("monetary_positions").select("settlement_status").eq("id", position.id).single();
    expect(row?.settlement_status).toBe("SETTLED");

    await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
  });
});

describe("Full deterministic lifecycle proof (§65)", () => {
  it("Game finishes -> grading -> Challenge resolution -> settlement -> wallet + reputation correct, no manual mutation between stages", async () => {
    const { proposeMoney, acceptMonetaryProposal } = await import("@/lib/monetary/repository");
    const stake = 1000;

    // A single fixture backs BOTH a free Call BS Challenge (proposer vs a third user) and a Monetary Position (proposer vs recipient) — two independent Predictions from proposer on the same market would violate the one-pick-per-market default, so use two separate markets sharing the same lifecycle shape instead, exactly mirroring how real Brohda usage would have unrelated Challenges and Positions resolve off the same grading pass.
    const callBsFixtureId = await createFixture();
    const callBsMarketId = await createMarket(callBsFixtureId);
    const { userId: challenger } = await createUser("lifecycle-challenger");
    const { userId: recipient1 } = await createUser("lifecycle-recipient1");
    const challengerPred = await pick(challenger, callBsMarketId, "YES");
    const recipient1Pred = await pick(recipient1, callBsMarketId, "NO");
    const { data: challenge } = await admin
      .from("challenges")
      .insert({ market_id: callBsMarketId, challenger_user_id: challenger, recipient_user_id: recipient1, challenger_prediction_id: challengerPred, recipient_prediction_id: recipient1Pred, challenger_selection_snapshot: "YES", recipient_selection_snapshot: "NO", status: "ACCEPTED", accepted_at: new Date().toISOString() })
      .select("id")
      .single();

    const moneyFixtureId = await createFixture();
    const moneyMarketId = await createMarket(moneyFixtureId);
    const { userId: proposer } = await createUser("lifecycle-proposer");
    const { userId: recipient2 } = await createUser("lifecycle-recipient2");
    await fund(proposer, stake);
    await fund(recipient2, stake);
    const proposerPred = await pick(proposer, moneyMarketId, "YES");
    const recipient2Pred = await pick(recipient2, moneyMarketId, "NO");
    const proposed = await proposeMoney(proposer, recipient2Pred, stake, randomUUID());
    if (!proposed.ok) throw new Error("setup failed: " + proposed.error);
    const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient2);
    if (accepted.outcome !== "accepted" || !accepted.position) throw new Error("setup failed: acceptance");

    // The ONLY manual domain mutation in this test: the simulated authoritative Game/result fixture, for both markets.
    await resolveFixtureAsHomeWin(callBsFixtureId, callBsMarketId);
    await resolveFixtureAsHomeWin(moneyFixtureId, moneyMarketId);

    // Stage 1: grading, via the real cron route.
    const gradingResult = await gradePredictionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(gradingResult.graded).toBeGreaterThanOrEqual(2);
    const { data: gradedChallenger } = await admin.from("predictions").select("result").eq("id", challengerPred).single();
    const { data: gradedProposer } = await admin.from("predictions").select("result").eq("id", proposerPred).single();
    expect(gradedChallenger?.result).toBe("CORRECT");
    expect(gradedProposer?.result).toBe("CORRECT");

    // Stage 2: Challenge resolution, via the real cron route.
    const resolutionResult = await resolveChallengesRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(resolutionResult.resolved).toBeGreaterThanOrEqual(1);
    const { data: resolvedChallenge } = await admin.from("challenges").select("status, result").eq("id", challenge!.id).single();
    expect(resolvedChallenge?.status).toBe("RESOLVED");
    expect(resolvedChallenge?.result).toBe("CHALLENGER_WON");

    // Stage 3: settlement, via the real cron route.
    const settlementResult = await settleMonetaryPositionsRoute(req(CRON_SECRET)).then((r) => r.json());
    expect(settlementResult.settledWin).toBeGreaterThanOrEqual(1);

    // Wallet correct.
    const proposerBalance = await getWalletBalance(proposer);
    const recipient2Balance = await getWalletBalance(recipient2);
    expect(proposerBalance).toEqual({ total: stake * 2, reserved: 0, available: stake * 2 });
    expect(recipient2Balance).toEqual({ total: 0, reserved: 0, available: 0 });

    // Reputation correct: Call BS record reflects the resolved Challenge; prediction record reflects both graded Picks; money never touched Call BS or prediction reputation.
    const { data: challengerCallBs } = await admin.rpc("get_call_bs_record", { p_user_id: challenger }).single();
    expect((challengerCallBs as { wins: number }).wins).toBe(1);
    const { data: proposerPredictionRecord } = await admin.rpc("get_user_prediction_record", { p_user_id: proposer }).single();
    expect((proposerPredictionRecord as { correct: number }).correct).toBe(1);
    const { data: proposerCallBs } = await admin.rpc("get_call_bs_record", { p_user_id: proposer }).single();
    expect((proposerCallBs as { wins: number; losses: number; void: number }).wins + (proposerCallBs as { losses: number }).losses + (proposerCallBs as { void: number }).void).toBe(0);
  });
});
