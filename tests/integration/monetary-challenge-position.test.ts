/**
 * Integration tests for Milestone R9 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Monetary Challenge + Position) — propose_money()/accept_monetary_
 * proposal()/decline_monetary_proposal()/withdraw_monetary_proposal(),
 * reservation correlation, combined lock ordering, free-Challenge
 * independence, reconciliation, and security. Real local Supabase
 * throughout. No real money — local-only wallet fixtures, mirroring
 * tests/integration/wallet-reservations.test.ts's own funding helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { callBS, acceptCallBS } from "@/lib/challenges/repository";
import {
  proposeMoney,
  acceptMonetaryProposal,
  declineMonetaryProposal,
  withdrawMonetaryProposal,
  getMonetaryProposalById,
  getMonetaryPositionById,
  listMonetaryProposalsForMarketAndUser,
  listMonetaryPositionsForUser,
} from "@/lib/monetary/repository";
import { getMonetaryParticipants } from "@/lib/monetary/discovery";
import { getWalletBalanceSummary, getReservationById } from "@/lib/wallet/reservations";
import { checkMonetaryConsistency } from "@/lib/monetary/reconciliation";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();
const PROVIDER = "api_nfl";

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];

async function createFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `r9-fixture-${randomUUID()}`,
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

function marketPayload(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
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
    ...overrides,
  };
}

async function createMarket(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket(marketPayload(fixtureId, overrides));
  createdMarketIds.push(id);
  return id;
}

async function createUser(label = "r9") {
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

async function deposit(userId: string, amount: number, idempotencyKey = randomUUID()) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amount,
    p_admin_id: null,
    p_reason: "test funding",
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
}

async function debit(userId: string, amount: number, idempotencyKey = randomUUID()) {
  return admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "pool_entry_debit",
    p_direction: "debit",
    p_amount: amount,
    p_admin_id: null,
    p_reason: "test debit",
    p_idempotency_key: idempotencyKey,
  });
}

/** Standard fixture: two users with opposing Picks, proposer already funded for `stake`. */
async function setupOpposingFundedPair(stake = 1000) {
  const fixtureId = await createFixture();
  const marketId = await createMarket(fixtureId);
  const proposer = await createUser("proposer");
  const recipient = await createUser("recipient");
  const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
  const recipientPredictionId = await pick(recipient.userId, marketId, "NO");
  await deposit(proposer.userId, stake);
  return { fixtureId, marketId, proposer, recipient, proposerPredictionId, recipientPredictionId };
}

beforeEach(async () => {
  // monetary_p2p_enabled defaults to false (off-by-default kill switch,
  // §60) — every test in this file exercises the enabled path unless it
  // explicitly flips it off itself, so this must run BEFORE the first
  // test too, not only via afterEach's own reset (which only helps the
  // *next* test, never the very first one in the file).
  await setPolicy({
    monetary_p2p_enabled: true,
    call_bs_enabled: true,
    pick_lock_minutes_before_kickoff: 10,
    monetary_proposal_rate_limit_window_seconds: 60,
    monetary_proposal_rate_limit_max_attempts: 10,
  });
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
  await setPolicy({
    monetary_p2p_enabled: true,
    call_bs_enabled: true,
    pick_lock_minutes_before_kickoff: 10,
    monetary_proposal_rate_limit_window_seconds: 60,
    monetary_proposal_rate_limit_max_attempts: 10,
  });
});

describe("Proposal Creation", () => {
  it("creates a PENDING proposal, reserving the proposer's exact stake", async () => {
    const { proposer, recipient, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(1000);

    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.proposal.status).toBe("PENDING");
    expect(outcome.proposal.proposerPredictionId).toBe(proposerPredictionId);
    expect(outcome.proposal.recipientPredictionId).toBe(recipientPredictionId);
    expect(outcome.proposal.proposerSelectionSnapshot).toBe("YES");
    expect(outcome.proposal.recipientSelectionSnapshot).toBe("NO");
    expect(outcome.proposal.stake).toBe(1000);
    expect(outcome.proposal.sourceChallengeId).toBeNull();
    expect(outcome.proposal.positionId).toBeNull();

    const reservation = await getReservationById(outcome.proposal.proposerReservationId);
    expect(reservation?.status).toBe("ACTIVE");
    expect(reservation?.amount).toBe(1000);
    expect(reservation?.purpose).toBe("monetary_position");
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1000, reserved: 1000, available: 0 });
    expect(recipient.userId).toBeTruthy(); // recipient never touched financially at this point
  });

  it("rejects when monetary_p2p_enabled is false", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await setPolicy({ monetary_p2p_enabled: false });

    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("monetary_p2p_disabled");
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  it("rejects a non-positive stake", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 0, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/stake must be positive/);
  });

  it("rejects self-proposal", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const aPick = await pick(a.userId, marketId, "YES");
    await deposit(a.userId, 1000);

    const outcome = await proposeMoney(a.userId, aPick, 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("self_proposal");
  });

  it("rejects a same-side (non-opposing) proposal", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "YES");
    await deposit(a.userId, 1000);

    const outcome = await proposeMoney(a.userId, bPick, 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("picks_not_opposing");
  });

  it("rejects when the proposer has no Pick on the recipient's Market", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const otherFixtureId = await createFixture();
    const otherMarketId = await createMarket(otherFixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, otherMarketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await deposit(a.userId, 1000);

    const outcome = await proposeMoney(a.userId, bPick, 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("proposer_pick_not_found");
  });

  it("rejects a nonexistent recipient Pick id", async () => {
    const a = await createUser("a");
    await deposit(a.userId, 1000);
    const outcome = await proposeMoney(a.userId, randomUUID(), 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("recipient_pick_not_found");
  });

  it("rejects when either Pick is already graded", async () => {
    const { proposer, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await admin
      .from("predictions")
      .update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() })
      .eq("id", proposerPredictionId);

    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("pick_already_graded");
  });

  it("rejects creation past the effective monetary cutoff", async () => {
    const { proposer, recipientPredictionId, fixtureId } = await setupOpposingFundedPair(1000);
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 60 * 1000).toISOString() }).eq("id", fixtureId);

    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("past_monetary_cutoff");
  });

  it("rejects when the proposer's available balance can't cover the stake, and reserves nothing", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await deposit(a.userId, 500);

    const outcome = await proposeMoney(a.userId, bPick, 1000, randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/insufficient_available_balance/);
    expect(await getWalletBalanceSummary(a.userId)).toEqual({ total: 500, reserved: 0, available: 500 });
  });

  it("rejects a duplicate PENDING proposal between the same pair, in either direction", async () => {
    const { proposer, recipient, recipientPredictionId, proposerPredictionId } = await setupOpposingFundedPair(1000);
    await deposit(proposer.userId, 500); // enough left over to attempt (and be refused for) a second, smaller proposal
    await deposit(recipient.userId, 1000);

    const first = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(first.ok).toBe(true);

    const second = await proposeMoney(proposer.userId, recipientPredictionId, 500, randomUUID());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("duplicate_pending_proposal");

    const reverse = await proposeMoney(recipient.userId, proposerPredictionId, 500, randomUUID());
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) expect(reverse.error).toBe("duplicate_pending_proposal");
  });

  it("is idempotent: the same idempotency key returns the same proposal without a second reservation", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const key = randomUUID();

    const first = await proposeMoney(proposer.userId, recipientPredictionId, 1000, key);
    const second = await proposeMoney(proposer.userId, recipientPredictionId, 1000, key);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.proposal.id).toBe(second.proposal.id);
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1000, reserved: 1000, available: 0 });
  });

  describe("Challenge escalation", () => {
    it("a valid escalation links the proposal to the accepted free Challenge", async () => {
      const { proposer, recipient, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(1000);
      const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
      if (!challengeOutcome.ok) throw new Error("setup failed");
      const acceptResult = await acceptCallBS(challengeOutcome.challenge.id, recipient.userId);
      expect(acceptResult.outcome).toBe("accepted");

      const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID(), challengeOutcome.challenge.id);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.proposal.sourceChallengeId).toBe(challengeOutcome.challenge.id);
      expect(proposerPredictionId).toBeTruthy();
    });

    it("either original party may be the one who escalates (unordered participant match)", async () => {
      const { proposer, recipient, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(1000);
      const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
      if (!challengeOutcome.ok) throw new Error("setup failed");
      await acceptCallBS(challengeOutcome.challenge.id, recipient.userId);
      await deposit(recipient.userId, 1000);

      // The RECIPIENT of the original free Challenge is the one proposing money here.
      const outcome = await proposeMoney(recipient.userId, proposerPredictionId, 1000, randomUUID(), challengeOutcome.challenge.id);
      expect(outcome.ok).toBe(true);
    });

    it("rejects escalation of a nonexistent source Challenge", async () => {
      const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
      const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID(), randomUUID());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBe("source_challenge_not_found");
    });

    it("rejects escalation of a still-PENDING (not yet accepted) Challenge", async () => {
      const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
      const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
      if (!challengeOutcome.ok) throw new Error("setup failed");

      const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID(), challengeOutcome.challenge.id);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBe("source_challenge_not_accepted");
    });

    it("rejects escalation whose participants don't match this proposal (same Market, different pair)", async () => {
      const { proposer, recipient, proposerPredictionId, recipientPredictionId, marketId } = await setupOpposingFundedPair(1000);
      const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
      if (!challengeOutcome.ok) throw new Error("setup failed");
      await acceptCallBS(challengeOutcome.challenge.id, recipient.userId);

      // A third user, opposing the proposer on the SAME Market (so the
      // Market check passes) but not a party to the source Challenge —
      // isolates participant mismatch from the separately-tested market
      // mismatch.
      const outsider = await createUser("outsider");
      await pick(outsider.userId, marketId, "NO");
      await deposit(outsider.userId, 1000);

      const outcome = await proposeMoney(outsider.userId, proposerPredictionId, 1000, randomUUID(), challengeOutcome.challenge.id);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBe("source_challenge_participant_mismatch");
    });

    it("rejects escalation whose Market doesn't match this proposal", async () => {
      const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
      const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
      if (!challengeOutcome.ok) throw new Error("setup failed");
      await acceptCallBS(challengeOutcome.challenge.id, recipient.userId);

      const fixtureId2 = await createFixture();
      const marketId2 = await createMarket(fixtureId2);
      await pick(proposer.userId, marketId2, "YES");
      const otherPick = await pick(recipient.userId, marketId2, "NO");

      const outcome = await proposeMoney(proposer.userId, otherPick, 1000, randomUUID(), challengeOutcome.challenge.id);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBe("source_challenge_market_mismatch");
    });
  });
});

describe("Pending", () => {
  it("a pending proposal does not lock either Pick", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(outcome.ok).toBe(true);

    const { data: proposerPred } = await admin.from("predictions").select("locked_at, lock_reason").eq("user_id", proposer.userId).single();
    const { data: recipientPred } = await admin.from("predictions").select("locked_at, lock_reason").eq("user_id", recipient.userId).single();
    expect(proposerPred?.locked_at).toBeNull();
    expect(recipientPred?.locked_at).toBeNull();
  });

  it("funding the recipient's wallet never auto-accepts a pending proposal", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await deposit(recipient.userId, 1000);

    const stillPending = await getMonetaryProposalById(outcome.proposal.id);
    expect(stillPending?.status).toBe("PENDING");
    expect(stillPending?.positionId).toBeNull();
  });

  it("recipient does not need funds to receive a proposal", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await deposit(a.userId, 1000);
    expect(await getWalletBalanceSummary(b.userId)).toEqual({ total: 0, reserved: 0, available: 0 });

    const outcome = await proposeMoney(a.userId, bPick, 1000, randomUUID());
    expect(outcome.ok).toBe(true);
  });

  describe("Discovery", () => {
    it("canProposeMoney is false once a PENDING proposal exists between the pair", async () => {
      const { proposer, recipient, recipientPredictionId, marketId, fixtureId } = await setupOpposingFundedPair(1000);
      await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());

      const { data: fixture } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", fixtureId).single();
      const participants = await getMonetaryParticipants(marketId, proposer.userId, fixture!.scheduled_start_utc);
      const recipientRow = participants.find((p) => p.userId === recipient.userId);
      expect(recipientRow?.canProposeMoney).toBe(false);
    });

    it("canProposeMoney is false when monetary_p2p_enabled is off", async () => {
      const { proposer, recipient, marketId, fixtureId } = await setupOpposingFundedPair(1000);
      await setPolicy({ monetary_p2p_enabled: false });

      const { data: fixture } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", fixtureId).single();
      const participants = await getMonetaryParticipants(marketId, proposer.userId, fixture!.scheduled_start_utc);
      const recipientRow = participants.find((p) => p.userId === recipient.userId);
      expect(recipientRow?.canProposeMoney).toBe(false);
    });
  });
});

describe("Acceptance", () => {
  it("the full happy path: commits a Position, both reservations ACTIVE, both Picks locked", async () => {
    const { proposer, recipient, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(result.outcome).toBe("accepted");
    expect(result.proposal.status).toBe("ACCEPTED");
    expect(result.position).not.toBeNull();
    expect(result.position!.stake).toBe(1000);
    expect(result.position!.proposalId).toBe(proposed.proposal.id);
    expect(result.proposal.positionId).toBe(result.position!.id);

    const proposerReservation = await getReservationById(result.position!.proposerReservationId);
    const recipientReservation = await getReservationById(result.position!.recipientReservationId);
    expect(proposerReservation?.status).toBe("ACTIVE");
    expect(recipientReservation?.status).toBe("ACTIVE");
    expect(proposerReservation?.id).not.toBe(recipientReservation?.id);

    const { data: proposerPred } = await admin.from("predictions").select("locked_at, lock_reason").eq("id", proposerPredictionId).single();
    const { data: recipientPred } = await admin.from("predictions").select("locked_at, lock_reason").eq("id", recipientPredictionId).single();
    expect(proposerPred?.lock_reason).toBe("MONETARY_POSITION_ACCEPTED");
    expect(recipientPred?.lock_reason).toBe("MONETARY_POSITION_ACCEPTED");
    expect(proposerPred?.locked_at).not.toBeNull();

    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1000, reserved: 1000, available: 0 });
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 1000, reserved: 1000, available: 0 });
  });

  it("reports insufficient_recipient_balance without mutating the proposal when the recipient can't cover the stake", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(result.outcome).toBe("insufficient_recipient_balance");
    expect(result.position).toBeNull();
    expect(result.proposal.status).toBe("PENDING");

    const stillPending = await getMonetaryProposalById(proposed.proposal.id);
    expect(stillPending?.status).toBe("PENDING");
    const reservation = await getReservationById(proposed.proposal.proposerReservationId);
    expect(reservation?.status).toBe("ACTIVE");
  });

  it("rejects acceptance by anyone other than the recipient", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const outsider = await createUser("outsider");
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    await expect(acceptMonetaryProposal(proposed.proposal.id, outsider.userId)).rejects.toThrow(/not_recipient/);
  });

  it("reports not_pending for a non-PENDING proposal", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    await withdrawMonetaryProposal(proposed.proposal.id, proposer.userId);

    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(result.outcome).toBe("not_pending");
  });

  it("expires and releases the proposer's reservation when accepted past cutoff", async () => {
    const { proposer, recipient, recipientPredictionId, fixtureId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 60 * 1000).toISOString() }).eq("id", fixtureId);

    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(result.outcome).toBe("rejected_cutoff");
    expect(result.proposal.status).toBe("EXPIRED");
    const reservation = await getReservationById(proposed.proposal.proposerReservationId);
    expect(reservation?.status).toBe("RELEASED");
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  it("expires and releases the proposer's reservation when the proposer's Pick was edited since the proposal was sent", async () => {
    const { proposer, recipient, recipientPredictionId, marketId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    // Proposer flips their own pick — still allowed since it isn't locked.
    await pick(proposer.userId, marketId, "NO");

    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(result.outcome).toBe("rejected_invalidated");
    expect(result.proposal.status).toBe("EXPIRED");
    const reservation = await getReservationById(proposed.proposal.proposerReservationId);
    expect(reservation?.status).toBe("RELEASED");
  });

  it("preserves an existing CHALLENGE_ACCEPTED lock rather than overwriting it with MONETARY_POSITION_ACCEPTED", async () => {
    const { proposer, recipient, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(2000);
    const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
    if (!challengeOutcome.ok) throw new Error("setup failed");
    await acceptCallBS(challengeOutcome.challenge.id, recipient.userId);

    const { data: beforeLock } = await admin.from("predictions").select("locked_at, lock_reason").eq("id", proposerPredictionId).single();
    expect(beforeLock?.lock_reason).toBe("CHALLENGE_ACCEPTED");

    await deposit(recipient.userId, 2000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 2000, randomUUID(), challengeOutcome.challenge.id);
    if (!proposed.ok) throw new Error("setup failed");
    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(result.outcome).toBe("accepted");

    const { data: afterLock } = await admin.from("predictions").select("locked_at, lock_reason").eq("id", proposerPredictionId).single();
    expect(afterLock?.lock_reason).toBe("CHALLENGE_ACCEPTED");
    expect(afterLock?.locked_at).toBe(beforeLock?.locked_at);
  });

  it("duplicate-acceptance retry: two concurrent accept calls on the same proposal produce exactly one Position", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const [first, second] = await Promise.allSettled([
      acceptMonetaryProposal(proposed.proposal.id, recipient.userId),
      acceptMonetaryProposal(proposed.proposal.id, recipient.userId),
    ]);
    const outcomes = [first, second].map((r) => (r.status === "fulfilled" ? r.value.outcome : "threw"));
    expect(outcomes.filter((o) => o === "accepted")).toHaveLength(1);

    const { data: positions } = await admin.from("monetary_positions").select("id").eq("proposal_id", proposed.proposal.id);
    expect(positions ?? []).toHaveLength(1);
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 1000, reserved: 1000, available: 0 });
  });

  it("accept-vs-second-incoming-proposal: an underfunded recipient can accept at most one of two concurrent proposals for the same stake", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const proposerA = await createUser("propA");
    const proposerB = await createUser("propB");
    const recipient = await createUser("recip");
    await deposit(proposerA.userId, 1000);
    await deposit(proposerB.userId, 1000);
    await deposit(recipient.userId, 1000);

    const recipientPredictionId = await pick(recipient.userId, marketId, "NO");
    await pick(proposerA.userId, marketId, "YES");

    const fixtureId2 = await createFixture();
    const marketId2 = await createMarket(fixtureId2);
    const recipientPredictionId2 = await pick(recipient.userId, marketId2, "NO");
    await pick(proposerB.userId, marketId2, "YES");

    const proposedA = await proposeMoney(proposerA.userId, recipientPredictionId, 1000, randomUUID());
    const proposedB = await proposeMoney(proposerB.userId, recipientPredictionId2, 1000, randomUUID());
    if (!proposedA.ok || !proposedB.ok) throw new Error("setup failed");

    const [resultA, resultB] = await Promise.all([
      acceptMonetaryProposal(proposedA.proposal.id, recipient.userId),
      acceptMonetaryProposal(proposedB.proposal.id, recipient.userId),
    ]);
    const outcomes = [resultA.outcome, resultB.outcome];
    expect(outcomes.filter((o) => o === "accepted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "insufficient_recipient_balance")).toHaveLength(1);
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 1000, reserved: 1000, available: 0 });
  });
});

describe("Decline / Withdraw", () => {
  it("recipient decline releases the proposer's reservation and sets DECLINED", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const declined = await declineMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(declined.status).toBe("DECLINED");
    expect(declined.declinedAt).not.toBeNull();
    const reservation = await getReservationById(proposed.proposal.proposerReservationId);
    expect(reservation?.status).toBe("RELEASED");
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  it("proposer withdraw releases their own reservation and sets WITHDRAWN", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const withdrawn = await withdrawMonetaryProposal(proposed.proposal.id, proposer.userId);
    expect(withdrawn.status).toBe("WITHDRAWN");
    expect(withdrawn.withdrawnAt).not.toBeNull();
    const reservation = await getReservationById(proposed.proposal.proposerReservationId);
    expect(reservation?.status).toBe("RELEASED");
  });

  it("rejects decline by a non-recipient", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    await expect(declineMonetaryProposal(proposed.proposal.id, proposer.userId)).rejects.toThrow(/not_recipient/);
  });

  it("rejects withdraw by a non-proposer", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    await expect(withdrawMonetaryProposal(proposed.proposal.id, recipient.userId)).rejects.toThrow(/not_proposer/);
  });

  it("rejects decline/withdraw of an already-resolved proposal", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    await withdrawMonetaryProposal(proposed.proposal.id, proposer.userId);

    await expect(declineMonetaryProposal(proposed.proposal.id, recipient.userId)).rejects.toThrow(/not_pending/);
    await expect(withdrawMonetaryProposal(proposed.proposal.id, proposer.userId)).rejects.toThrow(/not_pending/);
  });

  it("accept-vs-decline race resolves to exactly one winner", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const [acceptSettled, declineSettled] = await Promise.allSettled([
      acceptMonetaryProposal(proposed.proposal.id, recipient.userId),
      declineMonetaryProposal(proposed.proposal.id, recipient.userId),
    ]);

    const finalProposal = await getMonetaryProposalById(proposed.proposal.id);
    expect(["ACCEPTED", "DECLINED"]).toContain(finalProposal?.status);
    // Whichever won, the state is fully coherent: exactly one of the two operations reflects reality.
    const acceptedWon = acceptSettled.status === "fulfilled" && acceptSettled.value.outcome === "accepted";
    const declinedWon = declineSettled.status === "fulfilled";
    expect(acceptedWon || declinedWon).toBe(true);
  });
});

describe("Position", () => {
  it("is unaffected by Market line movement", async () => {
    const { proposer, recipient, recipientPredictionId, marketId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    if (result.outcome !== "accepted") throw new Error("setup failed");

    await admin.from("markets").update({ yes_price: 0.9, no_price: 0.1 }).eq("id", marketId);

    const refetched = await getMonetaryPositionById(result.position!.id);
    expect(refetched?.stake).toBe(1000);
    expect(refetched?.proposerSelectionSnapshot).toBe("YES");
    expect(refetched?.recipientSelectionSnapshot).toBe("NO");
  });

  it("is unaffected by a Game reschedule", async () => {
    const { proposer, recipient, recipientPredictionId, fixtureId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    if (result.outcome !== "accepted") throw new Error("setup failed");

    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 999 * 24 * 60 * 60 * 1000).toISOString() }).eq("id", fixtureId);

    const refetched = await getMonetaryPositionById(result.position!.id);
    expect(refetched?.id).toBe(result.position!.id);
    expect(refetched?.stake).toBe(1000);
  });

  it("has no generic 'status' column, and a freshly-committed Position's own settlement fields are still at their COMMITTED defaults", async () => {
    // R9 itself added no speculative settlement vocabulary — no `status`
    // column ever existed here. Milestone R10 later added the exact
    // settlement fields R9's own type comment said would come "later"
    // (settlement_status/settled_at/settlement_id/fee_bps) — this test
    // now asserts THAT reality (a freshly-committed Position is
    // COMMITTED, not settled) rather than their total absence, which
    // stopped being true the moment R10 existed.
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);

    const { data: raw } = await admin.from("monetary_positions").select("*").eq("id", result.position!.id).single();
    expect(raw).not.toHaveProperty("status");
    expect(raw?.settlement_status).toBe("COMMITTED");
    expect(raw?.settled_at).toBeNull();
    expect(raw?.settlement_id).toBeNull();
  });

  it("both reservations remain ACTIVE after commitment and are never consumed or released by R9", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);

    const proposerReservation = await getReservationById(result.position!.proposerReservationId);
    const recipientReservation = await getReservationById(result.position!.recipientReservationId);
    expect(proposerReservation?.status).toBe("ACTIVE");
    expect(recipientReservation?.status).toBe("ACTIVE");

    const positions = await listMonetaryPositionsForUser(proposer.userId);
    expect(positions.map((p) => p.id)).toContain(result.position!.id);
  });
});

describe("Free Challenge Independence", () => {
  it("proposeMoney works with no underlying free Challenge at all", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const outcome = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.proposal.sourceChallengeId).toBeNull();
  });

  it("a free Challenge and an independent monetary Position can coexist on the same Pick pair without interfering", async () => {
    const { proposer, recipient, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(1000);
    await deposit(recipient.userId, 1000);

    const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
    if (!challengeOutcome.ok) throw new Error("setup failed");
    await acceptCallBS(challengeOutcome.challenge.id, recipient.userId);

    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    expect(result.outcome).toBe("accepted");

    const { data: challenge } = await admin.from("challenges").select("status").eq("id", challengeOutcome.challenge.id).single();
    expect(challenge?.status).toBe("ACCEPTED");
    expect(result.position!.proposerPredictionId).toBe(proposerPredictionId);
  });

  it("declining a monetary proposal does not affect an independent free Challenge between the same two Picks", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const challengeOutcome = await callBS(proposer.userId, recipientPredictionId);
    if (!challengeOutcome.ok) throw new Error("setup failed");

    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    await declineMonetaryProposal(proposed.proposal.id, recipient.userId);

    const { data: challenge } = await admin.from("challenges").select("status").eq("id", challengeOutcome.challenge.id).single();
    expect(challenge?.status).toBe("PENDING");
  });
});

describe("Wallet", () => {
  it("getWalletBalanceSummary reflects on-hold funds for both participants after commitment", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1500);
    await deposit(recipient.userId, 1500);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1500, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);

    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1500, reserved: 1500, available: 0 });
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 1500, reserved: 1500, available: 0 });
  });

  it("an ordinary debit against a proposer's reserved balance still respects the reservation floor", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const { error } = await debit(proposer.userId, 1);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/insufficient_balance/);
  });
});

describe("Reconciliation", () => {
  it("finds no anomalies across a mix of pending, declined, and committed proposals", async () => {
    const pairA = await setupOpposingFundedPair(1000);
    const proposedA = await proposeMoney(pairA.proposer.userId, pairA.recipientPredictionId, 1000, randomUUID());
    if (!proposedA.ok) throw new Error("setup failed");

    const pairB = await setupOpposingFundedPair(500);
    const proposedB = await proposeMoney(pairB.proposer.userId, pairB.recipientPredictionId, 500, randomUUID());
    if (!proposedB.ok) throw new Error("setup failed");
    await declineMonetaryProposal(proposedB.proposal.id, pairB.recipient.userId);

    const pairC = await setupOpposingFundedPair(750);
    await deposit(pairC.recipient.userId, 750);
    const proposedC = await proposeMoney(pairC.proposer.userId, pairC.recipientPredictionId, 750, randomUUID());
    if (!proposedC.ok) throw new Error("setup failed");
    await acceptMonetaryProposal(proposedC.proposal.id, pairC.recipient.userId);

    const report = await checkMonetaryConsistency();
    expect(report.anomalies).toEqual([]);
    expect(report.checkedProposals).toBeGreaterThanOrEqual(3);
    expect(report.checkedPositions).toBeGreaterThanOrEqual(1);
  });
});

describe("Security", () => {
  it("no authenticated client can call the monetary RPCs directly (service_role only)", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);

    const { error: proposeErr } = await proposer.client.rpc("propose_money", {
      p_proposer_user_id: proposer.userId,
      p_recipient_prediction_id: recipientPredictionId,
      p_stake: 1000,
      p_idempotency_key: randomUUID(),
      p_source_challenge_id: null,
    });
    expect(proposeErr).not.toBeNull();

    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const { error: acceptErr } = await recipient.client.rpc("accept_monetary_proposal", { p_proposal_id: proposed.proposal.id, p_recipient_user_id: recipient.userId });
    expect(acceptErr).not.toBeNull();
    const { error: declineErr } = await recipient.client.rpc("decline_monetary_proposal", { p_proposal_id: proposed.proposal.id, p_recipient_user_id: recipient.userId });
    expect(declineErr).not.toBeNull();
    const { error: withdrawErr } = await proposer.client.rpc("withdraw_monetary_proposal", { p_proposal_id: proposed.proposal.id, p_proposer_user_id: proposer.userId });
    expect(withdrawErr).not.toBeNull();
  });

  it("an authenticated client cannot write monetary_proposals or monetary_positions directly", async () => {
    const { proposer, recipient, proposerPredictionId, recipientPredictionId } = await setupOpposingFundedPair(1000);

    const { data: insertData } = await proposer.client
      .from("monetary_proposals")
      .insert({
        market_id: randomUUID(),
        proposer_user_id: proposer.userId,
        recipient_user_id: recipient.userId,
        proposer_prediction_id: proposerPredictionId,
        recipient_prediction_id: recipientPredictionId,
        proposer_selection_snapshot: "YES",
        recipient_selection_snapshot: "NO",
        stake: 1000,
        proposer_reservation_id: randomUUID(),
        idempotency_key: randomUUID(),
      })
      .select();
    expect(insertData ?? []).toHaveLength(0);

    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const { error: updateErr } = await proposer.client.from("monetary_proposals").update({ status: "ACCEPTED" }).eq("id", proposed.proposal.id);
    expect(updateErr).not.toBeNull();
    const { data: unchanged } = await admin.from("monetary_proposals").select("status").eq("id", proposed.proposal.id).single();
    expect(unchanged?.status).toBe("PENDING");
  });

  it("participants can read their own proposal via RLS; an outsider cannot, even after acceptance (no public-record exception)", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const outsider = await createUser("outsider");
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const { data: proposerView } = await proposer.client.from("monetary_proposals").select("id").eq("id", proposed.proposal.id);
    expect(proposerView).toHaveLength(1);
    const { data: recipientView } = await recipient.client.from("monetary_proposals").select("id").eq("id", proposed.proposal.id);
    expect(recipientView).toHaveLength(1);
    const { data: outsiderView } = await outsider.client.from("monetary_proposals").select("id").eq("id", proposed.proposal.id);
    expect(outsiderView ?? []).toHaveLength(0);

    await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    const { data: outsiderViewAfterAccept } = await outsider.client.from("monetary_proposals").select("id").eq("id", proposed.proposal.id);
    expect(outsiderViewAfterAccept ?? []).toHaveLength(0);
  });

  it("an outsider cannot read a committed Position — no public-record exception, unlike a RESOLVED free Challenge", async () => {
    const { proposer, recipient, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const outsider = await createUser("outsider");
    await deposit(recipient.userId, 1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const result = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);

    const { data: proposerView } = await proposer.client.from("monetary_positions").select("id").eq("id", result.position!.id);
    expect(proposerView).toHaveLength(1);
    const { data: outsiderView } = await outsider.client.from("monetary_positions").select("id").eq("id", result.position!.id);
    expect(outsiderView ?? []).toHaveLength(0);
  });

  it("anon cannot read monetary_proposals or monetary_positions at all", async () => {
    const { proposer, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const anon = getTestAnonClient();
    const { data: proposalData } = await anon.from("monetary_proposals").select("id").eq("id", proposed.proposal.id);
    expect(proposalData ?? []).toEqual([]);
    const { data: positionData } = await anon.from("monetary_positions").select("id");
    expect(positionData ?? []).toEqual([]);
  });

  it("listMonetaryProposalsForMarketAndUser only returns proposals the given user is a party to", async () => {
    const { proposer, recipient, marketId, recipientPredictionId } = await setupOpposingFundedPair(1000);
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    const outsider = await createUser("outsider2");
    const outsiderView = await listMonetaryProposalsForMarketAndUser(marketId, outsider.userId);
    expect(outsiderView).toEqual([]);
    const recipientView = await listMonetaryProposalsForMarketAndUser(marketId, recipient.userId);
    expect(recipientView.map((p) => p.id)).toContain(proposed.proposal.id);
  });
});
