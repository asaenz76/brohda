/**
 * Moneyline tie -> VOID, end to end through the REAL jobs. A Moneyline's two choices are the two teams, so a tied game means neither
 * won: the Market resolves VOID through the same canonical VOID path as a cancelled game or a Spread/Total push. Only the equality
 * case changed; this proves the whole chain — Picks, accuracy, Call BS and its record, money holds, fee, and notifications — and that a
 * normal result in the same run is graded exactly as before. Real local Supabase; no real money.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteMonetaryRowsForMarkets } from "./helpers/cleanup-monetary";
import { getTestAdminClient } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { proposeMoney, acceptMonetaryProposal } from "@/lib/monetary/repository";
import { callBS, acceptCallBS } from "@/lib/challenges/repository";
import { getWalletBalanceSummary, getReservationById } from "@/lib/wallet/reservations";
import { checkMonetaryConsistency } from "@/lib/monetary/reconciliation";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { runSettlementJob } from "@/lib/monetary/settlement-runner";

const admin = getTestAdminClient();
const PROVIDER = "api_nfl";

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];

async function createFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `policy-fixture-${randomUUID()}`,
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

async function createMarket(fixtureId: string): Promise<string> {
  const market: NormalizedMarket = {
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
  const { id } = await upsertMarket(market);
  createdMarketIds.push(id);
  return id;
}

async function createUser(label: string, role: "player" | "super_admin" = "player") {
  const email = `${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role, is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function pick(userId: string, marketId: string, selectedOutcome: "YES" | "NO") {
  const { prediction, outcome } = await setPick({
    userId,
    marketId,
    selectedOutcome,
    yesProbability: 0.6,
    noProbability: 0.4,
    marketQuestionSnapshot: "q",
    marketCloseAtSnapshot: null,
    marketStatusSnapshot: "ACTIVE",
    idempotencyKey: randomUUID(),
  });
  if (!prediction) throw new Error(`pick failed: ${outcome}`);
  return prediction.id;
}

async function deposit(userId: string, amount: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user", p_user_id: userId, p_type: "manual_deposit", p_direction: "credit",
    p_amount: amount, p_admin_id: null, p_reason: "test funding", p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

async function setPolicy(overrides: Record<string, unknown>) {
  const { error } = await admin.from("platform_settings").update(overrides).eq("id", true);
  if (error) throw error;
}

const BASE_POLICY = {
  monetary_p2p_enabled: true, call_bs_enabled: true, p2p_fee_bps: 0, pick_lock_minutes_before_kickoff: 10,
  monetary_proposal_rate_limit_window_seconds: 60, monetary_proposal_rate_limit_max_attempts: 100,
  monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000,
};


async function predictionRecord(userId: string) {
  const { data, error } = await admin.rpc("get_user_prediction_record", { p_user_id: userId }).single();
  if (error) throw error;
  return data as { correct: number; incorrect: number; void: number; decided: number; accuracy: number | null };
}
async function callBsRecord(userId: string) {
  const { data, error } = await admin.rpc("get_call_bs_record", { p_user_id: userId }).single();
  if (error) throw error;
  return data as { wins: number; losses: number; void: number };
}
/**
 * This test asserts on the grading notifications, which are governed by configurable policy rows in platform_settings that other files
 * toggle (and which CI's file order can leave in any state). Pin exactly what the assertions depend on — never inherit it.
 */
async function pinPredictionNotificationPolicy() {
  const { error } = await admin
    .from("platform_settings")
    .update({
      prediction_notifications_enabled: true,
      prediction_notify_on_correct: true,
      prediction_notify_on_incorrect: true,
      prediction_notify_on_void: true,
      prediction_notify_title_correct: "You were right",
      prediction_notify_body_correct: 'Your prediction on "{{question}}" was correct.',
      prediction_notify_title_incorrect: "Result is in",
      prediction_notify_body_incorrect: 'Your prediction on "{{question}}" was incorrect.',
      prediction_notify_title_void: "No result this time",
      prediction_notify_body_void: "\"{{question}}\" didn't reach a final result, so this prediction won't count.",
    })
    .eq("id", true);
  if (error) throw error;
}

async function complete(fixtureId: string, homeScore: number, awayScore: number) {
  const { error } = await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  if (error) throw error;
}

/** One Game with a YES (home) user and a NO (away) user holding both an accepted Call BS and a committed money Position. */
async function setupPair(label: string, fee = 1000) {
  const fixtureId = await createFixture();
  const marketId = await createMarket(fixtureId);
  const yes = await createUser(`${label}yes`);
  const no = await createUser(`${label}no`);
  const yesPick = await pick(yes, marketId, "YES");
  const noPick = await pick(no, marketId, "NO");
  await deposit(yes, 5000);
  await deposit(no, 5000);
  const call = await callBS(yes, noPick);
  if (!call.ok) throw new Error(`call bs: ${call.error}`);
  expect((await acceptCallBS(call.challenge.id, no)).outcome).toBe("accepted");
  const proposed = await proposeMoney(yes, noPick, fee, randomUUID());
  if (!proposed.ok) throw new Error(`propose: ${proposed.error}`);
  const accepted = await acceptMonetaryProposal(proposed.proposal.id, no);
  if (accepted.outcome !== "accepted" || !accepted.position) throw new Error(`accept: ${accepted.outcome}`);
  return { fixtureId, marketId, yes, no, yesPick, noPick, challengeId: call.challenge.id, position: accepted.position, proposal: proposed.proposal };
}

describe("a tied Moneyline resolves VOID, everywhere, and a normal result is untouched", () => {
  it("Picks, accuracy, Call BS, its record, money, fee and notifications — through the real jobs", async () => {
    await setPolicy({ ...BASE_POLICY, p2p_fee_bps: 500 }); // a real fee, to prove none is taken on VOID
    await pinPredictionNotificationPolicy();
    const tie = await setupPair("tie");
    const win = await setupPair("win");
    // The jobs below are global (they process every pending row in the database), so failures and anomalies caused by OTHER tests' data are
    // not this test's business: assert only on the rows this test created.
    const mine = {
      predictions: [tie.yesPick, tie.noPick, win.yesPick, win.noPick],
      challenges: [tie.challengeId, win.challengeId],
      positions: [tie.position.id, win.position.id],
      proposals: [tie.proposal.id, win.proposal.id],
    };
    const tieBefore = { yes: await getWalletBalanceSummary(tie.yes), no: await getWalletBalanceSummary(tie.no) };
    expect(tieBefore.yes.reserved).toBe(1000);
    expect(tieBefore.no.reserved).toBe(1000);

    await complete(tie.fixtureId, 14, 14); // tied
    await complete(win.fixtureId, 24, 10); // home (YES) wins outright

    // --- Picks (the real grading job)
    const grading = await runGradingJob(recordGradedPredictionResult);
    expect(grading.failures.filter((f) => mine.predictions.includes(f.predictionId))).toEqual([]);
    const { data: picks } = await admin.from("predictions").select("id, user_id, lifecycle_state, result, resolved_outcome_snapshot").in("market_id", [tie.marketId, win.marketId]);
    const byUser = (id: string) => picks!.find((p) => p.user_id === id)!;
    for (const id of [tie.yes, tie.no]) expect(byUser(id)).toMatchObject({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null });
    // Normal grading in the same run is exactly as before: YES wins -> YES is CORRECT, NO is INCORRECT.
    expect(byUser(win.yes)).toMatchObject({ result: "CORRECT", resolved_outcome_snapshot: "YES" });
    expect(byUser(win.no)).toMatchObject({ result: "INCORRECT", resolved_outcome_snapshot: "YES" });

    // --- Prediction record: a VOID Pick is counted as predicted-but-undecided; it is never correct, never incorrect, and never in the accuracy.
    for (const id of [tie.yes, tie.no]) {
      expect(await predictionRecord(id)).toMatchObject({ correct: 0, incorrect: 0, void: 1, decided: 0, accuracy: null });
    }
    expect(await predictionRecord(win.yes)).toMatchObject({ correct: 1, incorrect: 0, void: 0, decided: 1 });

    // --- Call BS (the real resolver)
    const resolution = await resolveAcceptedChallenges();
    expect(resolution.failures.filter((f) => mine.challenges.includes(f.challengeId))).toEqual([]);
    const { data: challenges } = await admin.from("challenges").select("id, status, result").in("id", [tie.challengeId, win.challengeId]);
    expect(challenges!.find((c) => c.id === tie.challengeId)).toMatchObject({ status: "RESOLVED", result: "VOID" });
    expect(challenges!.find((c) => c.id === win.challengeId)).toMatchObject({ status: "RESOLVED", result: "CHALLENGER_WON" });
    // Neither a win nor a loss for either side: the record is untouched by the tie.
    for (const id of [tie.yes, tie.no]) expect(await callBsRecord(id)).toMatchObject({ wins: 0, losses: 0 });
    expect(await callBsRecord(win.yes)).toMatchObject({ wins: 1, losses: 0 });
    expect(await callBsRecord(win.no)).toMatchObject({ wins: 0, losses: 1 });

    // --- Money (the real settlement job)
    const settlement = await runSettlementJob();
    expect(settlement.failures.filter((f) => (f.positionId && mine.positions.includes(f.positionId)) || (f.proposalId && mine.proposals.includes(f.proposalId)))).toEqual([]);
    const { data: tiedPosition } = await admin.from("monetary_positions").select("settlement_status, settlement_id").eq("id", tie.position.id).single();
    expect(tiedPosition?.settlement_status).toBe("VOIDED");
    const { data: voidSettlement } = await admin.from("monetary_position_settlements").select("outcome, winner_user_id, loser_user_id, fee_amount, winner_credit_amount, proposer_reservation_outcome, recipient_reservation_outcome").eq("id", tiedPosition!.settlement_id).single();
    expect(voidSettlement).toMatchObject({ outcome: "VOID", winner_user_id: null, loser_user_id: null, fee_amount: 0, winner_credit_amount: 0, proposer_reservation_outcome: "RELEASED", recipient_reservation_outcome: "RELEASED" });
    // Both holds are released and nothing moved: the same balances, nothing on hold, no win/loss ledger entry, no fee.
    expect((await getReservationById(tie.position.proposerReservationId))?.status).toBe("RELEASED");
    expect((await getReservationById(tie.position.recipientReservationId))?.status).toBe("RELEASED");
    expect(await getWalletBalanceSummary(tie.yes)).toEqual({ ...tieBefore.yes, reserved: 0, available: tieBefore.yes.total });
    expect(await getWalletBalanceSummary(tie.no)).toEqual({ ...tieBefore.no, reserved: 0, available: tieBefore.no.total });
    const { data: ledger } = await admin.from("wallet_transactions").select("type").in("user_id", [tie.yes, tie.no]);
    expect((ledger ?? []).map((t) => t.type).filter((t) => t === "p2p_position_win" || t === "p2p_position_loss" || t === "house_fee_credit")).toEqual([]);
    // The normal result in the same run still settles with the snapshotted fee: 5% of the losing 1000.
    const { data: wonPosition } = await admin.from("monetary_positions").select("settlement_status, settlement_id").eq("id", win.position.id).single();
    expect(wonPosition?.settlement_status).toBe("SETTLED");
    const { data: wonSettlement } = await admin.from("monetary_position_settlements").select("outcome, fee_amount").eq("id", wonPosition!.settlement_id).single();
    expect(wonSettlement).toMatchObject({ outcome: "PROPOSER_WINS", fee_amount: 50 });

    // --- Notifications
    const { data: notes } = await admin.from("notifications").select("user_id, type, title, body").in("user_id", [tie.yes, tie.no]);
    for (const id of [tie.yes, tie.no]) {
      const mine = (notes ?? []).filter((n) => n.user_id === id);
      expect(mine.find((n) => n.type === "prediction_graded")?.title).toBe("No result this time");
      expect(mine.find((n) => n.type === "CALL_BS_RESOLVED")).toMatchObject({ title: "Call BS void" });
      expect(mine.find((n) => n.type === "MONETARY_POSITION_VOIDED")).toMatchObject({ title: "Position voided" });
      // The wording names the Game and Market, not a winner.
      expect(mine.find((n) => n.type === "MONETARY_POSITION_VOIDED")!.body).toMatch(/ · Moneyline" was voided\. Your \$10\.00 hold was released\./);
    }

    const anomalies = (await checkMonetaryConsistency()).anomalies as Array<{ positionId?: string; proposalId?: string }>;
    expect(anomalies.filter((a) => (a.positionId && mine.positions.includes(a.positionId)) || (a.proposalId && mine.proposals.includes(a.proposalId)))).toEqual([]);
  });
});

beforeEach(async () => {
  await setPolicy(BASE_POLICY);
});

afterEach(async () => {
  if (createdMarketIds.length > 0) {
    await deleteMonetaryRowsForMarkets(createdMarketIds);
    const { data: positionRows } = await admin.from("monetary_positions").select("id").in("market_id", createdMarketIds);
    const positionIds = (positionRows ?? []).map((r) => r.id);
    const { data: proposalRows } = await admin.from("monetary_proposals").select("id").in("market_id", createdMarketIds);
    const proposalIds = (proposalRows ?? []).map((r) => r.id);
    if (proposalIds.length > 0) await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
    const { data: challengeRows } = await admin.from("challenges").select("id").in("market_id", createdMarketIds);
    const challengeIds = (challengeRows ?? []).map((r) => r.id);
    if (challengeIds.length > 0) {
      await admin.from("notifications").delete().in("challenge_id", challengeIds);
      await admin.from("challenges").delete().in("id", challengeIds);
    }
    if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
    if (proposalIds.length > 0) await admin.from("monetary_proposals").delete().in("id", proposalIds);
    if (positionIds.length > 0) await admin.from("monetary_position_settlements").delete().in("position_id", positionIds);
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
    for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
    createdUserIds.length = 0;
  }
  await setPolicy(BASE_POLICY);
});

