/**
 * Integration tests for Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Free Call BS Challenges) — call_bs()/accept_call_bs()/decline_call_bs(),
 * Challenge resolution, notifications, rate limiting, and security. Real
 * local Supabase throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { setPick, getPredictionById } from "@/lib/predictions/repository";
import { upsertMarket, getMarketById } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { callBS, acceptCallBS, declineCallBS, getChallengeById, getChallengeRecordForUser, listChallengesForMarketAndUser } from "@/lib/challenges/repository";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { getMarketParticipants } from "@/lib/challenges/discovery";
import { createChallengeReceivedNotification } from "@/lib/notifications/challenges";

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

describe("Multiplicity", () => {
  it("the same already-locked Pick supports a second, independent accepted Challenge — no overwritten lock, one Pick row throughout", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const andre = await createUser("andre");
    const carlos = await createUser("carlos");
    const david = await createUser("david");
    const andrePick = await pick(andre.userId, marketId, "YES");
    const carlosPick = await pick(carlos.userId, marketId, "NO");
    const davidPick = await pick(david.userId, marketId, "NO");

    const first = await callBS(andre.userId, carlosPick);
    if (!first.ok) throw new Error("setup failed");
    const firstAccept = await acceptCallBS(first.challenge.id, carlos.userId);
    expect(firstAccept.outcome).toBe("accepted");
    const andreRowAfterFirst = await getPredictionById(andrePick);
    const firstLockedAt = andreRowAfterFirst?.lockedAt;

    const second = await callBS(andre.userId, davidPick);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondAccept = await acceptCallBS(second.challenge.id, david.userId);
    expect(secondAccept.outcome).toBe("accepted");

    const andreRowAfterSecond = await getPredictionById(andrePick);
    expect(andreRowAfterSecond?.lockedAt).toBe(firstLockedAt); // never overwritten
    expect(andreRowAfterSecond?.lockReason).toBe("CHALLENGE_ACCEPTED");

    const { count } = await admin.from("predictions").select("id", { count: "exact", head: true }).eq("id", andrePick);
    expect(count).toBe(1); // still exactly one Pick row for André
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
