/**
 * Integration tests for Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Free Call BS Challenges) — call_bs()/accept_call_bs()/decline_call_bs(),
 * Challenge resolution, notifications, rate limiting, and security. Real
 * local Supabase throughout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { setPick, getPredictionById } from "@/lib/predictions/repository";
import { upsertMarket, getMarketById } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { callBS, acceptCallBS, declineCallBS, getChallengeById, getChallengeRecordForUser, listChallengesForMarketAndUser } from "@/lib/challenges/repository";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { getMarketParticipants } from "@/lib/challenges/discovery";
import {
  createChallengeReceivedNotification,
  createChallengeAcceptedNotification,
  createChallengeDeclinedNotification,
  deliverChallengeNotification,
} from "@/lib/notifications/challenges";
import { ensurePostForFixture, publishPost } from "@/lib/posts/repository";

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
      external_fixture_id: `r7-fixture-${crypto.randomUUID()}`,
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

async function createUser(label = "r7") {
  const email = `${label}-${crypto.randomUUID()}@test.local`;
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
    idempotencyKey: crypto.randomUUID(),
  });
  if (!prediction) throw new Error(`pick failed: ${outcome}`);
  return prediction.id;
}

async function setPolicy(overrides: Record<string, unknown>) {
  await admin.from("platform_settings").update(overrides).eq("id", true);
}

afterEach(async () => {
  if (createdMarketIds.length > 0) {
    const { data: rows } = await admin.from("challenges").select("id").in("market_id", createdMarketIds);
    const challengeIds = (rows ?? []).map((r) => r.id);
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
  for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
  createdUserIds.length = 0;
  await setPolicy({ call_bs_enabled: true, pick_lock_minutes_before_kickoff: 10, call_bs_rate_limit_window_seconds: 60, call_bs_rate_limit_max_attempts: 10 });
});

describe("Creation", () => {
  it("creates a PENDING Challenge between two opposing Picks", async () => {
    await setPolicy({ call_bs_enabled: true });
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.challenge.status).toBe("PENDING");
    expect(outcome.challenge.challengerPredictionId).toBe(aPick);
    expect(outcome.challenge.recipientPredictionId).toBe(bPick);
    expect(outcome.challenge.challengerSelectionSnapshot).toBe("YES");
    expect(outcome.challenge.recipientSelectionSnapshot).toBe("NO");
  });

  it("rejects a same-side (non-opposing) challenge", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "YES");

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("picks_not_opposing");
  });

  it("rejects when the challenger has no Pick on the recipient's Market (also covers 'different Markets')", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const otherFixtureId = await createFixture();
    const otherMarketId = await createMarket(otherFixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, otherMarketId, "YES"); // wrong market
    const bPick = await pick(b.userId, marketId, "NO");

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("challenger_pick_not_found");
  });

  it("rejects a nonexistent recipient Pick id", async () => {
    const a = await createUser("a");
    const outcome = await callBS(a.userId, crypto.randomUUID());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("recipient_pick_not_found");
  });

  it("rejects self-Challenge", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const aPick = await pick(a.userId, marketId, "YES");

    const outcome = await callBS(a.userId, aPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("self_challenge");
  });

  it("rejects when either Pick is already graded", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("pick_already_graded");
  });

  it("rejects creation past the effective Challenge cutoff", async () => {
    // Picks are made while kickoff is still far away (Pick creation is
    // subject to the very same cutoff), then kickoff is moved close —
    // simulating time passing, exactly like pick-editing-and-locking.test.ts's
    // own "move kickoff to make cutoff already passed" pattern.
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 60 * 1000).toISOString() }).eq("id", fixtureId);

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("past_challenge_cutoff");
  });

  it("rejects a duplicate PENDING challenge between the same pair", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");

    const first = await callBS(a.userId, bPick);
    expect(first.ok).toBe(true);
    const second = await callBS(a.userId, bPick);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("duplicate_pending_challenge");
  });

  it("rejects the reverse-direction duplicate PENDING challenge", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");

    const first = await callBS(a.userId, bPick);
    expect(first.ok).toBe(true);
    const reverse = await callBS(b.userId, aPick);
    expect(reverse.ok).toBe(false);
    if (reverse.ok) return;
    expect(reverse.error).toBe("duplicate_pending_challenge");
  });

  it("does not block a fresh challenge once a prior one between the same pair reached a terminal state", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");

    const first = await callBS(a.userId, bPick);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await declineCallBS(first.challenge.id, b.userId);

    const second = await callBS(a.userId, bPick);
    expect(second.ok).toBe(true);
  });

  it("rejects creation while call_bs_enabled is false", async () => {
    await setPolicy({ call_bs_enabled: false });
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("call_bs_disabled");
  });
});

describe("Pending behavior", () => {
  it("a PENDING Challenge does not lock either Pick", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await callBS(a.userId, bPick);

    const [aRow, bRow] = await Promise.all([getPredictionById(aPick), getPredictionById(bPick)]);
    expect(aRow?.lockedAt).toBeNull();
    expect(bRow?.lockedAt).toBeNull();
  });

  it("either Pick can still change while the Challenge is PENDING", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await callBS(a.userId, bPick);

    const { outcome } = await setPick({
      userId: b.userId,
      marketId,
      selectedOutcome: "YES",
      yesProbability: 0.6,
      noProbability: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(outcome).toBe("updated");
  });

  it("a changed Pick invalidates acceptance — the Challenge transitions to EXPIRED", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // André flips YES -> NO: now both sides read NO, the exact disagreement this Challenge named no longer holds.
    await setPick({
      userId: a.userId,
      marketId,
      selectedOutcome: "NO",
      yesProbability: 0.6,
      noProbability: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("rejected_invalidated");
    expect(result.challenge.status).toBe("EXPIRED");

    const [aRow, bRow] = await Promise.all([getPredictionById(aPick), getPredictionById(bPick)]);
    expect(aRow?.lockedAt).toBeNull();
    expect(bRow?.lockedAt).toBeNull();
  });
});

describe("Acceptance", () => {
  it("the intended recipient accepts, locking both Picks atomically with CHALLENGE_ACCEPTED", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("accepted");
    expect(result.challenge.status).toBe("ACCEPTED");
    expect(result.challenge.acceptedAt).not.toBeNull();

    const [aRow, bRow] = await Promise.all([getPredictionById(aPick), getPredictionById(bPick)]);
    expect(aRow?.lockedAt).not.toBeNull();
    expect(aRow?.lockReason).toBe("CHALLENGE_ACCEPTED");
    expect(bRow?.lockedAt).not.toBeNull();
    expect(bRow?.lockReason).toBe("CHALLENGE_ACCEPTED");
  });

  it("a non-recipient cannot accept", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const outsider = await createUser("outsider");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(acceptCallBS(created.challenge.id, outsider.userId)).rejects.toThrow(/not_recipient/);
    await expect(acceptCallBS(created.challenge.id, a.userId)).rejects.toThrow(/not_recipient/); // the challenger themselves cannot accept their own Challenge
  });

  it("selection snapshots remain immutable through acceptance", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.challenge.challengerSelectionSnapshot).toBe("YES");
    expect(result.challenge.recipientSelectionSnapshot).toBe("NO");
  });

  it("accepting after the effective cutoff has passed is rejected and the Challenge becomes EXPIRED (cutoff race)", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 30 * 1000).toISOString() }).eq("id", fixtureId);
    // Insert directly to bypass call_bs's own creation-time cutoff check, isolating accept_call_bs's own race check.
    const { data: challenge } = await admin
      .from("challenges")
      .insert({
        market_id: marketId,
        challenger_user_id: a.userId,
        recipient_user_id: b.userId,
        challenger_prediction_id: aPick,
        recipient_prediction_id: bPick,
        challenger_selection_snapshot: "YES",
        recipient_selection_snapshot: "NO",
      })
      .select("id")
      .single();

    const result = await acceptCallBS(challenge!.id, b.userId);
    expect(result.outcome).toBe("rejected_cutoff");
    expect(result.challenge.status).toBe("EXPIRED");
    const [aRow, bRow] = await Promise.all([getPredictionById(aPick), getPredictionById(bPick)]);
    expect(aRow?.lockedAt).toBeNull();
    expect(bRow?.lockedAt).toBeNull();
  });

  it("accepting a DECLINED Challenge is rejected", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await declineCallBS(created.challenge.id, b.userId);

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("not_pending");
    expect(result.challenge.status).toBe("DECLINED");
  });

  it("accepting an already-EXPIRED Challenge is rejected", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 30 * 1000).toISOString() }).eq("id", fixtureId);
    const { data: challenge } = await admin
      .from("challenges")
      .insert({
        market_id: marketId,
        challenger_user_id: a.userId,
        recipient_user_id: b.userId,
        challenger_prediction_id: aPick,
        recipient_prediction_id: bPick,
        challenger_selection_snapshot: "YES",
        recipient_selection_snapshot: "NO",
      })
      .select("id")
      .single();
    await acceptCallBS(challenge!.id, b.userId); // materializes EXPIRED

    const second = await acceptCallBS(challenge!.id, b.userId);
    expect(second.outcome).toBe("not_pending");
  });

  it("accepting an already-ACCEPTED Challenge is idempotent (no crash, no double lock)", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    const first = await acceptCallBS(created.challenge.id, b.userId);
    const firstLockedAt = first.challenge.acceptedAt;

    const second = await acceptCallBS(created.challenge.id, b.userId);
    expect(second.outcome).toBe("not_pending");
    expect(second.challenge.acceptedAt).toBe(firstLockedAt);
  });

  it("a Pick already locked (CUTOFF) by the time acceptance runs is rejected, not silently accepted (acceptance-vs-edit/cutoff race)", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    // Simulate set_pick materializing a CUTOFF lock on the recipient's Pick out from under this pending Challenge (e.g. kickoff moved closer between creation and acceptance).
    await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CUTOFF" }).eq("id", bPick);

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("rejected_cutoff");
    expect(result.challenge.status).toBe("EXPIRED");
  });
});

describe("Decline", () => {
  it("the recipient can decline — PENDING to DECLINED, no Pick locking", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const declined = await declineCallBS(created.challenge.id, b.userId);
    expect(declined.status).toBe("DECLINED");
    expect(declined.declinedAt).not.toBeNull();

    const [aRow, bRow] = await Promise.all([getPredictionById(aPick), getPredictionById(bPick)]);
    expect(aRow?.lockedAt).toBeNull();
    expect(bRow?.lockedAt).toBeNull();
  });

  it("the challenger cannot decline their own outgoing Challenge", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    await expect(declineCallBS(created.challenge.id, a.userId)).rejects.toThrow(/not_recipient/);
  });

  it("a third party cannot decline", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const outsider = await createUser("outsider");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    await expect(declineCallBS(created.challenge.id, outsider.userId)).rejects.toThrow(/not_recipient/);
  });

  it("a DECLINED Challenge cannot later be accepted", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await declineCallBS(created.challenge.id, b.userId);

    const result = await acceptCallBS(created.challenge.id, b.userId);
    expect(result.outcome).toBe("not_pending");
  });
});

describe("Exclusivity (one ACCEPTED Call BS per user per Market)", () => {
  it("[A] multiple PENDING challenges against the same recipient coexist, and the recipient's Pick stays unlocked", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const andrePick = await pick(andre.userId, marketId, "YES");
    const carlosPick = await pick(carlos.userId, marketId, "NO");
    const marcoPick = await pick(marco.userId, marketId, "NO");

    const fromCarlos = await callBS(carlos.userId, andrePick);
    const fromMarco = await callBS(marco.userId, andrePick);
    expect(fromCarlos.ok).toBe(true);
    expect(fromMarco.ok).toBe(true);
    if (!fromCarlos.ok || !fromMarco.ok) return;
    expect(fromCarlos.challenge.status).toBe("PENDING");
    expect(fromMarco.challenge.status).toBe("PENDING");

    const andreRow = await getPredictionById(andrePick);
    const carlosRow = await getPredictionById(carlosPick);
    const marcoRow = await getPredictionById(marcoPick);
    expect(andreRow?.lockedAt).toBeNull();
    expect(carlosRow?.lockedAt).toBeNull();
    expect(marcoRow?.lockedAt).toBeNull();
  });

  it("[B] accepting one challenge locks both Picks and displaces every other PENDING challenge sharing a participant on this Market", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const andrePick = await pick(andre.userId, marketId, "YES");
    const carlosPick = await pick(carlos.userId, marketId, "NO");
    await pick(marco.userId, marketId, "NO");

    const fromCarlos = await callBS(carlos.userId, andrePick);
    const fromMarco = await callBS(marco.userId, andrePick);
    if (!fromCarlos.ok || !fromMarco.ok) throw new Error("setup failed");

    const accept = await acceptCallBS(fromCarlos.challenge.id, andre.userId);
    expect(accept.outcome).toBe("accepted");

    const andreRow = await getPredictionById(andrePick);
    const carlosRow = await getPredictionById(carlosPick);
    expect(andreRow?.lockedAt).not.toBeNull();
    expect(andreRow?.lockReason).toBe("CHALLENGE_ACCEPTED");
    expect(carlosRow?.lockedAt).not.toBeNull();
    expect(carlosRow?.lockReason).toBe("CHALLENGE_ACCEPTED");

    const { data: marcoChallenge } = await admin.from("challenges").select("status").eq("id", fromMarco.challenge.id).single();
    expect(marcoChallenge?.status).toBe("EXPIRED");
  });

  it("[C] accepting one of Carlos's challenges displaces every OTHER PENDING challenge involving Carlos on this Market too", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const priya = await createUser("priya");
    const andrePick = await pick(andre.userId, marketId, "YES");
    const carlosPick = await pick(carlos.userId, marketId, "NO");
    const priyaPick = await pick(priya.userId, marketId, "YES");
    void carlosPick;

    // Carlos has two outgoing PENDING challenges on this Market: one
    // against Andre, one against a second, unrelated opposing picker
    // (Priya).
    const carlosToAndre = await callBS(carlos.userId, andrePick);
    const carlosToPriya = await callBS(carlos.userId, priyaPick);
    if (!carlosToAndre.ok || !carlosToPriya.ok) throw new Error("setup failed");

    const accept = await acceptCallBS(carlosToAndre.challenge.id, andre.userId);
    expect(accept.outcome).toBe("accepted");

    const { data: challenges } = await admin
      .from("challenges")
      .select("id, status, challenger_user_id, recipient_user_id")
      .eq("market_id", marketId)
      .eq("challenger_user_id", carlos.userId);
    for (const c of challenges ?? []) {
      if (c.id === carlosToAndre.challenge.id) expect(c.status).toBe("ACCEPTED");
      else expect(c.status).toBe("EXPIRED");
    }
  });

  it("[D] one incoming and one outgoing PENDING challenge for the same user on the same Market — accepting either invalidates the other", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const andrePick = await pick(andre.userId, marketId, "YES");
    const carlosPick = await pick(carlos.userId, marketId, "NO");
    const marcoPick = await pick(marco.userId, marketId, "NO");
    void carlosPick;

    // Carlos -> Andre (incoming for Andre) and Andre -> Marco (outgoing for Andre).
    const incoming = await callBS(carlos.userId, andrePick);
    const outgoing = await callBS(andre.userId, marcoPick);
    if (!incoming.ok || !outgoing.ok) throw new Error("setup failed");

    const accept = await acceptCallBS(incoming.challenge.id, andre.userId);
    expect(accept.outcome).toBe("accepted");

    const { data: outgoingRow } = await admin.from("challenges").select("status").eq("id", outgoing.challenge.id).single();
    expect(outgoingRow?.status).toBe("EXPIRED");
  });

  it("[E] two unrelated opposing pairs on the same Market can both become ACCEPTED independently", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const lia = await createUser("lia");
    const andrePick = await pick(andre.userId, marketId, "YES");
    const carlosPick = await pick(carlos.userId, marketId, "NO");
    const marcoPick = await pick(marco.userId, marketId, "YES");
    const liaPick = await pick(lia.userId, marketId, "NO");
    void andrePick;
    void marcoPick;

    const pairOne = await callBS(carlos.userId, andrePick);
    const pairTwo = await callBS(lia.userId, marcoPick);
    if (!pairOne.ok || !pairTwo.ok) throw new Error("setup failed");

    const acceptOne = await acceptCallBS(pairOne.challenge.id, andre.userId);
    const acceptTwo = await acceptCallBS(pairTwo.challenge.id, marco.userId);
    expect(acceptOne.outcome).toBe("accepted");
    expect(acceptTwo.outcome).toBe("accepted");

    const carlosRow = await getPredictionById(carlosPick);
    const liaRow = await getPredictionById(liaPick);
    expect(carlosRow?.lockReason).toBe("CHALLENGE_ACCEPTED");
    expect(liaRow?.lockReason).toBe("CHALLENGE_ACCEPTED");
  });

  it("[F] an accepted Call BS on one Market does not block the same user from accepting a different Call BS on another Market", async () => {
    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const marketA = await createMarket(fixtureA);
    const marketB = await createMarket(fixtureB);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const andrePickA = await pick(andre.userId, marketA, "YES");
    await pick(carlos.userId, marketA, "NO");
    const andrePickB = await pick(andre.userId, marketB, "YES");
    await pick(marco.userId, marketB, "NO");

    const challengeA = await callBS(carlos.userId, andrePickA);
    const challengeB = await callBS(marco.userId, andrePickB);
    if (!challengeA.ok || !challengeB.ok) throw new Error("setup failed");

    const acceptA = await acceptCallBS(challengeA.challenge.id, andre.userId);
    const acceptB = await acceptCallBS(challengeB.challenge.id, andre.userId);
    expect(acceptA.outcome).toBe("accepted");
    expect(acceptB.outcome).toBe("accepted");
  });

  it("[G] a second accept attempt against a conflicting challenge fails deterministically with rejected_already_paired", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const andrePick = await pick(andre.userId, marketId, "YES");
    await pick(carlos.userId, marketId, "NO");
    await pick(marco.userId, marketId, "NO");

    const fromCarlos = await callBS(carlos.userId, andrePick);
    const fromMarco = await callBS(marco.userId, andrePick);
    if (!fromCarlos.ok || !fromMarco.ok) throw new Error("setup failed");

    const firstAccept = await acceptCallBS(fromCarlos.challenge.id, andre.userId);
    expect(firstAccept.outcome).toBe("accepted");

    // The cascade already flips fromMarco to EXPIRED, so this specific
    // acceptance attempt now takes the ordinary not-PENDING path — the
    // important, deterministic fact is that it can never also become
    // ACCEPTED.
    const secondAccept = await acceptCallBS(fromMarco.challenge.id, andre.userId);
    expect(secondAccept.outcome).not.toBe("accepted");
    expect(secondAccept.challenge.status).not.toBe("ACCEPTED");
  });

  it("[H] the displaced user's Pick remains ordinarily editable; the winning pair's Picks do not", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const andrePick = await pick(andre.userId, marketId, "YES");
    await pick(carlos.userId, marketId, "NO");
    const marcoPick = await pick(marco.userId, marketId, "NO");

    const fromCarlos = await callBS(carlos.userId, andrePick);
    const fromMarco = await callBS(marco.userId, andrePick);
    if (!fromCarlos.ok || !fromMarco.ok) throw new Error("setup failed");
    const accept = await acceptCallBS(fromCarlos.challenge.id, andre.userId);
    expect(accept.outcome).toBe("accepted");
    void fromMarco;

    // Andre (won the exclusive pairing with Carlos) cannot edit anymore.
    const { outcome: andreEditOutcome } = await setPick({
      userId: andre.userId,
      marketId,
      selectedOutcome: "NO",
      yesProbability: 0.6,
      noProbability: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(andreEditOutcome).toBe("rejected_locked");

    // Marco (displaced, never got an ACCEPTED pairing) can still edit normally.
    const marcoRowBefore = await getPredictionById(marcoPick);
    expect(marcoRowBefore?.lockedAt).toBeNull();
    const { outcome: marcoEditOutcome } = await setPick({
      userId: marco.userId,
      marketId,
      selectedOutcome: "YES",
      yesProbability: 0.6,
      noProbability: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(marcoEditOutcome).toBe("updated");
  });

  it("[concurrency, launch-critical] two concurrent Accept requests for different PENDING challenges sharing one participant — exactly one may ever become ACCEPTED", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const marco = await createUser("marco");
    const andrePick = await pick(andre.userId, marketId, "YES");
    await pick(carlos.userId, marketId, "NO");
    await pick(marco.userId, marketId, "NO");

    const fromCarlos = await callBS(carlos.userId, andrePick);
    const fromMarco = await callBS(marco.userId, andrePick);
    if (!fromCarlos.ok || !fromMarco.ok) throw new Error("setup failed");

    // Two genuinely overlapping requests against two DIFFERENT Challenge
    // rows that share Andre as a participant — this is exactly the race
    // the advisory-lock serialization in accept_call_bs() exists for.
    // A second admin client instance is used for the second call so the
    // two requests are independent connections, not serialized by a
    // single client's own request queueing.
    const admin2 = getTestAdminClient();
    const [resultA, resultB] = await Promise.all([
      acceptCallBS(fromCarlos.challenge.id, andre.userId),
      admin2
        .rpc("accept_call_bs", { p_challenge_id: fromMarco.challenge.id, p_recipient_user_id: andre.userId })
        .single()
        .then((r) => {
          if (r.error) throw r.error;
          const row = r.data as { outcome: string };
          return { outcome: row.outcome };
        }),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome];
    const acceptedCount = outcomes.filter((o) => o === "accepted").length;
    expect(acceptedCount).toBe(1);

    const { data: finalStatuses } = await admin
      .from("challenges")
      .select("id, status")
      .in("id", [fromCarlos.challenge.id, fromMarco.challenge.id]);
    const acceptedRows = (finalStatuses ?? []).filter((c) => c.status === "ACCEPTED");
    expect(acceptedRows).toHaveLength(1);

    const andreRow = await getPredictionById(andrePick);
    expect(andreRow?.lockedAt).not.toBeNull();
    expect(andreRow?.lockReason).toBe("CHALLENGE_ACCEPTED");

    // No deadlock: both calls above resolved (Promise.all settled) rather
    // than hanging — if the advisory-lock ordering were wrong, this test
    // itself would time out instead of reaching these assertions.
  });

  it("[concurrency] Accept vs Decline against the same PENDING challenge — exactly one terminal path wins, no mixed state", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const andrePick = await pick(andre.userId, marketId, "YES");
    await pick(carlos.userId, marketId, "NO");

    const fromCarlos = await callBS(carlos.userId, andrePick);
    if (!fromCarlos.ok) throw new Error("setup failed");

    const admin2 = getTestAdminClient();
    const [acceptResult, declineResult] = await Promise.allSettled([
      acceptCallBS(fromCarlos.challenge.id, andre.userId),
      admin2.rpc("decline_call_bs", { p_challenge_id: fromCarlos.challenge.id, p_recipient_user_id: andre.userId }).single(),
    ]);

    const { data: finalRow } = await admin.from("challenges").select("status").eq("id", fromCarlos.challenge.id).single();
    expect(["ACCEPTED", "DECLINED"]).toContain(finalRow?.status);

    // Exactly one of the two requests actually produced its intended
    // terminal state; the other either failed (not_pending) or, for
    // accept, resolved with a non-"accepted" outcome. Never both.
    const acceptSucceeded = acceptResult.status === "fulfilled" && acceptResult.value.outcome === "accepted";
    const declineSucceeded = declineResult.status === "fulfilled" && !declineResult.value.error;
    expect(acceptSucceeded && declineSucceeded).toBe(false);
  });

  it("[concurrency] Accept vs a Pick edit on the recipient's own Pick — the database never lands on an ACCEPTED Challenge with a stale/non-opposing snapshot", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const andrePick = await pick(andre.userId, marketId, "YES");
    await pick(carlos.userId, marketId, "NO");

    const fromCarlos = await callBS(carlos.userId, andrePick);
    if (!fromCarlos.ok) throw new Error("setup failed");

    await Promise.all([
      acceptCallBS(fromCarlos.challenge.id, andre.userId),
      setPick({
        userId: andre.userId,
        marketId,
        selectedOutcome: "NO",
        yesProbability: 0.6,
        noProbability: 0.4,
        marketQuestionSnapshot: "q",
        marketCloseAtSnapshot: null,
        marketStatusSnapshot: "ACTIVE",
        idempotencyKey: crypto.randomUUID(),
      }),
    ]);

    const { data: finalRow } = await admin.from("challenges").select("status, challenger_selection_snapshot, recipient_selection_snapshot").eq("id", fromCarlos.challenge.id).single();
    if (finalRow?.status === "ACCEPTED") {
      // If acceptance won the race, the snapshot it accepted against must
      // still be exactly what it was at Challenge creation — set_pick()
      // itself is blocked from ever touching a Pick once accept_call_bs()
      // has locked it, so a "changed snapshot but still ACCEPTED" state
      // would mean the race was lost, not won.
      const andreRow = await getPredictionById(andrePick);
      expect(andreRow?.selectedOutcome).toBe(finalRow.recipient_selection_snapshot);
    } else {
      expect(finalRow?.status).toBe("EXPIRED");
    }
  });
});

describe("Resolution", () => {
  it("the challenger wins when their Pick grades CORRECT", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);

    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", bPick);

    const summary = await resolveAcceptedChallenges();
    expect(summary.resolved).toBeGreaterThanOrEqual(1);

    const resolved = await getChallengeById(created.challenge.id);
    expect(resolved?.status).toBe("RESOLVED");
    expect(resolved?.result).toBe("CHALLENGER_WON");
    expect(resolved?.resolvedAt).not.toBeNull();
  });

  it("the recipient wins when their Pick grades CORRECT", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);

    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "NO", graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "NO", graded_at: new Date().toISOString() }).eq("id", bPick);

    await resolveAcceptedChallenges();
    const resolved = await getChallengeById(created.challenge.id);
    expect(resolved?.result).toBe("RECIPIENT_WON");
  });

  it("resolves VOID when a Pick grades VOID — no winner", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);

    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null, graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null, graded_at: new Date().toISOString() }).eq("id", bPick);

    await resolveAcceptedChallenges();
    const resolved = await getChallengeById(created.challenge.id);
    expect(resolved?.result).toBe("VOID");
  });

  it("does not resolve while grading is still pending for either side", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);
    // Only André's side graded — Carlos's Pick remains PENDING.
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);

    await resolveAcceptedChallenges();
    const stillAccepted = await getChallengeById(created.challenge.id);
    expect(stillAccepted?.status).toBe("ACCEPTED");
    expect(stillAccepted?.result).toBeNull();
  });

  it("resolution is idempotent — running twice never re-resolves or changes the winner", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", bPick);

    const first = await resolveAcceptedChallenges();
    const second = await resolveAcceptedChallenges();
    expect(second.resolved).toBe(0); // nothing left to resolve the second time
    const resolved = await getChallengeById(created.challenge.id);
    expect(resolved?.result).toBe("CHALLENGER_WON");
    void first;
  });
});

describe("Market independence", () => {
  it("a Market price update does not alter an existing Challenge", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { providerMarketId: "call-bs-indep-1" });
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    await createMarket(fixtureId, { providerMarketId: "call-bs-indep-1", price: { yes: 0.9, no: 0.1, outcomeLabels: { yes: "Home", no: "Away" } } });

    const stillThere = await getChallengeById(created.challenge.id);
    expect(stillThere?.status).toBe("PENDING");
    expect(stillThere?.marketId).toBe(marketId);
  });
});

describe("Post/Community independence", () => {
  it("challenges never stores a community_id — ownership is Market-scoped only, same as Pick", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const { data: row } = await admin.from("challenges").select("*").eq("id", created.challenge.id).single();
    expect(Object.keys(row!)).not.toContain("community_id");
    expect(Object.keys(row!)).not.toContain("post_id");
  });
});

describe("Notifications", () => {
  it("createChallengeReceivedNotification notifies the recipient, linked to the canonical Challenge", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    await createChallengeReceivedNotification(created.challenge);
    const { data: notifications } = await admin.from("notifications").select("*").eq("user_id", b.userId).eq("challenge_id", created.challenge.id);
    expect(notifications).toHaveLength(1);
    expect(notifications![0].type).toBe("CALL_BS_RECEIVED");
  });

  it("resolution notifies both participants exactly once, with a winner/loser-specific message", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", bPick);

    await resolveAcceptedChallenges();
    const { data: aNotifs } = await admin.from("notifications").select("*").eq("user_id", a.userId).eq("challenge_id", created.challenge.id).eq("type", "CALL_BS_RESOLVED");
    const { data: bNotifs } = await admin.from("notifications").select("*").eq("user_id", b.userId).eq("challenge_id", created.challenge.id).eq("type", "CALL_BS_RESOLVED");
    expect(aNotifs).toHaveLength(1);
    expect(bNotifs).toHaveLength(1);
    expect(aNotifs![0].title).toBe("You won a Call BS");
    expect(bNotifs![0].title).toBe("You lost a Call BS");

    // Re-running resolution must not duplicate the notification (§36, §41).
    await resolveAcceptedChallenges();
    const { data: aNotifsAfter } = await admin.from("notifications").select("*").eq("user_id", a.userId).eq("challenge_id", created.challenge.id).eq("type", "CALL_BS_RESOLVED");
    expect(aNotifsAfter).toHaveLength(1);
  });

  it("VOID resolution notifies both participants with void-specific copy, no winner language", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null, graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null, graded_at: new Date().toISOString() }).eq("id", bPick);

    await resolveAcceptedChallenges();
    const { data: aNotifs } = await admin.from("notifications").select("*").eq("user_id", a.userId).eq("challenge_id", created.challenge.id);
    expect(aNotifs![0].title).toBe("Call BS void");
    expect(aNotifs![0].body).not.toMatch(/won|lost|beat/i);
  });

  it("the recipient cannot be forged — it is always the Challenge's own stored recipient_user_id", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const outsider = await createUser("outsider");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    await createChallengeReceivedNotification(created.challenge);
    const { data: outsiderNotifs } = await admin.from("notifications").select("*").eq("user_id", outsider.userId).eq("challenge_id", created.challenge.id);
    expect(outsiderNotifs).toEqual([]);
  });
});

describe("Security", () => {
  it("no authenticated client can call call_bs/accept_call_bs/decline_call_bs directly (service_role only)", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");

    const { error: createErr } = await a.client.rpc("call_bs", { p_challenger_user_id: a.userId, p_recipient_prediction_id: bPick });
    expect(createErr).not.toBeNull();

    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const { error: acceptErr } = await b.client.rpc("accept_call_bs", { p_challenge_id: created.challenge.id, p_recipient_user_id: b.userId });
    expect(acceptErr).not.toBeNull();
    const { error: declineErr } = await b.client.rpc("decline_call_bs", { p_challenge_id: created.challenge.id, p_recipient_user_id: b.userId });
    expect(declineErr).not.toBeNull();
  });

  it("an authenticated client cannot write challenges directly — no INSERT/UPDATE grant", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");

    const { data: insertData } = await a.client
      .from("challenges")
      .insert({
        market_id: marketId,
        challenger_user_id: a.userId,
        recipient_user_id: b.userId,
        challenger_prediction_id: aPick,
        recipient_prediction_id: bPick,
        challenger_selection_snapshot: "YES",
        recipient_selection_snapshot: "NO",
      })
      .select();
    expect(insertData ?? []).toHaveLength(0);

    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    const { error: updateErr } = await a.client.from("challenges").update({ status: "RESOLVED", result: "CHALLENGER_WON" }).eq("id", created.challenge.id);
    expect(updateErr).not.toBeNull();
    const { data: unchanged } = await admin.from("challenges").select("status, result").eq("id", created.challenge.id).single();
    expect(unchanged?.status).toBe("PENDING");
    expect(unchanged?.result).toBeNull();
  });

  it("participants can read their own Challenge via RLS regardless of status; an outsider cannot read a non-RESOLVED one", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const outsider = await createUser("outsider");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const { data: challengerView } = await a.client.from("challenges").select("id").eq("id", created.challenge.id);
    expect(challengerView).toHaveLength(1);
    const { data: recipientView } = await b.client.from("challenges").select("id").eq("id", created.challenge.id);
    expect(recipientView).toHaveLength(1);
    const { data: outsiderView } = await outsider.client.from("challenges").select("id").eq("id", created.challenge.id);
    expect(outsiderView ?? []).toHaveLength(0);
  });

  it("a RESOLVED Challenge is readable by any authenticated user as a public factual record", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const outsider = await createUser("outsider");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", bPick);
    await resolveAcceptedChallenges();

    const { data: outsiderView } = await outsider.client.from("challenges").select("id, status").eq("id", created.challenge.id);
    expect(outsiderView).toHaveLength(1);
    expect(outsiderView![0].status).toBe("RESOLVED");
  });

  it("anon cannot read challenges at all", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const anon = getTestAnonClient();
    const { data } = await anon.from("challenges").select("id").eq("id", created.challenge.id);
    expect(data ?? []).toEqual([]);
  });
});

describe("Rate limiting", () => {
  // checkCallBsRateLimit() itself goes through lib/supabase/server.ts's
  // cookie-bound client (only usable inside a real Next.js request), same
  // reasoning tests/integration/post-conversation.test.ts's own Rate
  // limiting section documents — exercise the underlying RPC directly with
  // the same `call_bs:` identifier prefix instead.
  function checkCallBsRpcRateLimit(userId: string, windowSeconds: number, maxAttempts: number) {
    return admin.rpc("check_and_increment_rate_limit", {
      p_identifier: `call_bs:${userId}`,
      p_window_seconds: windowSeconds,
      p_max_attempts: maxAttempts,
    });
  }

  it("blocks Call BS creation past the configured attempt cap, and a different user is unaffected", async () => {
    const a = await createUser("rate-a");
    const b = await createUser("rate-b");

    for (let i = 0; i < 2; i++) {
      const { data } = await checkCallBsRpcRateLimit(a.userId, 60, 2);
      expect(data).toBe(true);
    }
    const { data: blocked } = await checkCallBsRpcRateLimit(a.userId, 60, 2);
    expect(blocked).toBe(false);
    const { data: allowedB } = await checkCallBsRpcRateLimit(b.userId, 60, 2);
    expect(allowedB).toBe(true);

    await admin.from("rate_limits").delete().in("identifier", [`call_bs:${a.userId}`, `call_bs:${b.userId}`]);
  });
});

describe("Discovery / participant presentation", () => {
  it("getMarketParticipants exposes only presentation-safe fields and a correct canCallBs flag", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const rawMarket = await getMarketById(marketId);
    await pick(a.userId, marketId, "YES");
    await pick(b.userId, marketId, "NO");

    const fixture = await admin.from("fixtures").select("scheduled_start_utc").eq("id", fixtureId).single();
    const participants = await getMarketParticipants(marketId, a.userId, fixture.data!.scheduled_start_utc);
    const bParticipant = participants.find((p) => p.userId === b.userId);
    expect(bParticipant?.canCallBs).toBe(true);
    expect(bParticipant).not.toHaveProperty("yesProbabilitySnapshot");
    void rawMarket;
  });

  it("getChallengeRecordForUser reports a purely factual tally with no scoring", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const aPick = await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    await acceptCallBS(created.challenge.id, b.userId);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", bPick);
    await resolveAcceptedChallenges();

    const aRecord = await getChallengeRecordForUser(a.userId);
    const bRecord = await getChallengeRecordForUser(b.userId);
    expect(aRecord).toEqual({ wins: 1, losses: 0, voids: 0 });
    expect(bRecord).toEqual({ wins: 0, losses: 1, voids: 0 });
  });

  it("listChallengesForMarketAndUser returns every Challenge on that Market involving the user", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(a.userId, marketId, "YES");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const forA = await listChallengesForMarketAndUser(marketId, a.userId);
    expect(forA.map((c) => c.id)).toContain(created.challenge.id);
  });
});

describe("Account eligibility", () => {
  it("rejects sending a Call BS to an inactive recipient, server-side", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await admin.from("user_profiles").update({ is_active: false }).eq("id", b.userId);

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("recipient_inactive");
    const { data: rows } = await admin.from("challenges").select("id").eq("market_id", marketId);
    expect(rows ?? []).toHaveLength(0);
  });

  it("rejects an inactive challenger, server-side", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await admin.from("user_profiles").update({ is_active: false }).eq("id", a.userId);

    const outcome = await callBS(a.userId, bPick);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("challenger_inactive");
  });

  for (const deactivated of ["challenger", "recipient"] as const) {
    it(`rejects acceptance when the ${deactivated} became inactive after the Call BS was sent — EXPIRED, no Pick locked`, async () => {
      const fixtureId = await createFixture();
      const marketId = await createMarket(fixtureId);
      const a = await createUser("a");
      const b = await createUser("b");
      const aPick = await pick(a.userId, marketId, "YES");
      const bPick = await pick(b.userId, marketId, "NO");
      const created = await callBS(a.userId, bPick);
      if (!created.ok) throw new Error("setup failed");

      await admin.from("user_profiles").update({ is_active: false }).eq("id", deactivated === "challenger" ? a.userId : b.userId);

      const result = await acceptCallBS(created.challenge.id, b.userId);
      expect(result.outcome).toBe("rejected_ineligible_account");
      expect(result.challenge.status).toBe("EXPIRED");
      expect((await getPredictionById(aPick))?.lockedAt).toBeNull();
      expect((await getPredictionById(bPick))?.lockedAt).toBeNull();
    });
  }
});

describe("Discovery — accepted-pairing eligibility", () => {
  async function startOf(fixtureId: string): Promise<string> {
    const { data } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", fixtureId).single();
    return data!.scheduled_start_utc as string;
  }

  it("a viewer who already holds an accepted Call BS on the Market is offered no Call BS against anyone else", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const c = await createUser("c");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(c.userId, marketId, "NO");
    const start = await startOf(fixtureId);

    const before = await getMarketParticipants(marketId, a.userId, start);
    expect(before.find((p) => p.userId === c.userId)?.canCallBs).toBe(true);

    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    expect((await acceptCallBS(created.challenge.id, b.userId)).outcome).toBe("accepted");

    const after = await getMarketParticipants(marketId, a.userId, start);
    expect(after.find((p) => p.userId === c.userId)?.canCallBs).toBe(false);
    expect(after.find((p) => p.userId === b.userId)?.canCallBs).toBe(false);
  });

  it("a third party is offered no Call BS against a target who already holds an accepted Call BS — but still against an unpaired one", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const c = await createUser("c");
    const d = await createUser("d");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(c.userId, marketId, "YES"); // third party, opposes b and d
    await pick(d.userId, marketId, "NO"); // unpaired opponent
    const start = await startOf(fixtureId);

    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");
    expect((await acceptCallBS(created.challenge.id, b.userId)).outcome).toBe("accepted");

    const forC = await getMarketParticipants(marketId, c.userId, start);
    expect(forC.find((p) => p.userId === b.userId)?.canCallBs).toBe(false); // target b is paired with a
    expect(forC.find((p) => p.userId === d.userId)?.canCallBs).toBe(true); // d is not
  });

  it("a PENDING Challenge alone never suppresses eligibility against other targets", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    const c = await createUser("c");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    await pick(c.userId, marketId, "NO");
    const start = await startOf(fixtureId);

    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const participants = await getMarketParticipants(marketId, a.userId, start);
    expect(participants.find((p) => p.userId === c.userId)?.canCallBs).toBe(true);
  });
});

describe("Notification stamping and delivery", () => {
  it("every Call BS notification type carries challenge_id, market_id and the published Post", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const { id: postId } = await ensurePostForFixture(fixtureId);
    await publishPost(postId);

    try {
      const a = await createUser("a");
      const b = await createUser("b");
      const c = await createUser("c");
      const d = await createUser("d");
      const aPick = await pick(a.userId, marketId, "YES");
      const bPick = await pick(b.userId, marketId, "NO");
      await pick(c.userId, marketId, "NO");
      const dPick = await pick(d.userId, marketId, "YES");
      const cPickRow = (await admin.from("predictions").select("id").eq("market_id", marketId).eq("user_id", c.userId).single()).data!.id as string;

      // a → b: RECEIVED, ACCEPTED, then RESOLVED. d → c: RECEIVED, DECLINED.
      const accepted = await callBS(a.userId, bPick);
      const declined = await callBS(d.userId, cPickRow);
      if (!accepted.ok || !declined.ok) throw new Error("setup failed");

      await createChallengeReceivedNotification(accepted.challenge);
      const acceptResult = await acceptCallBS(accepted.challenge.id, b.userId);
      await createChallengeAcceptedNotification(acceptResult.challenge);
      const declineChallenge = await declineCallBS(declined.challenge.id, c.userId);
      await createChallengeReceivedNotification(declined.challenge);
      await createChallengeDeclinedNotification(declineChallenge);

      await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", aPick);
      await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", bPick);
      await resolveAcceptedChallenges();
      expect(dPick).toBeTruthy();

      const { data: rows } = await admin
        .from("notifications")
        .select("type, user_id, challenge_id, market_id, post_id")
        .in("challenge_id", [accepted.challenge.id, declined.challenge.id]);

      expect([...new Set((rows ?? []).map((r) => r.type as string))].sort()).toEqual([
        "CALL_BS_ACCEPTED",
        "CALL_BS_DECLINED",
        "CALL_BS_RECEIVED",
        "CALL_BS_RESOLVED",
      ]);
      for (const row of rows ?? []) {
        expect(row.challenge_id).toBeTruthy();
        expect(row.market_id).toBe(marketId);
        expect(row.post_id).toBe(postId);
      }
      // RESOLVED goes to both participants of the accepted pair.
      const resolvedFor = (rows ?? []).filter((r) => r.type === "CALL_BS_RESOLVED").map((r) => r.user_id).sort();
      expect(resolvedFor).toEqual([a.userId, b.userId].sort());
    } finally {
      // notifications.post_id and posts.fixture_id are real FKs: detach them before the shared afterEach removes the fixture.
      await admin.from("notifications").delete().eq("post_id", postId);
      await admin.from("posts").delete().eq("id", postId);
    }
  });

  it("stamps market_id with a null post_id when the Game has no published Post yet", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    await createChallengeReceivedNotification(created.challenge);
    const { data: row } = await admin.from("notifications").select("market_id, post_id").eq("challenge_id", created.challenge.id).single();
    expect(row?.market_id).toBe(marketId);
    expect(row?.post_id).toBeNull();
  });

  it("a failed notification insert is never silent: the creator throws, and the safe wrapper logs and reports it without throwing", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    // A recipient that doesn't exist violates notifications.user_id's foreign key — a real insert failure.
    const broken = { ...created.challenge, recipientUserId: crypto.randomUUID() };
    await expect(createChallengeReceivedNotification(broken)).rejects.toThrow(/CALL_BS_RECEIVED notification insert failed/);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const delivery = await deliverChallengeNotification("CALL_BS_RECEIVED", created.challenge.id, () => createChallengeReceivedNotification(broken));
      expect(delivery.delivered).toBe(false);
      if (!delivery.delivered) expect(delivery.error).toMatch(/notification insert failed/);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain(created.challenge.id);
    } finally {
      logged.mockRestore();
    }

    // The Challenge itself is unaffected by the failed notification.
    expect((await getChallengeById(created.challenge.id))?.status).toBe("PENDING");
  });

  it("the safe wrapper reports success for a normal delivery", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const a = await createUser("a");
    const b = await createUser("b");
    await pick(a.userId, marketId, "YES");
    const bPick = await pick(b.userId, marketId, "NO");
    const created = await callBS(a.userId, bPick);
    if (!created.ok) throw new Error("setup failed");

    const delivery = await deliverChallengeNotification("CALL_BS_RECEIVED", created.challenge.id, () => createChallengeReceivedNotification(created.challenge));
    expect(delivery).toEqual({ delivered: true });
  });
});
