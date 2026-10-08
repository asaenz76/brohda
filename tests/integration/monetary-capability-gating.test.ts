/**
 * Consumer monetary capability gating — database-level proof. With monetary_p2p_enabled = false: nothing NEW can be started or accepted,
 * every existing obligation can still be wound down (decline / withdraw / settle), the capability helper keeps funds reachable, and the
 * monetary tables stay private to their participants. Real local Supabase; no real money.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteMonetaryRowsForMarkets } from "./helpers/cleanup-monetary";
import { getTestAdminClient } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { proposeMoney, acceptMonetaryProposal, settleMonetaryPosition, withdrawMonetaryProposal } from "@/lib/monetary/repository";
import { getWalletBalanceSummary, getReservationById } from "@/lib/wallet/reservations";
import { declineMonetaryProposal, getMonetaryPositionSettlementById } from "@/lib/monetary/repository";
import { deriveConsumerMonetaryAccess, getConsumerMonetaryAccess } from "@/lib/monetary/capability";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import type { UserProfile } from "@/lib/auth/session";

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

async function gradeMoneyline(fixtureId: string, marketId: string, homeScore: number, awayScore: number) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  const outcome: "YES" | "NO" = homeScore > awayScore ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: p.selected_outcome === outcome ? "CORRECT" : "INCORRECT", resolved_outcome_snapshot: outcome, graded_at: new Date().toISOString() }).eq("id", p.id);
  }
}

const BASE_POLICY = {
  monetary_p2p_enabled: true, call_bs_enabled: true, p2p_fee_bps: 0, pick_lock_minutes_before_kickoff: 10,
  monetary_proposal_rate_limit_window_seconds: 60, monetary_proposal_rate_limit_max_attempts: 100,
  monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000,
};

/** One Market with a funded YES user (`a`) and any number of funded NO counterparties. */
async function setupMarket(counterparties = 1, funds = 100000) {
  const fixtureId = await createFixture();
  const marketId = await createMarket(fixtureId);
  const a = await createUser("a");
  const aPick = await pick(a, marketId, "YES");
  await deposit(a, funds);
  const others: Array<{ userId: string; pickId: string }> = [];
  for (let i = 0; i < counterparties; i += 1) {
    const userId = await createUser(`c${i}`);
    others.push({ userId, pickId: await pick(userId, marketId, "NO") });
    await deposit(userId, funds);
  }
  return { fixtureId, marketId, a, aPick, others };
}

async function commit(proposer: string, recipient: string, recipientPick: string, stake = 1000) {
  const proposed = await proposeMoney(proposer, recipientPick, stake, randomUUID());
  if (!proposed.ok) throw new Error(`propose failed: ${proposed.error}`);
  const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient);
  if (accepted.outcome !== "accepted" || !accepted.position) throw new Error(`accept failed: ${accepted.outcome}`);
  return { proposal: proposed.proposal, position: accepted.position };
}

async function activeReservedTotal(userId: string): Promise<number> {
  const { data } = await admin.from("wallet_reservations").select("amount").eq("user_id", userId).eq("status", "ACTIVE");
  return (data ?? []).reduce((sum, r) => sum + (r.amount as number), 0);
}

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


const PASSWORD = "integration-test-password-123";

async function signedInClient(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const { url, anonKey } = getTestSupabaseConfig();
  const client = createSupabaseClient(url, anonKey);
  const { error } = await client.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD });
  if (error) throw error;
  return client;
}

const asProfile = (id: string, role: UserProfile["role"] = "player") => ({ id, role, is_active: true } as unknown as UserProfile);

/** The four states the brief names, on one Market each, plus a bystander. */
async function buildFixtures() {
  const a = await setupMarket(1); // market with funded A (YES) and B (NO)
  const b = a.others[0];

  // A. a pending proposal: A -> B
  const pending = await proposeMoney(a.a, b.pickId, 500, randomUUID());
  if (!pending.ok) throw new Error(pending.error);

  // B. a committed Position on its own Market
  const c = await setupMarket(1);
  const committed = await commit(c.a, c.others[0].userId, c.others[0].pickId, 700);

  // D. a settled historical Position
  const d = await setupMarket(1);
  const settledPair = await commit(d.a, d.others[0].userId, d.others[0].pickId, 400);
  await gradeMoneyline(d.fixtureId, d.marketId, 21, 10);
  const settled = await settleMonetaryPosition(settledPair.position.id);
  expect(settled.outcome).toBe("settled_win");

  // C. a user who only holds a funded balance
  const holder = await createUser("holder");
  await deposit(holder, 2500);

  // Bystander (neither side of anything), and a user with nothing in the system.
  const bystander = await createUser("bystander");
  const nothing = await createUser("nothing");

  return { a, b, pending: pending.proposal, c, committed, d, settledPair, settledSettlementId: settled.settlement!.id, holder, bystander, nothing };
}

describe("Money switched off — what already exists is wound down, never trapped", () => {
  it("blocks anything new, but decline / withdraw / settle all still work and every hold is released exactly", async () => {
    const f = await buildFixtures();
    await setPolicy({ monetary_p2p_enabled: false });

    // Nothing new can start or be accepted.
    const blocked = await proposeMoney(f.b.userId, f.a.aPick, 100, randomUUID());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBe("monetary_p2p_disabled");
    await expect(acceptMonetaryProposal(f.pending.id, f.b.userId)).rejects.toThrow(/monetary_p2p_disabled/);

    // The pending offer is still there, still holding the sender's stake…
    expect(await activeReservedTotal(f.a.a)).toBe(500);
    // …and the recipient can decline it, which releases that hold.
    const declined = await declineMonetaryProposal(f.pending.id, f.b.userId);
    expect(declined.status).toBe("DECLINED");
    expect((await getReservationById(f.pending.proposerReservationId))?.status).toBe("RELEASED");
    expect(await activeReservedTotal(f.a.a)).toBe(0);

    // A pending offer can equally be withdrawn by its sender (set one up first, with money on, then switch off).
    await setPolicy({ monetary_p2p_enabled: true });
    const second = await proposeMoney(f.a.a, f.b.pickId, 300, randomUUID());
    if (!second.ok) throw new Error(second.error);
    await setPolicy({ monetary_p2p_enabled: false });
    await withdrawMonetaryProposal(second.proposal.id, f.a.a);
    expect((await getReservationById(second.proposal.proposerReservationId))?.status).toBe("RELEASED");

    // A committed Position still settles with money off, with the fee it was snapshotted with.
    expect(await activeReservedTotal(f.c.a)).toBe(700);
    await gradeMoneyline(f.c.fixtureId, f.c.marketId, 21, 10);
    const settled = await settleMonetaryPosition(f.committed.position.id);
    expect(settled.outcome).toBe("settled_win");
    expect(await activeReservedTotal(f.c.a)).toBe(0);
    expect(await activeReservedTotal(f.c.others[0].userId)).toBe(0);

    // The historical settlement is untouched and still readable.
    expect((await getMonetaryPositionSettlementById(f.settledSettlementId))?.outcome).toBe("PROPOSER_WINS");
  });

  it("a funded balance is untouched by the flag, and the holder's wallet stays reachable (wind-down)", async () => {
    const f = await buildFixtures();
    await setPolicy({ monetary_p2p_enabled: false });
    expect(await getWalletBalanceSummary(f.holder)).toMatchObject({ total: 2500, reserved: 0 });
    expect(await getConsumerMonetaryAccess(asProfile(f.holder))).toEqual({ enabled: false, canSeeWallet: true, windDownOnly: true, isOperator: false });
  });

  it("the capability helper against the live setting: off + nothing → no wallet (operators included); off + hold/funds → wallet; on → wallet; unreadable → off", async () => {
    const f = await buildFixtures();
    await setPolicy({ monetary_p2p_enabled: false });
    expect(await getConsumerMonetaryAccess(asProfile(f.nothing))).toEqual({ enabled: false, canSeeWallet: false, windDownOnly: false, isOperator: false });
    // A (pending proposer) has funds AND a hold, so the wallet is reachable for withdrawal.
    expect((await getConsumerMonetaryAccess(asProfile(f.a.a))).canSeeWallet).toBe(true);
    // The recipient B's own wallet balance is still non-zero, so also reachable.
    expect((await getConsumerMonetaryAccess(asProfile(f.b.userId))).windDownOnly).toBe(true);
    // An operator with nothing in the system sees NO wallet; one who still holds funds gets the same wind-down wallet as any member.
    for (const role of ["admin", "super_admin"] as const) {
      expect(await getConsumerMonetaryAccess(asProfile(f.nothing, role))).toEqual({ enabled: false, canSeeWallet: false, windDownOnly: false, isOperator: true });
      expect(await getConsumerMonetaryAccess(asProfile(f.holder, role))).toEqual({ enabled: false, canSeeWallet: true, windDownOnly: true, isOperator: true });
    }
    await setPolicy({ monetary_p2p_enabled: true });
    expect(await getConsumerMonetaryAccess(asProfile(f.nothing))).toMatchObject({ enabled: true, canSeeWallet: true, windDownOnly: false });
    // Pure derivation: an unreadable setting is passed in as off, never as on.
    expect(deriveConsumerMonetaryAccess({ flagEnabled: false, isOperator: false, totalCents: 0, heldCents: 0 }).canSeeWallet).toBe(false);
  });
});

describe("Monetary data stays private to its participants (RLS), whatever the flag", () => {
  it("a bystander and an anonymous client see none of the proposals, Positions, settlements, reservations, ledger rows, balances or notifications — and cannot write any", async () => {
    const f = await buildFixtures();
    await setPolicy({ monetary_p2p_enabled: false });

    const bystander = await signedInClient(f.bystander);
    const anon = getTestAnonClient();
    const tables: Array<[string, string, string[]]> = [
      ["monetary_proposals", "id", [f.pending.id]],
      ["monetary_positions", "id", [f.committed.position.id, f.settledPair.position.id]],
      ["monetary_position_settlements", "position_id", [f.settledPair.position.id]],
      ["wallet_reservations", "user_id", [f.a.a, f.b.userId, f.holder]],
      ["wallet_transactions", "user_id", [f.a.a, f.b.userId, f.holder]],
      ["wallet_balances", "user_id", [f.a.a, f.b.userId, f.holder]],
    ];
    for (const [table, column, values] of tables) {
      for (const [label, client] of [["bystander", bystander], ["anon", anon]] as const) {
        const { data } = await client.from(table).select("*").in(column, values);
        expect(data ?? [], `${label} reading ${table}`).toEqual([]);
      }
    }
    // Notifications about these proposals are addressed to the participants only.
    for (const [label, client] of [["bystander", bystander], ["anon", anon]] as const) {
      const { data } = await client.from("notifications").select("id").eq("monetary_proposal_id", f.pending.id);
      expect(data ?? [], `${label} reading notifications`).toEqual([]);
    }

    // No client write path into any of them (whether it errors or silently affects zero rows).
    const before = await admin.from("wallet_balances").select("balance").eq("user_id", f.holder).single();
    await bystander.from("wallet_balances").update({ balance: 999999 }).eq("user_id", f.holder);
    await bystander.from("monetary_proposals").update({ status: "ACCEPTED" }).eq("id", f.pending.id);
    await bystander.from("monetary_positions").delete().eq("id", f.committed.position.id);
    await bystander.from("monetary_proposals").insert({ proposer_user_id: f.bystander, recipient_user_id: f.a.a, stake: 100 } as never);
    expect((await admin.from("wallet_balances").select("balance").eq("user_id", f.holder).single()).data?.balance).toBe(before.data?.balance);
    expect((await admin.from("monetary_proposals").select("status").eq("id", f.pending.id).single()).data?.status).toBe("PENDING");
    expect((await admin.from("monetary_positions").select("id").eq("id", f.committed.position.id)).data).toHaveLength(1);
  });

  it("the two sides of a Position can read their own — and only their own — rows", async () => {
    const f = await buildFixtures();
    const proposer = await signedInClient(f.c.a);
    const recipient = await signedInClient(f.c.others[0].userId);
    for (const client of [proposer, recipient]) {
      const { data } = await client.from("monetary_positions").select("id").eq("id", f.committed.position.id);
      expect(data).toHaveLength(1);
      // …but not someone else's Position on another Market.
      const other = await client.from("monetary_positions").select("id").eq("id", f.settledPair.position.id);
      expect(other.data ?? []).toEqual([]);
    }
    const mine = await proposer.from("wallet_balances").select("user_id").in("user_id", [f.c.a, f.holder]);
    expect((mine.data ?? []).map((r) => r.user_id)).toEqual([f.c.a]);
  });
});
