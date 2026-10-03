/**
 * Integration tests for the monetary policy controls: configurable stake
 * limits (monetary_p2p_{min,max}_stake_cents) and exactly one active
 * (COMMITTED) monetary Position per unordered user pair per Market. Real local
 * Supabase; genuinely concurrent connections for the races; no real money.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteMonetaryRowsForMarkets } from "./helpers/cleanup-monetary";
import { getTestAdminClient } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { proposeMoney, acceptMonetaryProposal, settleMonetaryPosition, withdrawMonetaryProposal } from "@/lib/monetary/repository";
import { callBS, acceptCallBS } from "@/lib/challenges/repository";
import { getWalletBalanceSummary, getReservationById } from "@/lib/wallet/reservations";
import { checkMonetaryConsistency } from "@/lib/monetary/reconciliation";
import { updateMonetarySettings } from "@/lib/admin-settings/repository";
import { getMonetaryStakeLimits } from "@/lib/monetary/policy";

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

async function committedPositionCount(marketId: string, userA: string, userB: string): Promise<number> {
  const { data } = await admin.from("monetary_positions").select("id, proposer_user_id, recipient_user_id").eq("market_id", marketId).eq("settlement_status", "COMMITTED");
  return (data ?? []).filter((p) => [p.proposer_user_id, p.recipient_user_id].sort().join() === [userA, userB].sort().join()).length;
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

describe("Stake limits — storage and validation", () => {
  it("ships configured to $1.00 / $100.00, as integer cents, and is read live", async () => {
    expect(await getMonetaryStakeLimits()).toEqual({ minStakeCents: 100, maxStakeCents: 10000 });
    await setPolicy({ monetary_p2p_min_stake_cents: 250, monetary_p2p_max_stake_cents: 5000 });
    expect(await getMonetaryStakeLimits()).toEqual({ minStakeCents: 250, maxStakeCents: 5000 });
  });

  it("the table itself rejects min <= 0, and max < min, whatever wrote the row", async () => {
    for (const bad of [{ monetary_p2p_min_stake_cents: 0 }, { monetary_p2p_min_stake_cents: -5 }, { monetary_p2p_max_stake_cents: 50 } /* below the seeded min of 100 */, { monetary_p2p_min_stake_cents: 20000 } /* above the seeded max */]) {
      const { error } = await admin.from("platform_settings").update(bad).eq("id", true);
      expect(error, JSON.stringify(bad)).not.toBeNull();
    }
    expect(await getMonetaryStakeLimits()).toEqual({ minStakeCents: 100, maxStakeCents: 10000 });
  });

  describe("through the Super Admin settings RPC", () => {
    async function currentUpdatedAt() {
      const { data } = await admin.from("platform_settings").select("updated_at").eq("id", true).single();
      return data!.updated_at as string;
    }
    const base = { monetaryP2pEnabled: true, monetaryProposalRateLimitWindowSeconds: 60, monetaryProposalRateLimitMaxAttempts: 100, p2pFeeBps: 0 };

    it("saves new limits, applies them to the next proposal, and records who/when/old/new in the existing audit log", async () => {
      const adminId = await createUser("admin", "super_admin");
      const result = await updateMonetarySettings(adminId, await currentUpdatedAt(), { ...base, monetaryP2pMinStakeCents: 300, monetaryP2pMaxStakeCents: 4000 });
      expect(result.outcome).toBe("updated");
      expect(await getMonetaryStakeLimits()).toEqual({ minStakeCents: 300, maxStakeCents: 4000 });

      const { data: logs } = await admin.from("audit_logs").select("actor_id, action, before, after, created_at").eq("actor_id", adminId).eq("action", "settings.monetary_p2p_updated");
      expect(logs).toHaveLength(1);
      expect(logs![0].before).toMatchObject({ monetaryP2pMinStakeCents: 100, monetaryP2pMaxStakeCents: 10000 });
      expect(logs![0].after).toMatchObject({ monetaryP2pMinStakeCents: 300, monetaryP2pMaxStakeCents: 4000 });
      expect(logs![0].created_at).toBeTruthy();
      await admin.from("audit_logs").delete().eq("actor_id", adminId).then(() => undefined, () => undefined);
    });

    it("rejects max below min, and zero/negative limits, with a typed error and no change", async () => {
      const adminId = await createUser("admin", "super_admin");
      for (const [min, max] of [[1000, 500], [0, 5000], [-1, 5000], [100, 0]] as const) {
        await expect(updateMonetarySettings(adminId, await currentUpdatedAt(), { ...base, monetaryP2pMinStakeCents: min, monetaryP2pMaxStakeCents: max })).rejects.toSatisfy(
          (e: unknown) => String((e as { message?: string }).message).includes("invalid_stake_limits"),
        );
      }
      expect(await getMonetaryStakeLimits()).toEqual({ minStakeCents: 100, maxStakeCents: 10000 });
    });

    it("uses the same optimistic-concurrency guard as every other setting", async () => {
      const adminId = await createUser("admin", "super_admin");
      const stale = await currentUpdatedAt();
      await updateMonetarySettings(adminId, stale, { ...base, monetaryP2pMinStakeCents: 100, monetaryP2pMaxStakeCents: 20000 });
      const conflict = await updateMonetarySettings(adminId, stale, { ...base, monetaryP2pMinStakeCents: 100, monetaryP2pMaxStakeCents: 30000 });
      expect(conflict.outcome).toBe("conflict");
      expect(await getMonetaryStakeLimits()).toEqual({ minStakeCents: 100, maxStakeCents: 20000 });
    });

    it("a non-super-admin is refused, and a caller that predates these settings (six arguments) never resets them", async () => {
      const player = await createUser("player");
      await expect(updateMonetarySettings(player, await currentUpdatedAt(), { ...base, monetaryP2pMinStakeCents: 100, monetaryP2pMaxStakeCents: 10000 })).rejects.toSatisfy(
        (e: unknown) => String((e as { message?: string }).message).includes("not_authorized"),
      );

      await setPolicy({ monetary_p2p_min_stake_cents: 200, monetary_p2p_max_stake_cents: 7000 });
      const adminId = await createUser("admin", "super_admin");
      const { error } = await admin.rpc("update_monetary_settings", {
        p_admin_id: adminId, p_expected_updated_at: await currentUpdatedAt(), p_monetary_p2p_enabled: true,
        p_monetary_proposal_rate_limit_window_seconds: 60, p_monetary_proposal_rate_limit_max_attempts: 100, p_p2p_fee_bps: 0,
      }).single();
      expect(error).toBeNull();
      expect(await getMonetaryStakeLimits()).toEqual({ minStakeCents: 200, maxStakeCents: 7000 });
    });
  });
});

describe("Stake limits — enforcement on proposals", () => {
  it("accepts exactly the minimum and exactly the maximum", async () => {
    const { a, others } = await setupMarket(2);
    const atMin = await proposeMoney(a, others[0].pickId, 100, randomUUID());
    expect(atMin.ok).toBe(true);
    const atMax = await proposeMoney(a, others[1].pickId, 10000, randomUUID());
    expect(atMax.ok).toBe(true);
  });

  it("rejects one cent below the minimum and one cent above the maximum, reserving nothing", async () => {
    const { a, others } = await setupMarket(1);
    const below = await proposeMoney(a, others[0].pickId, 99, randomUUID());
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.error).toBe("stake_below_minimum");
    const above = await proposeMoney(a, others[0].pickId, 10001, randomUUID());
    expect(above.ok).toBe(false);
    if (!above.ok) expect(above.error).toBe("stake_above_maximum");
    expect(await getWalletBalanceSummary(a)).toEqual({ total: 100000, reserved: 0, available: 100000 });
    const { data: rows } = await admin.from("monetary_proposals").select("id").eq("proposer_user_id", a);
    expect(rows ?? []).toHaveLength(0);
  });

  it("applies a changed configuration to NEW proposals immediately", async () => {
    const { a, others } = await setupMarket(1);
    await setPolicy({ monetary_p2p_min_stake_cents: 500, monetary_p2p_max_stake_cents: 2000 });
    expect((await proposeMoney(a, others[0].pickId, 300, randomUUID())).ok).toBe(false);
    expect((await proposeMoney(a, others[0].pickId, 2500, randomUUID())).ok).toBe(false);
    expect((await proposeMoney(a, others[0].pickId, 500, randomUUID())).ok).toBe(true);
  });

  it("is enforced by the function itself: the limit holds even when the direct RPC is called, and the maximum never exceeds what the balance covers", async () => {
    const { a, others } = await setupMarket(1, 5000); // $50 available, configured max is $100
    const { error } = await admin.rpc("propose_money", { p_proposer_user_id: a, p_recipient_prediction_id: others[0].pickId, p_stake: 10000, p_idempotency_key: randomUUID(), p_source_challenge_id: null }).single();
    expect(error?.message).toBe("insufficient_available_balance"); // within the max, beyond the balance
    const over = await admin.rpc("propose_money", { p_proposer_user_id: a, p_recipient_prediction_id: others[0].pickId, p_stake: 20000, p_idempotency_key: randomUUID(), p_source_challenge_id: null }).single();
    expect(over.error?.message).toBe("stake_above_maximum"); // beyond the max is refused before the balance is even consulted
  });

  it("proposal terms are immutable: a PENDING proposal created under the old limits is still acceptable after the limits change", async () => {
    const { a, others } = await setupMarket(1);
    const proposed = await proposeMoney(a, others[0].pickId, 8000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");

    await setPolicy({ monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 1000 }); // now far below that stake

    const accepted = await acceptMonetaryProposal(proposed.proposal.id, others[0].userId);
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.position?.stake).toBe(8000);
  });

  it("a committed Position is untouched by a limit change, and still settles", async () => {
    const { fixtureId, marketId, a, others } = await setupMarket(1);
    const { position } = await commit(a, others[0].userId, others[0].pickId, 8000);
    await setPolicy({ monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 100 });
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    const settled = await settleMonetaryPosition(position.id);
    expect(settled.outcome).toBe("settled_win");
    expect(settled.settlement?.stake).toBe(8000);
  });
});

describe("One active Position per exact pair per Market", () => {
  it("allows the first Position, then blocks any second proposal for the same pair — in either direction — without reserving anything", async () => {
    const { marketId, a, aPick, others } = await setupMarket(1);
    const b = others[0];
    await commit(a, b.userId, b.pickId, 1000);
    const reservedA = await activeReservedTotal(a);
    const reservedB = await activeReservedTotal(b.userId);

    const same = await proposeMoney(a, b.pickId, 1000, randomUUID());
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toBe("pair_already_has_position");

    const reverse = await proposeMoney(b.userId, aPick, 1000, randomUUID());
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) expect(reverse.error).toBe("pair_already_has_position");

    expect(await activeReservedTotal(a)).toBe(reservedA);
    expect(await activeReservedTotal(b.userId)).toBe(reservedB);
    expect(await committedPositionCount(marketId, a, b.userId)).toBe(1);
  });

  it("blocks it through the direct RPC as well — the rule lives in the database, not the app", async () => {
    const { a, aPick, others } = await setupMarket(1);
    await commit(a, others[0].userId, others[0].pickId, 1000);
    const { error } = await admin.rpc("propose_money", { p_proposer_user_id: others[0].userId, p_recipient_prediction_id: aPick, p_stake: 1000, p_idempotency_key: randomUUID(), p_source_challenge_id: null }).single();
    expect(error?.message).toBe("pair_already_has_position");
  });

  it("still allows Positions against DIFFERENT counterparties on the same Market, each at its own stake, while balance permits", async () => {
    const { marketId, a, others } = await setupMarket(3);
    await commit(a, others[0].userId, others[0].pickId, 2000);
    await commit(a, others[1].userId, others[1].pickId, 1000);
    await commit(a, others[2].userId, others[2].pickId, 500);

    const { data: positions } = await admin.from("monetary_positions").select("stake").eq("market_id", marketId).eq("proposer_user_id", a).eq("settlement_status", "COMMITTED");
    expect((positions ?? []).map((p) => p.stake).sort((x, y) => x - y)).toEqual([500, 1000, 2000]);
    expect(await getWalletBalanceSummary(a)).toEqual({ total: 100000, reserved: 3500, available: 96500 });
  });

  it("allows the same pair on a DIFFERENT Market", async () => {
    const first = await setupMarket(1);
    await commit(first.a, first.others[0].userId, first.others[0].pickId, 1000);

    const secondMarketId = await createMarket(await createFixture());
    await pick(first.a, secondMarketId, "YES");
    const otherPick = await pick(first.others[0].userId, secondMarketId, "NO");
    const second = await proposeMoney(first.a, otherPick, 1000, randomUUID());
    expect(second.ok).toBe(true);
  });

  it("a pending proposal does not stop a DIFFERENT pair, and a withdrawn one frees the pair to try again", async () => {
    const { a, others } = await setupMarket(2);
    const p1 = await proposeMoney(a, others[0].pickId, 1000, randomUUID());
    if (!p1.ok) throw new Error("setup failed");
    expect((await proposeMoney(a, others[1].pickId, 1000, randomUUID())).ok).toBe(true);
    await withdrawMonetaryProposal(p1.proposal.id, a);
    expect((await proposeMoney(a, others[0].pickId, 1000, randomUUID())).ok).toBe(true);
  });

  it("keeps pending-pair exclusivity unordered: A→B pending blocks B→A pending", async () => {
    const { a, aPick, others } = await setupMarket(1);
    const forward = await proposeMoney(a, others[0].pickId, 1000, randomUUID());
    expect(forward.ok).toBe(true);
    const reverse = await proposeMoney(others[0].userId, aPick, 1000, randomUUID());
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) expect(reverse.error).toBe("duplicate_pending_proposal");
    expect(await activeReservedTotal(others[0].userId)).toBe(0);
  });

  it("terminal states: once SETTLED the pair's Market is graded, so canonical eligibility blocks a new proposal (no extra history ban needed)", async () => {
    const { fixtureId, marketId, a, aPick, others } = await setupMarket(1);
    const { position } = await commit(a, others[0].userId, others[0].pickId, 1000);
    await gradeMoneyline(fixtureId, marketId, 21, 10);
    expect((await settleMonetaryPosition(position.id)).outcome).toBe("settled_win");

    const again = await proposeMoney(a, others[0].pickId, 1000, randomUUID());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("pick_already_graded");
    const reverse = await proposeMoney(others[0].userId, aPick, 1000, randomUUID());
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) expect(reverse.error).toBe("pick_already_graded");
  });

  describe("database backstop (the unique index itself)", () => {
    /** Builds a second COMMITTED Position row for a pair directly, bypassing every RPC — what a buggy future code path would do. */
    async function forceInsertPosition(opts: { marketId: string; proposer: string; recipient: string; proposerPick: string; recipientPick: string; status?: string }) {
      const reserve = async (userId: string) => {
        const { data, error } = await admin.rpc("reserve_funds", { p_user_id: userId, p_amount: 100, p_purpose: "monetary_position", p_idempotency_key: randomUUID() }).single();
        if (error) throw error;
        return (data as { id: string }).id;
      };
      const proposerReservation = await reserve(opts.proposer);
      const recipientReservation = await reserve(opts.recipient);
      const { data: proposal, error: proposalError } = await admin
        .from("monetary_proposals")
        .insert({
          market_id: opts.marketId, proposer_user_id: opts.proposer, recipient_user_id: opts.recipient,
          proposer_prediction_id: opts.proposerPick, recipient_prediction_id: opts.recipientPick,
          proposer_selection_snapshot: "YES", recipient_selection_snapshot: "NO", stake: 100,
          proposer_reservation_id: proposerReservation, status: "EXPIRED", expired_at: new Date().toISOString(), idempotency_key: randomUUID(),
        })
        .select("id")
        .single();
      if (proposalError) throw proposalError;
      return admin.from("monetary_positions").insert({
        proposal_id: proposal!.id, market_id: opts.marketId, proposer_user_id: opts.proposer, recipient_user_id: opts.recipient,
        proposer_prediction_id: opts.proposerPick, recipient_prediction_id: opts.recipientPick,
        proposer_selection_snapshot: "YES", recipient_selection_snapshot: "NO", stake: 100,
        proposer_reservation_id: proposerReservation, recipient_reservation_id: recipientReservation, fee_bps: 0,
        settlement_status: opts.status ?? "COMMITTED",
        ...(opts.status && opts.status !== "COMMITTED" ? { settled_at: new Date().toISOString(), settlement_id: null } : {}),
      });
    }

    it("a second COMMITTED Position for the pair cannot exist, in the same or the swapped column order", async () => {
      const { marketId, a, aPick, others } = await setupMarket(1);
      const b = others[0];
      await commit(a, b.userId, b.pickId, 1000);

      const same = await forceInsertPosition({ marketId, proposer: a, recipient: b.userId, proposerPick: aPick, recipientPick: b.pickId });
      expect(same.error?.code).toBe("23505");
      expect(same.error?.message).toContain("monetary_positions_one_committed_pair");

      const swapped = await forceInsertPosition({ marketId, proposer: b.userId, recipient: a, proposerPick: b.pickId, recipientPick: aPick });
      expect(swapped.error?.code).toBe("23505");
      expect(await committedPositionCount(marketId, a, b.userId)).toBe(1);
    });
  });

  it("Call BS stays independent: one accepted free Call BS plus several monetary Positions on the same Market coexist, including with the same person", async () => {
    const { marketId, a, aPick, others } = await setupMarket(2);
    const challenge = await callBS(a, others[0].pickId);
    if (!challenge.ok) throw new Error("callBS failed");
    expect((await acceptCallBS(challenge.challenge.id, others[0].userId)).outcome).toBe("accepted");

    await commit(a, others[0].userId, others[0].pickId, 1000); // money with the Call BS partner
    await commit(a, others[1].userId, others[1].pickId, 1000); // money with someone else
    expect(await committedPositionCount(marketId, a, others[0].userId)).toBe(1);
    expect(await committedPositionCount(marketId, a, others[1].userId)).toBe(1);
    expect(aPick).toBeTruthy();
    // …and a second money Position with the Call BS partner is still blocked: Call BS doesn't create a money slot.
    const dup = await proposeMoney(a, others[0].pickId, 1000, randomUUID());
    expect(dup.ok).toBe(false);
  });
});

describe("Pair exclusivity under real concurrency", () => {
  it("two simultaneous sends for the same pair in the same direction: exactly one proposal, one reservation", async () => {
    const { a, others } = await setupMarket(1);
    const results = await Promise.all([proposeMoney(a, others[0].pickId, 1000, randomUUID()), proposeMoney(a, others[0].pickId, 1000, randomUUID())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    if (loser && !loser.ok) expect(loser.error).toBe("duplicate_pending_proposal");
    expect(await activeReservedTotal(a)).toBe(1000);
    expect(await getWalletBalanceSummary(a)).toEqual({ total: 100000, reserved: 1000, available: 99000 });
  });

  it("two simultaneous sends in OPPOSITE directions: exactly one wins, the loser's hold is released, nothing orphaned", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { a, aPick, others } = await setupMarket(1);
      const b = others[0];
      const [forward, reverse] = await Promise.all([proposeMoney(a, b.pickId, 1000, randomUUID()), proposeMoney(b.userId, aPick, 1000, randomUUID())]);
      expect([forward.ok, reverse.ok].filter(Boolean), `round ${round}`).toHaveLength(1);
      const winnerIsForward = forward.ok;
      expect(await activeReservedTotal(a), `round ${round}: a`).toBe(winnerIsForward ? 1000 : 0);
      expect(await activeReservedTotal(b.userId), `round ${round}: b`).toBe(winnerIsForward ? 0 : 1000);
    }
  });

  it("accept racing a reverse-direction send: the pair never ends with two commitments or a pending proposal beside a Position, and no hold leaks", async () => {
    for (let round = 0; round < 8; round += 1) {
      const { marketId, a, aPick, others } = await setupMarket(1);
      const b = others[0];
      const first = await proposeMoney(a, b.pickId, 1000, randomUUID());
      if (!first.ok) throw new Error("setup failed");

      const [accepted, counter] = await Promise.all([acceptMonetaryProposal(first.proposal.id, b.userId), proposeMoney(b.userId, aPick, 1000, randomUUID())]);
      expect(accepted.outcome, `round ${round}`).toBe("accepted");
      expect(counter.ok, `round ${round}: the counter-proposal must never succeed`).toBe(false);
      if (!counter.ok) expect(["duplicate_pending_proposal", "pair_already_has_position"], `round ${round}`).toContain(counter.error);

      expect(await committedPositionCount(marketId, a, b.userId), `round ${round}`).toBe(1);
      const { data: pending } = await admin.from("monetary_proposals").select("id").eq("market_id", marketId).eq("status", "PENDING");
      expect(pending ?? [], `round ${round}: no pending proposal beside a committed Position`).toHaveLength(0);
      expect(await activeReservedTotal(a), `round ${round}: a`).toBe(1000);
      expect(await activeReservedTotal(b.userId), `round ${round}: b`).toBe(1000);
    }
  });

  it("different pairs on one Market proceed in parallel without blocking or deadlocking each other", async () => {
    const { a, others } = await setupMarket(4);
    const proposals = await Promise.all(others.map((o) => proposeMoney(a, o.pickId, 1000, randomUUID())));
    expect(proposals.every((p) => p.ok)).toBe(true);
    const accepts = await Promise.all(proposals.map((p, i) => acceptMonetaryProposal((p as { ok: true; proposal: { id: string } }).proposal.id, others[i].userId)));
    expect(accepts.every((r) => r.outcome === "accepted")).toBe(true);
    expect(await activeReservedTotal(a)).toBe(4000);
  });

  it("leaves reconciliation clean after all of the above", async () => {
    const report = await checkMonetaryConsistency();
    expect(report.anomalies).toEqual([]);
    void getReservationById;
  });
});
