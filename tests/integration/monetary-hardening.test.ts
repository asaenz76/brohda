/**
 * Integration tests for the monetary P2P production audit + hardening:
 * account state enforced server-side, concurrent double-spend, the expiry
 * sweeper (and its races), the settlement job's expiry + notification
 * behaviour, and the exact 1% fee / ledger math. Real local Supabase; no
 * real money — local-only wallet fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteMonetaryRowsForMarkets } from "./helpers/cleanup-monetary";
import { getTestAdminClient } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import {
  proposeMoney,
  acceptMonetaryProposal,
  withdrawMonetaryProposal,
  expireStaleMonetaryProposals,
  getMonetaryProposalById,
  settleMonetaryPosition,
} from "@/lib/monetary/repository";
import { runSettlementJob } from "@/lib/monetary/settlement-runner";
import { getWalletBalanceSummary, getReservationById } from "@/lib/wallet/reservations";
import { checkMonetaryConsistency } from "@/lib/monetary/reconciliation";
import { createMonetaryProposalReceivedNotification } from "@/lib/notifications/monetary-proposals";
import { isDegradedResult } from "@/lib/jobs/health";

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
      external_fixture_id: `hardening-fixture-${randomUUID()}`,
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
  const { data, error } = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role: "player", is_active: true });
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

async function houseBalance(): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("account_type", "house").single();
  return data!.balance as number;
}

async function gradeMoneyline(fixtureId: string, marketId: string, homeScore: number, awayScore: number) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  const outcome: "YES" | "NO" = homeScore > awayScore ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    await admin
      .from("predictions")
      .update({ lifecycle_state: "GRADED", result: p.selected_outcome === outcome ? "CORRECT" : "INCORRECT", resolved_outcome_snapshot: outcome, graded_at: new Date().toISOString() })
      .eq("id", p.id);
  }
}

/** Two opposing users; the proposer (YES) is funded for `proposerFunds`, the recipient (NO) for `recipientFunds`. */
async function setupPair({ proposerFunds = 1000, recipientFunds = 0, fixtureOverrides = {} }: { proposerFunds?: number; recipientFunds?: number; fixtureOverrides?: Record<string, unknown> } = {}) {
  const fixtureId = await createFixture(fixtureOverrides);
  const marketId = await createMarket(fixtureId);
  const proposer = await createUser("proposer");
  const recipient = await createUser("recipient");
  await pick(proposer, marketId, "YES");
  const recipientPick = await pick(recipient, marketId, "NO");
  if (proposerFunds > 0) await deposit(proposer, proposerFunds);
  if (recipientFunds > 0) await deposit(recipient, recipientFunds);
  return { fixtureId, marketId, proposer, recipient, recipientPick };
}

async function send(proposer: string, recipientPick: string, stake: number) {
  const outcome = await proposeMoney(proposer, recipientPick, stake, randomUUID());
  if (!outcome.ok) throw new Error(`propose failed: ${outcome.error}`);
  return outcome.proposal;
}

/** Moves kickoff inside the cutoff window — the Game is "past the cutoff" without having started. */
async function movePastCutoff(fixtureId: string) {
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 3 * 60_000).toISOString() }).eq("id", fixtureId);
}

const BASE_POLICY = { monetary_p2p_enabled: true, call_bs_enabled: true, p2p_fee_bps: 0, pick_lock_minutes_before_kickoff: 10, monetary_proposal_rate_limit_window_seconds: 60, monetary_proposal_rate_limit_max_attempts: 10, monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000 };

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
    if (proposalIds.length > 0) {
      await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
      if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
      await admin.from("monetary_proposals").delete().in("id", proposalIds);
    }
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

describe("Account state is enforced server-side", () => {
  it("rejects a proposal from an inactive proposer and reserves nothing", async () => {
    const { proposer, recipientPick } = await setupPair();
    await admin.from("user_profiles").update({ is_active: false }).eq("id", proposer);
    const outcome = await proposeMoney(proposer, recipientPick, 500, randomUUID());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("proposer_inactive");
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  it("rejects a proposal to an inactive recipient and reserves nothing", async () => {
    const { proposer, recipient, recipientPick } = await setupPair();
    await admin.from("user_profiles").update({ is_active: false }).eq("id", recipient);
    const outcome = await proposeMoney(proposer, recipientPick, 500, randomUUID());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("recipient_inactive");
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  for (const deactivated of ["proposer", "recipient"] as const) {
    it(`expires the proposal and releases the hold when the ${deactivated} became inactive before acceptance`, async () => {
      const { proposer, recipient, recipientPick } = await setupPair({ recipientFunds: 1000 });
      const proposal = await send(proposer, recipientPick, 500);
      expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 500, available: 500 });

      await admin.from("user_profiles").update({ is_active: false }).eq("id", deactivated === "proposer" ? proposer : recipient);

      const result = await acceptMonetaryProposal(proposal.id, recipient);
      expect(result.outcome).toBe("rejected_ineligible_account");
      expect(result.position).toBeNull();
      expect(result.proposal.status).toBe("EXPIRED");
      expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
      expect(await getWalletBalanceSummary(recipient)).toEqual({ total: 1000, reserved: 0, available: 1000 });
      expect((await getReservationById(proposal.proposerReservationId))?.status).toBe("RELEASED");
    });
  }
});

describe("Concurrent double-spend", () => {
  it("two proposals that would jointly overcommit one balance — exactly one reserves", async () => {
    const { fixtureId, marketId, proposer, recipientPick } = await setupPair({ proposerFunds: 1000 });
    void fixtureId;
    const second = await createUser("recipient2");
    const secondPick = await pick(second, marketId, "NO");

    const [a, b] = await Promise.all([
      proposeMoney(proposer, recipientPick, 1000, randomUUID()),
      proposeMoney(proposer, secondPick, 1000, randomUUID()),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const failed = [a, b].find((o) => !o.ok);
    if (failed && !failed.ok) expect(failed.error).toBe("insufficient_available_balance");
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 1000, available: 0 });
    const { data: active } = await admin.from("wallet_reservations").select("id").eq("user_id", proposer).eq("status", "ACTIVE");
    expect(active).toHaveLength(1);
  });

  it("many concurrent proposals never reserve more than the balance, and each reservation equals its stake exactly", async () => {
    const { marketId, proposer } = await setupPair({ proposerFunds: 1000 });
    const picks: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await createUser(`r${i}`);
      picks.push(await pick(r, marketId, "NO"));
    }
    const results = await Promise.all(picks.map((p) => proposeMoney(proposer, p, 300, randomUUID())));
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(3); // 3 x 300 fits in 1000; the 4th would need 1200
    const summary = await getWalletBalanceSummary(proposer);
    expect(summary).toEqual({ total: 1000, reserved: 900, available: 100 });
    for (const r of ok) {
      if (!r.ok) continue;
      const reservation = await getReservationById(r.proposal.proposerReservationId);
      expect(reservation?.amount).toBe(300);
      expect(reservation?.status).toBe("ACTIVE");
    }
  });
});

describe("Expiry sweep", () => {
  it("expires a PENDING proposal whose Game is past the cutoff, releasing the proposer's hold in the same step", async () => {
    const { fixtureId, proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    await movePastCutoff(fixtureId);

    const expired = await expireStaleMonetaryProposals();
    const mine = expired.find((p) => p.id === proposal.id);
    expect(mine?.status).toBe("EXPIRED");
    expect(mine?.expiredAt).not.toBeNull();

    expect((await getMonetaryProposalById(proposal.id))?.status).toBe("EXPIRED");
    expect((await getReservationById(proposal.proposerReservationId))?.status).toBe("RELEASED");
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
    const { data: positions } = await admin.from("monetary_positions").select("id").eq("proposal_id", proposal.id);
    expect(positions ?? []).toHaveLength(0);
  });

  it("is idempotent: a second sweep finds nothing and changes nothing", async () => {
    const { fixtureId, proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    await movePastCutoff(fixtureId);

    await expireStaleMonetaryProposals();
    const again = await expireStaleMonetaryProposals();
    expect(again.find((p) => p.id === proposal.id)).toBeUndefined();
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  it("leaves a proposal alone while the Game is still before the cutoff", async () => {
    const { proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    const expired = await expireStaleMonetaryProposals();
    expect(expired.find((p) => p.id === proposal.id)).toBeUndefined();
    expect((await getMonetaryProposalById(proposal.id))?.status).toBe("PENDING");
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 500, available: 500 });
  });

  it("never touches an ACCEPTED proposal or its committed Position, even past the cutoff", async () => {
    const { fixtureId, proposer, recipient, recipientPick } = await setupPair({ recipientFunds: 1000 });
    const proposal = await send(proposer, recipientPick, 500);
    const accepted = await acceptMonetaryProposal(proposal.id, recipient);
    expect(accepted.outcome).toBe("accepted");
    await movePastCutoff(fixtureId);

    const expired = await expireStaleMonetaryProposals();
    expect(expired.find((p) => p.id === proposal.id)).toBeUndefined();
    expect((await getMonetaryProposalById(proposal.id))?.status).toBe("ACCEPTED");
    expect((await getReservationById(accepted.position!.proposerReservationId))?.status).toBe("ACTIVE");
    expect((await getReservationById(accepted.position!.recipientReservationId))?.status).toBe("ACTIVE");
  });

  it("expires a proposal once the Game is no longer NOT_STARTED, even if kickoff is far ahead on paper", async () => {
    const { fixtureId, proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    await admin.from("fixtures").update({ internal_status: "POSTPONED" }).eq("id", fixtureId);
    const expired = await expireStaleMonetaryProposals();
    expect(expired.find((p) => p.id === proposal.id)?.status).toBe("EXPIRED");
  });

  it("uses the one canonical cutoff setting, not a second hard-coded value", async () => {
    const { fixtureId, proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 30 * 60_000).toISOString() }).eq("id", fixtureId);

    await setPolicy({ pick_lock_minutes_before_kickoff: 5 });
    expect((await expireStaleMonetaryProposals()).find((p) => p.id === proposal.id)).toBeUndefined();

    await setPolicy({ pick_lock_minutes_before_kickoff: 60 });
    expect((await expireStaleMonetaryProposals()).find((p) => p.id === proposal.id)?.status).toBe("EXPIRED");
  });

  it("sweep vs withdraw on the same proposal: exactly one terminal state, one release, no negative hold", async () => {
    const { fixtureId, proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    await movePastCutoff(fixtureId);

    const [swept, withdrawn] = await Promise.allSettled([expireStaleMonetaryProposals(), withdrawMonetaryProposal(proposal.id, proposer)]);
    expect(swept.status).toBe("fulfilled");
    const final = await getMonetaryProposalById(proposal.id);
    expect(["EXPIRED", "WITHDRAWN"]).toContain(final?.status);
    if (final?.status === "EXPIRED") expect(withdrawn.status).toBe("rejected"); // lost the row: not_pending
    expect((await getReservationById(proposal.proposerReservationId))?.status).toBe("RELEASED");
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  it("sweep vs accept past the cutoff: never a Position, hold released exactly once", async () => {
    const { fixtureId, proposer, recipient, recipientPick } = await setupPair({ recipientFunds: 1000 });
    const proposal = await send(proposer, recipientPick, 500);
    await movePastCutoff(fixtureId);

    await Promise.allSettled([expireStaleMonetaryProposals(), acceptMonetaryProposal(proposal.id, recipient)]);
    expect((await getMonetaryProposalById(proposal.id))?.status).toBe("EXPIRED");
    const { data: positions } = await admin.from("monetary_positions").select("id").eq("proposal_id", proposal.id);
    expect(positions ?? []).toHaveLength(0);
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
    expect(await getWalletBalanceSummary(recipient)).toEqual({ total: 1000, reserved: 0, available: 1000 });
  });

  it("leaves no stale reservation behind after any terminal path, and reconciliation is clean", async () => {
    const declined = await setupPair({ recipientFunds: 1000 });
    const p1 = await send(declined.proposer, declined.recipientPick, 400);
    await admin.rpc("decline_monetary_proposal", { p_proposal_id: p1.id, p_recipient_user_id: declined.recipient });

    const withdrawn = await setupPair();
    const p2 = await send(withdrawn.proposer, withdrawn.recipientPick, 400);
    await withdrawMonetaryProposal(p2.id, withdrawn.proposer);

    const expiring = await setupPair({ fixtureOverrides: {} });
    await send(expiring.proposer, expiring.recipientPick, 400);
    await movePastCutoff(expiring.fixtureId);
    await expireStaleMonetaryProposals();

    for (const user of [declined.proposer, withdrawn.proposer, expiring.proposer]) {
      expect(await getWalletBalanceSummary(user)).toEqual({ total: 1000, reserved: 0, available: 1000 });
      const { data: active } = await admin.from("wallet_reservations").select("id").eq("user_id", user).eq("status", "ACTIVE");
      expect(active ?? []).toHaveLength(0);
    }
    const report = await checkMonetaryConsistency();
    expect(report.anomalies).toEqual([]);
  });
});

describe("Settlement job: expiry and notifications", () => {
  it("expires stale proposals, notifies the proposer exactly once (stamped), and a re-run does not repeat it", async () => {
    const { fixtureId, marketId, proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    await movePastCutoff(fixtureId);

    const first = await runSettlementJob();
    expect(first.expiredProposals).toBeGreaterThanOrEqual(1);
    expect(first.failures).toEqual([]);

    const { data: rows } = await admin.from("notifications").select("type, user_id, market_id, monetary_proposal_id").eq("monetary_proposal_id", proposal.id).eq("type", "MONETARY_PROPOSAL_EXPIRED");
    expect(rows).toHaveLength(1);
    expect(rows![0].user_id).toBe(proposer);
    expect(rows![0].market_id).toBe(marketId);

    await runSettlementJob();
    const { data: again } = await admin.from("notifications").select("id").eq("monetary_proposal_id", proposal.id).eq("type", "MONETARY_PROPOSAL_EXPIRED");
    expect(again).toHaveLength(1);
  });

  it("settles and notifies each side exactly once even when the job runs repeatedly", async () => {
    await setPolicy({ p2p_fee_bps: 100 });
    const { fixtureId, marketId, proposer, recipient, recipientPick } = await setupPair({ recipientFunds: 1000 });
    const proposal = await send(proposer, recipientPick, 1000);
    const accepted = await acceptMonetaryProposal(proposal.id, recipient);
    expect(accepted.outcome).toBe("accepted");
    await gradeMoneyline(fixtureId, marketId, 21, 10); // proposer (YES) wins

    const first = await runSettlementJob();
    expect(first.settledWin).toBeGreaterThanOrEqual(1);
    await runSettlementJob();
    await runSettlementJob();

    const { data: notes } = await admin.from("notifications").select("type, user_id").eq("monetary_proposal_id", proposal.id).in("type", ["MONETARY_POSITION_SETTLED_WIN", "MONETARY_POSITION_SETTLED_LOSS"]);
    expect(notes).toHaveLength(2);
    expect(notes!.find((n) => n.type === "MONETARY_POSITION_SETTLED_WIN")?.user_id).toBe(proposer);
    expect(notes!.find((n) => n.type === "MONETARY_POSITION_SETTLED_LOSS")?.user_id).toBe(recipient);
  });

  it("a failed insert is never silent: the creator throws", async () => {
    const { proposer, recipientPick } = await setupPair();
    const proposal = await send(proposer, recipientPick, 500);
    const broken = { ...proposal, recipientUserId: randomUUID() }; // violates notifications.user_id's foreign key
    await expect(createMonetaryProposalReceivedNotification(broken)).rejects.toThrow(/MONETARY_PROPOSAL_RECEIVED notification insert failed/);
    expect(isDegradedResult({ failures: [] })).toBe(false);
  });
});

describe("Fee and ledger math at p2p_fee_bps = 100 (1%)", () => {
  // Fee = floor(stake * bps / 10000), charged on the LOSING stake, which equals the winner's winnings.
  // Loser pays the full stake. Winner is credited stake - fee (their own stake is released, never at risk).
  // House is credited the fee. Total value across all accounts is conserved exactly.
  const CASES = [
    { stake: 10000, fee: 100, credit: 9900 }, // 100.00 each: fee 1.00, winner nets 99.00
    { stake: 150, fee: 1, credit: 149 }, // floor(1.5) = 1
    { stake: 199, fee: 1, credit: 198 }, // floor(1.99) = 1
    { stake: 100, fee: 1, credit: 99 }, // smallest stake that pays a fee
    { stake: 99, fee: 0, credit: 99 }, // floor(0.99) = 0: no fee, and no fabricated zero-amount transaction
    { stake: 1, fee: 0, credit: 1 }, // one cent
  ];

  for (const c of CASES) {
    it(`stake ${c.stake} each → fee ${c.fee}, winner credit ${c.credit}, loser pays ${c.stake}, house +${c.fee}, nothing created or destroyed`, async () => {
      // Settlement rounding is a property of the settlement math itself, independent of the product's stake minimum ($1.00
      // in production), so the sub-minimum cases lower the configured minimum for this test only.
      await setPolicy({ p2p_fee_bps: 100, monetary_p2p_min_stake_cents: 1 });
      const { fixtureId, marketId, proposer, recipient, recipientPick } = await setupPair({ proposerFunds: c.stake + 500, recipientFunds: c.stake + 500 });
      const proposal = await send(proposer, recipientPick, c.stake);
      const accepted = await acceptMonetaryProposal(proposal.id, recipient);
      expect(accepted.outcome).toBe("accepted");
      await gradeMoneyline(fixtureId, marketId, 21, 10); // proposer wins

      const houseBefore = await houseBalance();
      const totalBefore = (await getWalletBalanceSummary(proposer)).total + (await getWalletBalanceSummary(recipient)).total + houseBefore;

      const result = await settleMonetaryPosition(accepted.position!.id);
      expect(result.outcome).toBe("settled_win");
      expect(result.settlement?.feeBps).toBe(100);
      expect(result.settlement?.feeAmount).toBe(c.fee);
      expect(result.settlement?.winnerCreditAmount).toBe(c.credit);
      expect(result.settlement!.winnerCreditAmount + result.settlement!.feeAmount).toBe(c.stake);

      const winner = await getWalletBalanceSummary(proposer);
      const loser = await getWalletBalanceSummary(recipient);
      expect(winner).toEqual({ total: c.stake + 500 + c.credit, reserved: 0, available: c.stake + 500 + c.credit });
      expect(loser).toEqual({ total: 500, reserved: 0, available: 500 });
      expect((await houseBalance()) - houseBefore).toBe(c.fee);
      expect(winner.total + loser.total + (await houseBalance())).toBe(totalBefore);

      // Ledger rows: type, direction, amount and balance_before/after reconcile exactly.
      const key = `p2p_settlement:${accepted.position!.id}`;
      const { data: txns } = await admin.from("wallet_transactions").select("type, direction, amount, balance_before, balance_after, account_type, user_id, idempotency_key").like("idempotency_key", `${key}%`);
      const byType = new Map((txns ?? []).map((t) => [t.type as string, t]));
      const loss = byType.get("p2p_position_loss")!;
      expect(loss).toMatchObject({ direction: "debit", amount: c.stake, user_id: recipient });
      expect(loss.balance_before - loss.balance_after).toBe(c.stake);
      if (c.credit > 0) {
        const win = byType.get("p2p_position_win")!;
        expect(win).toMatchObject({ direction: "credit", amount: c.credit, user_id: proposer });
        expect(win.balance_after - win.balance_before).toBe(c.credit);
      }
      if (c.fee > 0) {
        const house = byType.get("house_fee_credit")!;
        expect(house).toMatchObject({ direction: "credit", amount: c.fee, account_type: "house" });
        expect(house.balance_after - house.balance_before).toBe(c.fee);
      } else {
        expect(byType.has("house_fee_credit")).toBe(false);
      }
      expect(txns ?? []).toHaveLength(1 + (c.credit > 0 ? 1 : 0) + (c.fee > 0 ? 1 : 0));
    });
  }

  it("VOID charges no fee at 1%, returns both stakes, and writes no ledger rows", async () => {
    await setPolicy({ p2p_fee_bps: 100 });
    const { fixtureId, marketId, proposer, recipient, recipientPick } = await setupPair({ proposerFunds: 1000, recipientFunds: 1000 });
    const proposal = await send(proposer, recipientPick, 1000);
    const accepted = await acceptMonetaryProposal(proposal.id, recipient);
    await admin.from("fixtures").update({ internal_status: "CANCELLED" }).eq("id", fixtureId);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null, graded_at: new Date().toISOString() }).eq("market_id", marketId);

    const houseBefore = await houseBalance();
    const result = await settleMonetaryPosition(accepted.position!.id);
    expect(result.outcome).toBe("settled_void");
    expect(result.settlement?.feeAmount).toBe(0);
    expect(await houseBalance()).toBe(houseBefore);
    expect(await getWalletBalanceSummary(proposer)).toEqual({ total: 1000, reserved: 0, available: 1000 });
    expect(await getWalletBalanceSummary(recipient)).toEqual({ total: 1000, reserved: 0, available: 1000 });
    const { data: txns } = await admin.from("wallet_transactions").select("id").like("idempotency_key", `p2p_settlement:${accepted.position!.id}%`);
    expect(txns ?? []).toHaveLength(0);
  });

  it("the fee is snapshotted at acceptance: a later rate change never alters an already-committed Position", async () => {
    await setPolicy({ p2p_fee_bps: 100 });
    const { fixtureId, marketId, proposer, recipient, recipientPick } = await setupPair({ proposerFunds: 10000, recipientFunds: 10000 });
    const proposal = await send(proposer, recipientPick, 10000);
    const accepted = await acceptMonetaryProposal(proposal.id, recipient);
    await setPolicy({ p2p_fee_bps: 500 });
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(accepted.position!.id);
    expect(result.settlement?.feeBps).toBe(100);
    expect(result.settlement?.feeAmount).toBe(100);
  });
});

describe("Containment: monetary_p2p_enabled = false", () => {
  it("blocks new proposals and acceptances, still allows decline/withdraw to release holds, and still settles committed Positions", async () => {
    const { fixtureId, marketId, proposer, recipient, recipientPick } = await setupPair({ proposerFunds: 2000, recipientFunds: 2000 });
    const committedProposal = await send(proposer, recipientPick, 500);
    const committed = await acceptMonetaryProposal(committedProposal.id, recipient);
    expect(committed.outcome).toBe("accepted");

    const other = await createUser("other");
    const otherPick = await pick(other, marketId, "NO");
    await deposit(other, 1000);
    const pendingProposal = await send(proposer, otherPick, 300);

    await setPolicy({ monetary_p2p_enabled: false });
    const blocked = await proposeMoney(proposer, recipientPick, 100, randomUUID());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBe("monetary_p2p_disabled");
    await expect(acceptMonetaryProposal(pendingProposal.id, other)).rejects.toThrow(/monetary_p2p_disabled/);

    // The proposer can always get their hold back.
    await withdrawMonetaryProposal(pendingProposal.id, proposer);
    expect((await getReservationById(pendingProposal.proposerReservationId))?.status).toBe("RELEASED");

    // And an already-committed Position still settles.
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const settled = await settleMonetaryPosition(committed.position!.id);
    expect(settled.outcome).toBe("settled_win");
  });
});

