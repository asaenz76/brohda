/**
 * Integration tests for Milestone R10 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * P2P Settlement) — settle_monetary_position(), the fee snapshot R10
 * added to accept_monetary_proposal() (R9), reconciliation, and security.
 * Real local Supabase throughout. No real money — local-only wallet
 * fixtures and direct grading helpers, mirroring
 * tests/integration/monetary-challenge-position.test.ts's own conventions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { proposeMoney, acceptMonetaryProposal, settleMonetaryPosition, getMonetaryPositionById } from "@/lib/monetary/repository";
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
      external_fixture_id: `r10-fixture-${randomUUID()}`,
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

async function createUser(label = "r10") {
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

async function houseBalance(): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("balance").eq("account_type", "house").single();
  return data!.balance as number;
}

/** MONEYLINE-only grading, mirroring lib/predictions/sports-resolution.ts's own rule directly against the two test Predictions (no need to import the app's TS module — this stays a thin, obviously-correct mirror rather than a second implementation the tests could accidentally validate against itself). */
async function gradeMoneyline(fixtureId: string, marketId: string, homeScore: number, awayScore: number, yesSide: "HOME" | "AWAY" = "HOME") {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  const yesWon = yesSide === "HOME" ? homeScore > awayScore : awayScore > homeScore;
  const outcome: "YES" | "NO" | "VOID" = homeScore === awayScore ? "VOID" : yesWon ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    const result = outcome === "VOID" ? "VOID" : p.selected_outcome === outcome ? "CORRECT" : "INCORRECT";
    const resolvedOutcomeSnapshot = outcome === "VOID" ? null : outcome;
    await admin
      .from("predictions")
      .update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: resolvedOutcomeSnapshot, graded_at: new Date().toISOString() })
      .eq("id", p.id);
  }
  return outcome;
}

async function gradeVoid(predictionIds: string[]) {
  await admin
    .from("predictions")
    .update({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null, graded_at: new Date().toISOString() })
    .in("id", predictionIds);
}

/** Standard fixture: two opposing, funded users with a committed Position. */
async function setupCommittedPosition(stake = 1000) {
  const fixtureId = await createFixture();
  const marketId = await createMarket(fixtureId);
  const proposer = await createUser("proposer");
  const recipient = await createUser("recipient");
  await deposit(proposer.userId, stake);
  await deposit(recipient.userId, stake);
  const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
  const recipientPredictionId = await pick(recipient.userId, marketId, "NO");
  const proposed = await proposeMoney(proposer.userId, recipientPredictionId, stake, randomUUID());
  if (!proposed.ok) throw new Error("setup failed: " + proposed.error);
  const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
  if (accepted.outcome !== "accepted" || !accepted.position) throw new Error("setup failed: acceptance");
  return { fixtureId, marketId, proposer, recipient, proposerPredictionId, recipientPredictionId, position: accepted.position };
}

beforeEach(async () => {
  await setPolicy({
    monetary_p2p_enabled: true,
    p2p_fee_bps: 0,
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
    // monetary_positions.settlement_id is a real FK into
    // monetary_position_settlements — the position (referencing row) must
    // be deleted (or its settlement_id nulled) BEFORE the settlement
    // (referenced row) it points to, or the settlement delete violates
    // that FK. Doing it in the wrong order here previously failed silently
    // (the delete's own error was never checked), leaking settlement rows
    // across tests and confusing later reconciliation assertions.
    const { data: proposalRows } = await admin.from("monetary_proposals").select("id").in("market_id", createdMarketIds);
    const proposalIds = (proposalRows ?? []).map((r) => r.id);
    if (proposalIds.length > 0) {
      await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
      if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
      await admin.from("monetary_proposals").delete().in("id", proposalIds);
    }
    if (positionIds.length > 0) {
      await admin.from("monetary_position_settlements").delete().in("position_id", positionIds);
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
});

describe("Fee snapshot (accept_monetary_proposal extension)", () => {
  it("snapshots the current platform p2p_fee_bps onto the Position at commitment", async () => {
    await setPolicy({ p2p_fee_bps: 250 });
    const { position } = await setupCommittedPosition(1000);
    expect(position.feeBps).toBe(250);
  });

  it("a later platform fee-rate change never alters an already-committed Position's snapshot", async () => {
    await setPolicy({ p2p_fee_bps: 250 });
    const { position } = await setupCommittedPosition(1000);
    await setPolicy({ p2p_fee_bps: 9999 });
    const refetched = await getMonetaryPositionById(position.id);
    expect(refetched?.feeBps).toBe(250);
  });

  it("defaults to 0 when no fee is configured", async () => {
    const { position } = await setupCommittedPosition(1000);
    expect(position.feeBps).toBe(0);
  });
});

describe("WIN settlement", () => {
  it("the proposer wins: winner reservation released, loser reservation consumed, full stake credited at zero fee", async () => {
    const { proposer, recipient, fixtureId, marketId, position } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);

    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("settled_win");
    expect(result.settlement?.outcome).toBe("PROPOSER_WINS");
    expect(result.settlement?.winnerUserId).toBe(proposer.userId);
    expect(result.settlement?.loserUserId).toBe(recipient.userId);
    expect(result.settlement?.feeAmount).toBe(0);
    expect(result.settlement?.winnerCreditAmount).toBe(1000);
    expect(result.settlement?.marketResult).toBe("YES");
    expect(result.settlement?.proposerReservationOutcome).toBe("RELEASED");
    expect(result.settlement?.recipientReservationOutcome).toBe("CONSUMED");
    expect(result.position.settlementStatus).toBe("SETTLED");
    expect(result.position.settledAt).not.toBeNull();

    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 2000, reserved: 0, available: 2000 });
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 0, reserved: 0, available: 0 });

    const winnerReservation = await getReservationById(position.proposerReservationId);
    const loserReservation = await getReservationById(position.recipientReservationId);
    expect(winnerReservation?.status).toBe("RELEASED");
    expect(loserReservation?.status).toBe("CONSUMED");
  });

  it("the recipient wins", async () => {
    const { proposer, recipient, fixtureId, marketId, position } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 7, 14);

    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("settled_win");
    expect(result.settlement?.outcome).toBe("RECIPIENT_WINS");
    expect(result.settlement?.winnerUserId).toBe(recipient.userId);
    expect(result.settlement?.loserUserId).toBe(proposer.userId);
    expect(result.settlement?.marketResult).toBe("NO");
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 2000, reserved: 0, available: 2000 });
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 0, reserved: 0, available: 0 });
  });

  it("applies the Position's own snapshotted fee, crediting the house account exactly", async () => {
    await setPolicy({ p2p_fee_bps: 500 }); // 5%
    const { proposer, recipient, fixtureId, marketId, position } = await setupCommittedPosition(1000);
    const houseBefore = await houseBalance();

    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(position.id);

    expect(result.settlement?.feeBps).toBe(500);
    expect(result.settlement?.feeAmount).toBe(50);
    expect(result.settlement?.winnerCreditAmount).toBe(950);
    expect((await houseBalance()) - houseBefore).toBe(50);
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 1950, reserved: 0, available: 1950 });
    expect(recipient.userId).toBeTruthy();
  });

  it("integer floor rounding on the fee, never fractional cents", async () => {
    await setPolicy({ p2p_fee_bps: 333 }); // 3.33%
    const { fixtureId, marketId, position } = await setupCommittedPosition(999);
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(position.id);
    // floor(999 * 333 / 10000) = floor(33.2667) = 33
    expect(result.settlement?.feeAmount).toBe(33);
    expect(result.settlement?.winnerCreditAmount).toBe(966);
  });

  it("never fabricates a house-fee transaction when fee is zero", async () => {
    const { fixtureId, marketId, position } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(position.id);
    expect(result.settlement?.houseFeeTransactionId).toBeNull();
  });
});

describe("VOID settlement", () => {
  it("a push (exact spread equality) releases both reservations, transfers nothing, charges no fee", async () => {
    await setPolicy({ p2p_fee_bps: 500 });
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { marketTemplate: "SPREAD", lineValue: 3 });
    const proposer = await createUser("proposerV");
    const recipient = await createUser("recipientV");
    await deposit(proposer.userId, 1000);
    await deposit(recipient.userId, 1000);
    const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
    const recipientPredictionId = await pick(recipient.userId, marketId, "NO");
    const proposed = await proposeMoney(proposer.userId, recipientPredictionId, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
    if (accepted.outcome !== "accepted" || !accepted.position) throw new Error("setup failed");

    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 13, away_score: 10 }).eq("id", fixtureId);
    await gradeVoid([proposerPredictionId, recipientPredictionId]);

    const before = { p: await getWalletBalanceSummary(proposer.userId), r: await getWalletBalanceSummary(recipient.userId) };
    const result = await settleMonetaryPosition(accepted.position.id);
    expect(result.outcome).toBe("settled_void");
    expect(result.settlement?.outcome).toBe("VOID");
    expect(result.settlement?.winnerUserId).toBeNull();
    expect(result.settlement?.loserUserId).toBeNull();
    expect(result.settlement?.feeAmount).toBe(0);
    expect(result.settlement?.winnerCreditAmount).toBe(0);
    expect(result.position.settlementStatus).toBe("VOIDED");

    const after = { p: await getWalletBalanceSummary(proposer.userId), r: await getWalletBalanceSummary(recipient.userId) };
    expect(after.p).toEqual({ ...before.p, reserved: 0, available: before.p.total });
    expect(after.r).toEqual({ ...before.r, reserved: 0, available: before.r.total });
  });

  it("a cancelled Game (fixture CANCELLED) also voids", async () => {
    const { proposer, recipient, fixtureId, marketId, position, proposerPredictionId, recipientPredictionId } = await setupCommittedPosition(1000);
    await admin.from("fixtures").update({ internal_status: "CANCELLED" }).eq("id", fixtureId);
    await gradeVoid([proposerPredictionId, recipientPredictionId]);

    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("settled_void");
    expect(marketId).toBeTruthy();
    expect(proposer.userId).toBeTruthy();
    expect(recipient.userId).toBeTruthy();
  });
});

describe("Eligibility / no-op paths", () => {
  it("is not_eligible while the fixture is still NOT_STARTED, and mutates nothing", async () => {
    const { position } = await setupCommittedPosition(1000);
    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("not_eligible");
    expect(result.settlement).toBeNull();
    const refetched = await getMonetaryPositionById(position.id);
    expect(refetched?.settlementStatus).toBe("COMMITTED");
  });

  it("is not_eligible while the Game is POSTPONED (never treated as VOID)", async () => {
    const { fixtureId, position } = await setupCommittedPosition(1000);
    await admin.from("fixtures").update({ internal_status: "POSTPONED" }).eq("id", fixtureId);
    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("not_eligible");
  });

  it("only one Pick graded is still not_eligible", async () => {
    const { proposerPredictionId, position } = await setupCommittedPosition(1000);
    await admin
      .from("predictions")
      .update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() })
      .eq("id", proposerPredictionId);
    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("not_eligible");
  });
});

describe("Idempotency and concurrency", () => {
  it("retrying an already-settled Position returns the same settlement without any further mutation", async () => {
    const { fixtureId, marketId, position, proposer } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const first = await settleMonetaryPosition(position.id);
    const retry = await settleMonetaryPosition(position.id);
    expect(retry.outcome).toBe("already_settled");
    expect(retry.settlement?.id).toBe(first.settlement?.id);
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 2000, reserved: 0, available: 2000 });
  });

  it("two concurrent settlement attempts on the same Position resolve to exactly one settled_win", async () => {
    const { fixtureId, marketId, position, proposer } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);

    const [r1, r2] = await Promise.all([settleMonetaryPosition(position.id), settleMonetaryPosition(position.id)]);
    const outcomes = [r1.outcome, r2.outcome];
    expect(outcomes.filter((o) => o === "settled_win")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_settled")).toHaveLength(1);

    const { data: settlements } = await admin.from("monetary_position_settlements").select("id").eq("position_id", position.id);
    expect(settlements ?? []).toHaveLength(1);
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 2000, reserved: 0, available: 2000 });
  });

  it("settles correctly even when the loser has spent every other available cent", async () => {
    const { proposer, recipient, fixtureId, marketId, position } = await setupCommittedPosition(1000);
    // Recipient (about to lose) deposits extra, unrelated funds and spends them all — their Position reservation must remain untouched by this.
    await deposit(recipient.userId, 500);
    const { error: debitError } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: recipient.userId,
      p_type: "pool_entry_debit",
      p_direction: "debit",
      p_amount: 500,
      p_admin_id: null,
      p_reason: "unrelated spend",
      p_idempotency_key: randomUUID(),
    });
    expect(debitError).toBeNull();
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 1000, reserved: 1000, available: 0 });

    await gradeMoneyline(fixtureId, marketId, 21, 10); // proposer wins, recipient loses
    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("settled_win");
    expect(await getWalletBalanceSummary(recipient.userId)).toEqual({ total: 0, reserved: 0, available: 0 });
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 2000, reserved: 0, available: 2000 });
  });

  it("multiple Positions on the same Pick settle independently", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("aMulti");
    const b = await createUser("bMulti");
    const c = await createUser("cMulti");
    await deposit(a.userId, 2000);
    await deposit(b.userId, 1000);
    await deposit(c.userId, 1000);
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const cPick = await pick(c.userId, marketId, "NO");
    const p1 = await proposeMoney(a.userId, bPick, 1000, randomUUID());
    const p2 = await proposeMoney(a.userId, cPick, 1000, randomUUID());
    if (!p1.ok || !p2.ok) throw new Error("setup failed");
    const accept1 = await acceptMonetaryProposal(p1.proposal.id, b.userId);
    const accept2 = await acceptMonetaryProposal(p2.proposal.id, c.userId);
    if (accept1.outcome !== "accepted" || !accept1.position || accept2.outcome !== "accepted" || !accept2.position) throw new Error("setup failed");

    await gradeMoneyline(fixtureId, marketId, 10, 0);

    const result1 = await settleMonetaryPosition(accept1.position.id);
    expect(result1.outcome).toBe("settled_win");
    const untouched = await getMonetaryPositionById(accept2.position.id);
    expect(untouched?.settlementStatus).toBe("COMMITTED");
    const result2 = await settleMonetaryPosition(accept2.position.id);
    expect(result2.outcome).toBe("settled_win");
  });
});

describe("Feature gate", () => {
  it("settlement of an already-committed Position still works while monetary_p2p_enabled is false", async () => {
    const { fixtureId, marketId, position, proposer } = await setupCommittedPosition(1000);
    await setPolicy({ monetary_p2p_enabled: false });
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("settled_win");
    expect(await getWalletBalanceSummary(proposer.userId)).toEqual({ total: 2000, reserved: 0, available: 2000 });
  });
});

describe("Position immutability at settlement time", () => {
  it("settlement is unaffected by Market line movement that happened before settlement ran", async () => {
    const { fixtureId, marketId, position } = await setupCommittedPosition(1000);
    await admin.from("markets").update({ yes_price: 0.99, no_price: 0.01 }).eq("id", marketId);
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(position.id);
    expect(result.outcome).toBe("settled_win");
    expect(result.settlement?.stake).toBe(1000);
  });
});

describe("Reconciliation", () => {
  it("finds no anomalies across a mix of unsettled, WIN, and VOID Positions", async () => {
    const winSetup = await setupCommittedPosition(1000);
    await gradeMoneyline(winSetup.fixtureId, winSetup.marketId, 21, 10);
    await settleMonetaryPosition(winSetup.position.id);

    const voidFixtureId = await createFixture();
    const voidMarketId = await createMarket(voidFixtureId, { marketTemplate: "SPREAD", lineValue: 3 });
    const vp = await createUser("vp");
    const vr = await createUser("vr");
    await deposit(vp.userId, 1000);
    await deposit(vr.userId, 1000);
    const vpPred = await pick(vp.userId, voidMarketId, "YES");
    const vrPred = await pick(vr.userId, voidMarketId, "NO");
    const voidProposal = await proposeMoney(vp.userId, vrPred, 1000, randomUUID());
    if (!voidProposal.ok) throw new Error("setup failed");
    const voidAccept = await acceptMonetaryProposal(voidProposal.proposal.id, vr.userId);
    if (voidAccept.outcome !== "accepted" || !voidAccept.position) throw new Error("setup failed");
    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 13, away_score: 10 }).eq("id", voidFixtureId);
    await gradeVoid([vpPred, vrPred]);
    await settleMonetaryPosition(voidAccept.position.id);

    await setupCommittedPosition(500); // stays unsettled (unresolved fixture)

    const report = await checkMonetaryConsistency();
    expect(report.anomalies).toEqual([]);
  });
});

describe("Security", () => {
  it("no authenticated client can call settle_monetary_position directly (service_role only)", async () => {
    const { fixtureId, marketId, position } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);

    const outsider = await createUser("secOutsider");
    const { error } = await outsider.client.rpc("settle_monetary_position", { p_position_id: position.id });
    expect(error).not.toBeNull();
  });

  it("an authenticated client cannot write monetary_position_settlements directly", async () => {
    const { fixtureId, marketId, position, proposer, recipient } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);

    const { data: insertData } = await proposer.client
      .from("monetary_position_settlements")
      .insert({
        position_id: position.id,
        market_id: marketId,
        proposer_user_id: proposer.userId,
        recipient_user_id: recipient.userId,
        outcome: "PROPOSER_WINS",
        winner_user_id: proposer.userId,
        loser_user_id: recipient.userId,
        stake: 1000,
        fee_bps: 0,
        market_result: "YES",
        proposer_prediction_result: "CORRECT",
        recipient_prediction_result: "INCORRECT",
        proposer_reservation_outcome: "RELEASED",
        recipient_reservation_outcome: "CONSUMED",
        idempotency_key: randomUUID(),
      })
      .select();
    expect(insertData ?? []).toHaveLength(0);
  });

  it("participants can read their own settlement via RLS; an outsider cannot, even after settlement — no public-record exception", async () => {
    const { fixtureId, marketId, position, proposer, recipient } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(position.id);
    const outsider = await createUser("secOutsider2");

    const { data: proposerView } = await proposer.client.from("monetary_position_settlements").select("id").eq("id", result.settlement!.id);
    expect(proposerView).toHaveLength(1);
    const { data: recipientView } = await recipient.client.from("monetary_position_settlements").select("id").eq("id", result.settlement!.id);
    expect(recipientView).toHaveLength(1);
    const { data: outsiderView } = await outsider.client.from("monetary_position_settlements").select("id").eq("id", result.settlement!.id);
    expect(outsiderView ?? []).toHaveLength(0);
  });

  it("anon cannot read monetary_position_settlements at all", async () => {
    const { fixtureId, marketId, position } = await setupCommittedPosition(1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const result = await settleMonetaryPosition(position.id);

    const anon = getTestAnonClient();
    const { data } = await anon.from("monetary_position_settlements").select("id").eq("id", result.settlement!.id);
    expect(data ?? []).toEqual([]);
  });
});
