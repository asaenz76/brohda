/**
 * The resolver must never lose a failed CALL_BS_RESOLVED notification
 * silently. A Challenge that has just been marked RESOLVED can't be re-run
 * by a later tick, so a delivery failure has to be recorded on the run
 * summary — which the job-health layer reads as "degraded" — while the
 * resolution itself stands. Lives in its own file because it mocks the
 * notification module for the whole file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import { callBS, acceptCallBS, getChallengeById } from "@/lib/challenges/repository";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { isDegradedResult } from "@/lib/jobs/health";

vi.mock("@/lib/notifications/challenges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/challenges")>();
  return { ...actual, createChallengeResolvedNotifications: vi.fn().mockRejectedValue(new Error("simulated insert failure")) };
});

const admin = getTestAdminClient();
const createdUserIds: string[] = [];
let fixtureId: string | null = null;
let marketId: string | null = null;

async function createUser(label: string) {
  const email = `${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function pick(userId: string, market: string, selectedOutcome: "YES" | "NO") {
  const { prediction, outcome } = await setPick({
    userId,
    marketId: market,
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

afterEach(async () => {
  if (marketId) {
    const { data: rows } = await admin.from("challenges").select("id").eq("market_id", marketId);
    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length > 0) {
      await admin.from("notifications").delete().in("challenge_id", ids);
      await admin.from("challenges").delete().in("id", ids);
    }
    await admin.from("predictions").delete().eq("market_id", marketId);
    await admin.from("markets").delete().eq("id", marketId);
    marketId = null;
  }
  if (fixtureId) {
    await admin.from("fixtures").delete().eq("id", fixtureId);
    fixtureId = null;
  }
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
  createdUserIds.length = 0;
  await admin.from("platform_settings").update({ call_bs_enabled: true }).eq("id", true);
});

describe("Resolver notification failure", () => {
  it("resolves the Challenge, records the failed CALL_BS_RESOLVED delivery on the run summary, and reads as degraded", async () => {
    await admin.from("platform_settings").update({ call_bs_enabled: true }).eq("id", true);
    const { data: fixture } = await admin
      .from("fixtures")
      .insert({
        provider: "api_nfl",
        external_fixture_id: `resolver-fail-${randomUUID()}`,
        home_team_name: "Home Test NFL",
        away_team_name: "Away Test NFL",
        scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        internal_status: "NOT_STARTED",
      })
      .select("id")
      .single();
    fixtureId = fixture!.id;
    marketId = (
      await upsertMarket({
        provider: "api_nfl",
        providerMarketId: `m_${Math.random().toString(36).slice(2)}`,
        providerEventId: null,
        question: "Will the home team win?",
        description: null,
        status: "ACTIVE",
        fixtureId: fixtureId!,
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
      })
    ).id;

    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a, marketId, "YES");
    const bPick = await pick(b, marketId, "NO");
    const created = await callBS(a, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", bPick);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await resolveAcceptedChallenges();

      // The resolution itself stands…
      const resolved = await getChallengeById(created.challenge.id);
      expect(resolved?.status).toBe("RESOLVED");
      expect(resolved?.result).toBe("CHALLENGER_WON");

      // …and the lost notification is visible, with the id needed to re-send it.
      const failure = summary.failures.find((f) => f.challengeId === created.challenge.id);
      expect(failure?.error).toContain("CALL_BS_RESOLVED notification failed");
      expect(failure?.error).toContain("simulated insert failure");
      expect(isDegradedResult(summary)).toBe(true);
      expect(logged.mock.calls.some((c) => String(c[0]).includes(created.challenge.id))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});
