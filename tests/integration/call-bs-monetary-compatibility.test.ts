/**
 * Integration tests for the Call BS / monetary P2P lock-compatibility rule
 * (final hardening, migration 175): money and Call BS are separate layers.
 * A Pick locked solely because money was committed to it
 * (lock_reason = 'MONETARY_POSITION_ACCEPTED') must stay eligible for one
 * free accepted Call BS on the same Market, and a Pick locked by an
 * accepted Call BS must stay eligible for monetary participation. Neither
 * ordering may weaken Pick immutability, the one-ACCEPTED-Call-BS-per-user-
 * per-Market exclusivity, or the cutoff. Real local Supabase throughout; no
 * real money — local-only wallet fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { callBS, acceptCallBS, getChallengeById } from "@/lib/challenges/repository";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { getMarketParticipants } from "@/lib/challenges/discovery";
import { proposeMoney, acceptMonetaryProposal, settleMonetaryPosition, getMonetaryPositionById } from "@/lib/monetary/repository";
import { getWalletBalanceSummary, getReservationById } from "@/lib/wallet/reservations";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();
const PROVIDER = "api_nfl";
const STAKE = 1000;

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];

async function createFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `compat-fixture-${randomUUID()}`,
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

function marketPayload(fixtureId: string): NormalizedMarket {
  return {
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
}

async function createMarket(fixtureId: string): Promise<string> {
  const { id } = await upsertMarket(marketPayload(fixtureId));
  createdMarketIds.push(id);
  return id;
}

async function createUser(label: string) {
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

async function setPolicy(overrides: Record<string, unknown>) {
  await admin.from("platform_settings").update(overrides).eq("id", true);
}

async function deposit(userId: string, amount: number) {
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

/** MONEYLINE grading mirror (same shape as p2p-settlement.test.ts) — one deterministic Market result both systems read. */
async function gradeMoneyline(fixtureId: string, marketId: string, homeScore: number, awayScore: number) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  const outcome: "YES" | "NO" = homeScore > awayScore ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    await admin
      .from("predictions")
      .update({
        lifecycle_state: "GRADED",
        result: p.selected_outcome === outcome ? "CORRECT" : "INCORRECT",
        resolved_outcome_snapshot: outcome,
        graded_at: new Date().toISOString(),
      })
      .eq("id", p.id);
  }
  return outcome;
}

async function lockOf(predictionId: string) {
  const { data } = await admin.from("predictions").select("locked_at, lock_reason, selected_outcome").eq("id", predictionId).single();
  return data!;
}

/** Two opposing, funded users on one Market. `a` picks YES, `b` picks NO. */
async function setupFundedPair() {
  const fixtureId = await createFixture();
  const marketId = await createMarket(fixtureId);
  const a = await createUser("a");
  const b = await createUser("b");
  const aPick = await pick(a.userId, marketId, "YES");
  const bPick = await pick(b.userId, marketId, "NO");
  await deposit(a.userId, STAKE);
  await deposit(b.userId, STAKE);
  return { fixtureId, marketId, a, b, aPick, bPick };
}

async function commitMoney(proposer: { userId: string }, recipient: { userId: string }, recipientPickId: string) {
  const proposed = await proposeMoney(proposer.userId, recipientPickId, STAKE, randomUUID());
  if (!proposed.ok) throw new Error(`propose failed: ${proposed.error}`);
  const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
  if (accepted.outcome !== "accepted" || !accepted.position) throw new Error(`money accept failed: ${accepted.outcome}`);
  return accepted.position;
}

async function sendAndAcceptCallBs(challenger: { userId: string }, recipient: { userId: string }, recipientPickId: string) {
  const created = await callBS(challenger.userId, recipientPickId);
  if (!created.ok) throw new Error(`callBS failed: ${created.error}`);
  const result = await acceptCallBS(created.challenge.id, recipient.userId);
  return { challengeId: created.challenge.id, result };
}

beforeEach(async () => {
  await setPolicy({ monetary_p2p_enabled: true, call_bs_enabled: true, p2p_fee_bps: 0, pick_lock_minutes_before_kickoff: 10 });
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
    for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
    createdUserIds.length = 0;
  }
  await setPolicy({ monetary_p2p_enabled: true, call_bs_enabled: true, p2p_fee_bps: 0, pick_lock_minutes_before_kickoff: 10 });
});

describe("Money first → free Call BS still allowed", () => {
  it("a monetary-locked Pick accepts a free Call BS; the lock, the selection and the Position are all untouched", async () => {
    const { a, b, aPick, bPick } = await setupFundedPair();
    const position = await commitMoney(a, b, bPick);

    const aBefore = await lockOf(aPick);
    const bBefore = await lockOf(bPick);
    expect(aBefore.lock_reason).toBe("MONETARY_POSITION_ACCEPTED");
    expect(bBefore.lock_reason).toBe("MONETARY_POSITION_ACCEPTED");

    const { challengeId, result } = await sendAndAcceptCallBs(a, b, bPick);
    expect(result.outcome).toBe("accepted");
    expect(result.challenge.status).toBe("ACCEPTED");
    expect((await getChallengeById(challengeId))?.status).toBe("ACCEPTED");

    // The existing lock is preserved verbatim — not overwritten by CHALLENGE_ACCEPTED, not re-stamped.
    const aAfter = await lockOf(aPick);
    const bAfter = await lockOf(bPick);
    expect(aAfter).toEqual(aBefore);
    expect(bAfter).toEqual(bBefore);

    // Immutability is not weakened: the Pick still cannot be changed.
    const edit = await setPick({
      userId: a.userId,
      marketId: result.challenge.marketId,
      selectedOutcome: "NO",
      yesProbability: 0.6,
      noProbability: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: randomUUID(),
    });
    expect(edit.outcome).toBe("rejected_locked");
    expect((await lockOf(aPick)).selected_outcome).toBe("YES");

    // The Position and its holds are untouched: both stakes still on hold, nothing released.
    const reloaded = await getMonetaryPositionById(position.id);
    expect(reloaded?.settlementStatus).toBe("COMMITTED");
    expect((await getReservationById(position.proposerReservationId))?.status).toBe("ACTIVE");
    expect((await getReservationById(position.recipientReservationId))?.status).toBe("ACTIVE");
    expect(await getWalletBalanceSummary(a.userId)).toEqual({ total: STAKE, reserved: STAKE, available: 0 });
    expect(await getWalletBalanceSummary(b.userId)).toEqual({ total: STAKE, reserved: STAKE, available: 0 });
  });

  it("the recipient can be the one who sent the Call BS (either side of the Position)", async () => {
    const { a, b, aPick, bPick } = await setupFundedPair();
    await commitMoney(a, b, bPick);

    const { result } = await sendAndAcceptCallBs(b, a, aPick);
    expect(result.outcome).toBe("accepted");
  });

  it("a Position is not a Call BS pairing: the same user can still accept exactly one free Call BS, then exclusivity applies", async () => {
    const { marketId, a, b, bPick } = await setupFundedPair();
    await commitMoney(a, b, bPick); // a ↔ b money

    // c opposes a and is a different person than the money counterparty.
    const c = await createUser("c");
    await pick(c.userId, marketId, "NO");
    const aPickRow = (await admin.from("predictions").select("id").eq("market_id", marketId).eq("user_id", a.userId).single()).data!.id as string;

    // a's single free Call BS slot is still open despite the money Position → c→a accepts.
    const first = await sendAndAcceptCallBs(c, a, aPickRow);
    expect(first.result.outcome).toBe("accepted");

    // Now a holds a Call BS (with c) AND a money Position (with b). b→a Call BS must still hit exclusivity.
    const second = await sendAndAcceptCallBs(b, a, aPickRow);
    expect(second.result.outcome).toBe("rejected_already_paired");
    expect(second.result.challenge.status).toBe("EXPIRED");

    // Exactly one ACCEPTED Call BS involves a on this Market.
    const { data: accepted } = await admin
      .from("challenges")
      .select("id")
      .eq("market_id", marketId)
      .eq("status", "ACCEPTED")
      .or(`challenger_user_id.eq.${a.userId},recipient_user_id.eq.${a.userId}`);
    expect(accepted).toHaveLength(1);
  });

  it("two separate monetary-locked Picks never let one user hold two accepted free Call BS", async () => {
    const { marketId, a, b, aPick, bPick } = await setupFundedPair();
    await commitMoney(a, b, bPick);
    const c = await createUser("c");
    const cPick = await pick(c.userId, marketId, "NO");

    const first = await sendAndAcceptCallBs(a, b, bPick);
    expect(first.result.outcome).toBe("accepted");
    const second = await sendAndAcceptCallBs(a, c, cPick);
    expect(second.result.outcome).toBe("rejected_already_paired");
    expect(aPick).toBeTruthy();
  });
});

describe("Call BS eligibility ignores monetary locks", () => {
  it("a monetary-locked viewer and a monetary-locked target are both still offered Call BS", async () => {
    const { fixtureId, marketId, a, b, bPick } = await setupFundedPair();
    await commitMoney(a, b, bPick);
    const { data: fixture } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", fixtureId).single();

    // Both Picks are money-locked; neither the viewer's nor the target's lock suppresses canCallBs.
    const forA = await getMarketParticipants(marketId, a.userId, fixture!.scheduled_start_utc);
    expect(forA.find((p) => p.userId === b.userId)?.canCallBs).toBe(true);
    const forB = await getMarketParticipants(marketId, b.userId, fixture!.scheduled_start_utc);
    expect(forB.find((p) => p.userId === a.userId)?.canCallBs).toBe(true);
  });

  it("a Call BS-locked pair is still eligible to the monetary layer's own discovery (independently gated)", async () => {
    const { a, b, bPick } = await setupFundedPair();
    const { result } = await sendAndAcceptCallBs(a, b, bPick);
    expect(result.outcome).toBe("accepted");
    // Money proposal on a Call BS-locked Pick succeeds under the monetary rules.
    const proposed = await proposeMoney(a.userId, bPick, STAKE, randomUUID());
    expect(proposed.ok).toBe(true);
  });
});

describe("Money-first still rejects for every legitimate non-money reason", () => {
  it("rejects past the cutoff even though the Pick is money-locked", async () => {
    const { fixtureId, a, b, bPick } = await setupFundedPair();
    await commitMoney(a, b, bPick);
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    // Kickoff moves inside the cutoff window before the recipient accepts.
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 5 * 60 * 1000).toISOString() }).eq("id", fixtureId);

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("rejected_cutoff");
    expect(result.challenge.status).toBe("EXPIRED");
  });

  it("rejects when an account became inactive, even though the Pick is money-locked", async () => {
    const { a, b, bPick } = await setupFundedPair();
    await commitMoney(a, b, bPick);
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    await admin.from("user_profiles").update({ is_active: false }).eq("id", a.userId);

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("rejected_ineligible_account");
    expect(result.challenge.status).toBe("EXPIRED");
  });

  it("still rejects a Pick locked CHALLENGE_ACCEPTED (defense-in-depth for an already-paired Pick)", async () => {
    const { marketId, a, b, bPick } = await setupFundedPair();
    void marketId;
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    // Simulate the narrow window where a concurrent acceptance already locked the recipient's Pick.
    await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CHALLENGE_ACCEPTED" }).eq("id", bPick);

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("rejected_already_paired");
  });

  it("still rejects a Pick locked CUTOFF", async () => {
    const { a, b, bPick } = await setupFundedPair();
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CUTOFF" }).eq("id", bPick);

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("rejected_cutoff");
  });
});

describe("Free Call BS first → money still allowed", () => {
  it("a Call BS-locked Pick commits a valid monetary Position and keeps its CHALLENGE_ACCEPTED lock", async () => {
    const { a, b, aPick, bPick } = await setupFundedPair();
    const { result } = await sendAndAcceptCallBs(a, b, bPick);
    expect(result.outcome).toBe("accepted");

    const aBefore = await lockOf(aPick);
    const bBefore = await lockOf(bPick);
    expect(aBefore.lock_reason).toBe("CHALLENGE_ACCEPTED");

    const position = await commitMoney(a, b, bPick);

    expect(await lockOf(aPick)).toEqual(aBefore);
    expect(await lockOf(bPick)).toEqual(bBefore);
    expect((await getChallengeById(result.challenge.id))?.status).toBe("ACCEPTED");
    expect((await getMonetaryPositionById(position.id))?.settlementStatus).toBe("COMMITTED");
    expect(await getWalletBalanceSummary(a.userId)).toEqual({ total: STAKE, reserved: STAKE, available: 0 });
    expect(await getWalletBalanceSummary(b.userId)).toEqual({ total: STAKE, reserved: STAKE, available: 0 });
  });
});

describe("Both layers resolve independently from one Market result", () => {
  async function assertIndependentResolution(order: "money-first" | "call-bs-first") {
    const { fixtureId, marketId, a, b, aPick, bPick } = await setupFundedPair();
    let challengeId: string;
    let positionId: string;
    if (order === "money-first") {
      positionId = (await commitMoney(a, b, bPick)).id;
      challengeId = (await sendAndAcceptCallBs(a, b, bPick)).challengeId;
    } else {
      challengeId = (await sendAndAcceptCallBs(a, b, bPick)).challengeId;
      positionId = (await commitMoney(a, b, bPick)).id;
    }

    // One canonical Market result: home wins, so a (YES) is right and b (NO) is wrong.
    expect(await gradeMoneyline(fixtureId, marketId, 21, 10)).toBe("YES");
    expect(aPick).toBeTruthy();

    // Money settles first: the social Challenge must be untouched by it.
    const settled = await settleMonetaryPosition(positionId);
    expect(settled.outcome).toBe("settled_win");
    expect(settled.settlement?.winnerUserId).toBe(a.userId);
    expect(settled.settlement?.marketResult).toBe("YES");
    expect((await getChallengeById(challengeId))?.status).toBe("ACCEPTED");
    expect(await getWalletBalanceSummary(a.userId)).toEqual({ total: 2 * STAKE, reserved: 0, available: 2 * STAKE });
    expect(await getWalletBalanceSummary(b.userId)).toEqual({ total: 0, reserved: 0, available: 0 });

    // Then the Challenge resolves from the same graded Picks, and money is not touched again.
    await resolveAcceptedChallenges();
    const resolved = await getChallengeById(challengeId);
    expect(resolved?.status).toBe("RESOLVED");
    expect(resolved?.result).toBe("CHALLENGER_WON");
    expect(await getWalletBalanceSummary(a.userId)).toEqual({ total: 2 * STAKE, reserved: 0, available: 2 * STAKE });
    expect((await getMonetaryPositionById(positionId))?.settlementStatus).toBe("SETTLED");
  }

  it("money first, then free Call BS", async () => {
    await assertIndependentResolution("money-first");
  });

  it("free Call BS first, then money", async () => {
    await assertIndependentResolution("call-bs-first");
  });
});
