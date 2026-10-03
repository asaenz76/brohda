/**
 * A settlement that has committed can never be re-run (the Position is
 * terminal), so a failed settlement notification must be recorded on the job's
 * run summary — which job health reads as "degraded" — never swallowed, and
 * never allowed to undo or hide the settlement. Own file because it mocks the
 * notification module for the whole file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteMonetaryRowsForMarkets } from "./helpers/cleanup-monetary";
import { getTestAdminClient } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import { proposeMoney, acceptMonetaryProposal, getMonetaryPositionById } from "@/lib/monetary/repository";
import { runSettlementJob } from "@/lib/monetary/settlement-runner";
import { isDegradedResult } from "@/lib/jobs/health";

vi.mock("@/lib/notifications/monetary-settlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/monetary-settlements")>();
  return { ...actual, createSettlementNotifications: vi.fn().mockRejectedValue(new Error("simulated insert failure")) };
});

const admin = getTestAdminClient();
const userIds: string[] = [];
let fixtureId: string | null = null;
let marketId: string | null = null;

async function user(label: string) {
  const { data, error } = await admin.auth.admin.createUser({ email: `${label}-${randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role: "player", is_active: true });
  userIds.push(data.user.id);
  return data.user.id;
}

async function pick(userId: string, market: string, selectedOutcome: "YES" | "NO") {
  const { prediction, outcome } = await setPick({ userId, marketId: market, selectedOutcome, yesProbability: 0.6, noProbability: 0.4, marketQuestionSnapshot: "q", marketCloseAtSnapshot: null, marketStatusSnapshot: "ACTIVE", idempotencyKey: randomUUID() });
  if (!prediction) throw new Error(`pick failed: ${outcome}`);
  return prediction.id;
}

afterEach(async () => {
  if (marketId) {
    await deleteMonetaryRowsForMarkets([marketId]);
    const { data: positions } = await admin.from("monetary_positions").select("id").eq("market_id", marketId);
    const positionIds = (positions ?? []).map((r) => r.id);
    const { data: proposals } = await admin.from("monetary_proposals").select("id").eq("market_id", marketId);
    const proposalIds = (proposals ?? []).map((r) => r.id);
    if (proposalIds.length > 0) {
      await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
      if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
      await admin.from("monetary_proposals").delete().in("id", proposalIds);
    }
    if (positionIds.length > 0) await admin.from("monetary_position_settlements").delete().in("position_id", positionIds);
    await admin.from("predictions").delete().eq("market_id", marketId);
    await admin.from("markets").delete().eq("id", marketId);
    marketId = null;
  }
  if (fixtureId) {
    await admin.from("fixtures").delete().eq("id", fixtureId);
    fixtureId = null;
  }
  if (userIds.length > 0) {
    await admin.from("wallet_reservations").delete().in("user_id", userIds);
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
    userIds.length = 0;
  }
  await admin.from("platform_settings").update({ monetary_p2p_enabled: true, p2p_fee_bps: 0, monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000 }).eq("id", true);
});

describe("Settlement job: notification failure", () => {
  it("keeps the committed settlement, records the lost notification on the run summary, and reads as degraded", async () => {
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, p2p_fee_bps: 100 }).eq("id", true);
    const { data: fixture } = await admin
      .from("fixtures")
      .insert({ provider: "api_nfl", external_fixture_id: `settle-fail-${randomUUID()}`, home_team_name: "Home Test NFL", away_team_name: "Away Test NFL", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
      .select("id")
      .single();
    fixtureId = fixture!.id;
    marketId = (
      await upsertMarket({
        provider: "api_nfl", providerMarketId: `m_${Math.random().toString(36).slice(2)}`, providerEventId: null, question: "Will the home team win?", description: null, status: "ACTIVE",
        fixtureId: fixtureId!, marketTemplate: "MONEYLINE", lineValue: null, yesSide: "HOME", price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Home", no: "Away" } },
        volume24hr: null, liquidity: null, resolutionStatus: null, resolvedBy: null, resolvedOutcome: null, opensAt: null, closesAt: null, closedAt: null, ingestionSource: "test", providerMetadata: {},
      })
    ).id;

    const proposer = await user("proposer");
    const recipient = await user("recipient");
    await pick(proposer, marketId, "YES");
    const recipientPick = await pick(recipient, marketId, "NO");
    for (const u of [proposer, recipient]) {
      await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: u, p_type: "manual_deposit", p_direction: "credit", p_amount: 1000, p_admin_id: null, p_reason: "test funding", p_idempotency_key: randomUUID() });
    }
    const proposed = await proposeMoney(proposer, recipientPick, 1000, randomUUID());
    if (!proposed.ok) throw new Error("setup failed");
    const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient);
    if (!accepted.position) throw new Error("setup failed");

    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 21, away_score: 10 }).eq("id", fixtureId);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("market_id", marketId).eq("user_id", proposer);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("market_id", marketId).eq("user_id", recipient);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await runSettlementJob();

      expect((await getMonetaryPositionById(accepted.position.id))?.settlementStatus).toBe("SETTLED");
      expect(summary.settledWin).toBeGreaterThanOrEqual(1);
      const failure = summary.failures.find((f) => f.positionId === accepted.position!.id);
      expect(failure?.error).toContain("settled, but settlement notification failed");
      expect(failure?.error).toContain("simulated insert failure");
      expect(isDegradedResult(summary)).toBe(true);
      expect(logged.mock.calls.some((c) => String(c[0]).includes(accepted.position!.id))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});
