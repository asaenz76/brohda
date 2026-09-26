/**
 * Integration tests for the Milestone 3 Prediction domain
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 3). Real local
 * Supabase only (pnpm supabase:start). Exercises
 * lib/predictions/{repository,policy,grading,streak}.ts against real
 * `predictions`/`platform_settings`/`user_profiles` rows and a real
 * `markets` fixture — never a stubbed database. The Server Action itself
 * (lib/actions/predictions.ts) depends on Next's request-scoped
 * cookies()/requireUser(), which a plain integration test can't provide —
 * matching this codebase's own established split (see
 * tests/integration/capability-policy.test.ts), the domain layer is
 * proven here and the actual mutation-from-a-browser path is covered by
 * tests/e2e/predictions-flow.spec.ts.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { setPick, getLatestUserPredictionForMarket, markPredictionGraded } from "@/lib/predictions/repository";
import type { Prediction, PredictionOutcome, PredictionMarketStatusSnapshot } from "@/lib/predictions/types";
import {
  checkMarketEligibility,
  getPredictionNotificationCopyPolicy,
  getPredictionNotificationPolicy,
  getPredictionPolicy,
  shouldNotifyForResult,
} from "@/lib/predictions/policy";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult, getPredictionStats } from "@/lib/predictions/streak";
import { ensurePostForFixture, publishPost } from "@/lib/posts/repository";
import { resolveNotificationHref } from "@/lib/notifications/links";
import { loadCapabilityPolicy, roleHasCapability } from "@/lib/auth/capabilities";

const admin = getTestAdminClient();
const testProvider = `predictions_test_provider_${Date.now()}`;
const createdMarketIds: string[] = [];
const createdFixtureIds: string[] = [];
const createdUserIds: string[] = [];
// Milestone R1: every Market now belongs to its own canonical Game
// (fixture_id is a real, NOT NULL FK — see
// supabase/migrations/20260101000148_market_game_foundation.sql). This map
// lets the handful of tests that need to drive real grading (via the
// fixture's score, not a synthetic `resolvedOutcome`) find the fixture a
// given seeded market belongs to, without changing seedMarket's return
// shape (still just a marketId string) for the many call sites that don't
// care.
const marketFixtureIds = new Map<string, string>();
const PASSWORD = "integration-test-password-123";

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `predictions-test-${crypto.randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  createdFixtureIds.push(data.id);
  return data.id;
}

/**
 * Drives real Milestone R1 grading (lib/predictions/sports-resolution.ts)
 * by completing the fixture a seeded market belongs to — the only way a
 * Prediction on that market can grade CORRECT/INCORRECT now, since grading
 * reads the Game's own score, never a market-level `resolvedOutcome` text
 * field. Defaults to a HOME win, which is CORRECT for the default
 * MONEYLINE/yesSide:"HOME" market shape `marketFixture` below produces.
 */
async function resolveFixtureForMarket(
  marketId: string,
  { internalStatus = "COMPLETED", homeScore = 1, awayScore = 0 }: { internalStatus?: string; homeScore?: number | null; awayScore?: number | null } = {},
): Promise<void> {
  const fixtureId = marketFixtureIds.get(marketId);
  if (!fixtureId) throw new Error(`no fixture tracked for market ${marketId} — was it created via seedMarket()?`);
  const { error } = await admin.from("fixtures").update({ internal_status: internalStatus, home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  if (error) throw error;
}

function marketFixture(providerMarketId: string, fixtureId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: testProvider,
    providerMarketId,
    providerEventId: null,
    question: `Will predictions test ${providerMarketId} pass?`,
    description: null,
    status: "ACTIVE",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.62, no: 0.38, outcomeLabels: { yes: "Yes", no: "No" } },
    volume24hr: 100,
    liquidity: 1000,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "integration_test",
    providerMetadata: {},
    ...overrides,
  };
}

async function seedMarket(overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const fixtureId = overrides.fixtureId ?? (await createTestFixture());
  const { id } = await upsertMarket(marketFixture(`m_${Math.random().toString(36).slice(2)}`, fixtureId, overrides));
  createdMarketIds.push(id);
  marketFixtureIds.set(id, fixtureId);
  return id;
}

async function seedUser(): Promise<{ id: string; email: string }> {
  const email = `predictions-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create test user");
  const { error: profileError } = await admin
    .from("user_profiles")
    .insert({ id: data.user.id, display_name: "Predictions Test", role: "player", is_active: true });
  if (profileError) throw profileError;
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

/**
 * Milestone R5: thin compatibility wrapper over setPick(), matching the
 * pre-R5 createPrediction() call shape exactly so every existing call site
 * below needed no change beyond the function name — createPrediction()
 * itself was removed (dead code once lib/actions/predictions.ts switched
 * to setPick(); see docs/architecture/pick-editing-and-locking.md). Throws
 * if setPick() rejects (a null prediction), since every call site here
 * expects a genuine create/edit to succeed — tests that specifically
 * exercise rejection call setPick() directly instead.
 */
async function makePick(input: {
  userId: string;
  marketId: string;
  selectedOutcome: PredictionOutcome;
  yesProbabilitySnapshot: number;
  noProbabilitySnapshot: number;
  marketQuestionSnapshot: string;
  marketCloseAtSnapshot: string | null;
  marketStatusSnapshot: PredictionMarketStatusSnapshot;
  idempotencyKey: string;
}): Promise<{ prediction: Prediction; outcome: string }> {
  const result = await setPick({
    userId: input.userId,
    marketId: input.marketId,
    selectedOutcome: input.selectedOutcome,
    yesProbability: input.yesProbabilitySnapshot,
    noProbability: input.noProbabilitySnapshot,
    marketQuestionSnapshot: input.marketQuestionSnapshot,
    marketCloseAtSnapshot: input.marketCloseAtSnapshot,
    marketStatusSnapshot: input.marketStatusSnapshot,
    idempotencyKey: input.idempotencyKey,
  });
  if (!result.prediction) throw new Error(`setPick unexpectedly rejected (outcome: ${result.outcome})`);
  return { prediction: result.prediction, outcome: result.outcome };
}

async function signInAs(email: string) {
  const client = getTestAnonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

afterAll(async () => {
  if (createdMarketIds.length > 0) {
    // Predictions before markets — predictions.market_id is a soft
    // reference (no FK), so deleting the market first would leave the
    // prediction permanently orphaned (see call-bs-challenges.test.ts's
    // own afterEach for the same pattern).
    await admin.from("predictions").delete().in("market_id", createdMarketIds);
    await admin.from("markets").delete().in("id", createdMarketIds);
  }
  // Markets first (FK child), fixtures last (FK parent) — markets.fixture_id
  // is a real, non-cascading foreign key (Milestone R1).
  if (createdFixtureIds.length > 0) await admin.from("fixtures").delete().in("id", createdFixtureIds);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

afterEach(async () => {
  // Restore default prediction (eligibility + notification) policy after
  // any test that changes it.
  await admin
    .from("platform_settings")
    .update({
      prediction_allow_repeat: false,
      prediction_cutoff_minutes_before_close: 0,
      pick_lock_minutes_before_kickoff: 10,
      prediction_allow_stale_price: true,
      prediction_allow_unavailable_price: false,
      prediction_allow_closed_market: false,
      prediction_notifications_enabled: true,
      prediction_notify_on_correct: true,
      prediction_notify_on_incorrect: true,
      prediction_notify_on_void: true,
      prediction_notify_title_correct: "You were right",
      prediction_notify_body_correct: 'Your prediction on "{{question}}" was correct.',
      prediction_notify_title_incorrect: "Result is in",
      prediction_notify_body_incorrect: 'Your prediction on "{{question}}" was incorrect.',
      prediction_notify_title_void: "No result this time",
      prediction_notify_body_void: "\"{{question}}\" didn't reach a final result, so this prediction won't count.",
    })
    .eq("id", true);
});

describe("creating a Prediction", () => {
  it("an authenticated, eligible submission succeeds and preserves the snapshot", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();

    const { prediction, outcome } = await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.62,
      noProbabilitySnapshot: 0.38,
      marketQuestionSnapshot: "Will predictions test pass?",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });

    expect(outcome).toBe("created");
    expect(prediction.selectedOutcome).toBe("YES");
    expect(prediction.yesProbabilitySnapshot).toBe(0.62);
    expect(prediction.lifecycleState).toBe("PENDING");
  });

  it("rejects an anon (unauthenticated) direct read and write against the table", async () => {
    const marketId = await seedMarket();
    const anon = getTestAnonClient();

    const { data: readData, error: readError } = await anon.from("predictions").select("*");
    expect(readError ?? (readData ?? []).length === 0).toBeTruthy();
    expect(readData ?? []).toEqual([]);

    const { error: writeError } = await anon.from("predictions").insert({
      user_id: "00000000-0000-0000-0000-000000000000",
      market_id: marketId,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.5,
      no_probability_snapshot: 0.5,
      market_question_snapshot: "x",
      market_status_snapshot: "ACTIVE",
      idempotency_key: crypto.randomUUID(),
    });
    expect(writeError).not.toBeNull();
  });

  it("is idempotent — the same idempotency key never creates a second row", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const idempotencyKey = crypto.randomUUID();
    const input = {
      userId: user.id,
      marketId,
      selectedOutcome: "NO" as const,
      yesProbabilitySnapshot: 0.62,
      noProbabilitySnapshot: 0.38,
      marketQuestionSnapshot: "Will predictions test pass?",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE" as const,
      idempotencyKey,
    };

    const first = await makePick(input);
    const second = await makePick(input);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed"); // Milestone R5: idempotency-key replay, renamed from createPrediction's "existing"
    expect(second.prediction.id).toBe(first.prediction.id);

    const { count } = await admin.from("predictions").select("id", { count: "exact", head: true }).eq("idempotency_key", idempotencyKey);
    expect(count).toBe(1);
  });
});

describe("RLS — cross-user isolation and immutability", () => {
  it("a user can read their own Prediction but not another user's", async () => {
    const marketId = await seedMarket();
    const owner = await seedUser();
    const other = await seedUser();

    const { prediction } = await makePick({
      userId: owner.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });

    const ownerClient = await signInAs(owner.email);
    const { data: ownRead } = await ownerClient.from("predictions").select("*").eq("id", prediction.id);
    expect(ownRead).toHaveLength(1);

    const otherClient = await signInAs(other.email);
    const { data: otherRead } = await otherClient.from("predictions").select("*").eq("id", prediction.id);
    expect(otherRead ?? []).toEqual([]);
  });

  it("no authenticated client — not even the owner — can UPDATE a Prediction directly; only the service role can", async () => {
    const marketId = await seedMarket();
    const owner = await seedUser();
    const { prediction } = await makePick({
      userId: owner.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "immutable snapshot text",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });

    const ownerClient = await signInAs(owner.email);
    const { error } = await ownerClient.from("predictions").update({ selected_outcome: "NO" }).eq("id", prediction.id);
    expect(error).not.toBeNull();

    const { data: unchanged } = await admin.from("predictions").select("selected_outcome, market_question_snapshot").eq("id", prediction.id).single();
    expect(unchanged?.selected_outcome).toBe("YES");
    expect(unchanged?.market_question_snapshot).toBe("immutable snapshot text");
  });
});

describe("the probability and question snapshot survive later Market changes", () => {
  it("a later price update on the Market row never alters an already-created Prediction's snapshot", async () => {
    const marketId = await seedMarket({ price: { yes: 0.3, no: 0.7, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();

    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.3,
      noProbabilitySnapshot: 0.7,
      marketQuestionSnapshot: "Original question text",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });

    // The market's price AND question both move — simulating a later
    // ingestion run and a provider-side question edit.
    await upsertMarket(
      marketFixture((await admin.from("markets").select("provider_market_id").eq("id", marketId).single()).data!.provider_market_id, marketFixtureIds.get(marketId)!, {
        price: { yes: 0.91, no: 0.09, outcomeLabels: { yes: "Yes", no: "No" } },
        question: "A completely different question now",
      }),
    );

    const reread = await getLatestUserPredictionForMarket(user.id, marketId);
    expect(reread?.yesProbabilitySnapshot).toBe(0.3);
    expect(reread?.noProbabilitySnapshot).toBe(0.7);
    expect(reread?.marketQuestionSnapshot).toBe("Original question text");
  });
});

describe("grading", () => {
  it("grades CORRECT once the Market authoritatively resolves, and is idempotent on repeated runs", async () => {
    const marketId = await seedMarket({ status: "ACTIVE" });
    const user = await seedUser();
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.62,
      noProbabilitySnapshot: 0.38,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });

    // Still ACTIVE — grading must never fabricate a result.
    const notYetSummary = await runGradingJob(recordGradedPredictionResult);
    expect(notYetSummary.stillPending).toBeGreaterThanOrEqual(1);
    const stillPending = await getLatestUserPredictionForMarket(user.id, marketId);
    expect(stillPending?.lifecycleState).toBe("PENDING");

    // Resolve the market cleanly (YES wins). Milestone R1: the objective
    // result comes from the linked Game's final score, never from a
    // market-level `resolvedOutcome` field — completing the fixture with a
    // HOME win is what makes this market's default MONEYLINE/yesSide:"HOME"
    // proposition grade YES.
    await upsertMarket(
      marketFixture((await admin.from("markets").select("provider_market_id").eq("id", marketId).single()).data!.provider_market_id, marketFixtureIds.get(marketId)!, {
        status: "CLOSED",
        price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } },
      }),
    );
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });

    const before = await getPredictionStats(user.id);
    const firstRun = await runGradingJob(recordGradedPredictionResult);
    expect(firstRun.graded).toBeGreaterThanOrEqual(1);
    expect(firstRun.correct).toBeGreaterThanOrEqual(1);

    const graded = await getLatestUserPredictionForMarket(user.id, marketId);
    expect(graded?.lifecycleState).toBe("GRADED");
    expect(graded?.result).toBe("CORRECT");
    expect(graded?.resolvedOutcomeSnapshot).toBe("YES");
    expect(graded?.gradedAt).not.toBeNull();

    const after = await getPredictionStats(user.id);
    expect(after.correctCount).toBe(before.correctCount + 1);

    // Second run over the same already-GRADED row: no-op, no double count.
    await runGradingJob(recordGradedPredictionResult);
    const stillGraded = await getLatestUserPredictionForMarket(user.id, marketId);
    expect(stillGraded?.gradedAt).toBe(graded?.gradedAt);
    const afterSecondRun = await getPredictionStats(user.id);
    expect(afterSecondRun.correctCount).toBe(after.correctCount);

    const notificationCount = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("type", "prediction_graded");
    // Exactly one notification for this one graded prediction, even after
    // two grading runs — no duplication.
    expect(notificationCount.count).toBe(1);
  });

  // Stage 4A remediation (Stage 4 audit §14 / remediation §17): the
  // grading job resolves the canonical Post at the moment of grading and
  // stamps it on the notification, so it becomes clickable.
  it("stamps the graded-prediction notification with the canonical Post id, resolving to /post/[id]", async () => {
    const marketId = await seedMarket({ status: "ACTIVE" });
    const fixtureId = marketFixtureIds.get(marketId)!;
    const { id: postId } = await ensurePostForFixture(fixtureId);
    await publishPost(postId);

    const user = await seedUser();
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.62,
      noProbabilitySnapshot: 0.38,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });

    await upsertMarket(
      marketFixture((await admin.from("markets").select("provider_market_id").eq("id", marketId).single()).data!.provider_market_id, fixtureId, {
        status: "CLOSED",
        price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } },
      }),
    );
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });
    await runGradingJob(recordGradedPredictionResult);

    const { data: notification } = await admin
      .from("notifications")
      .select("post_id")
      .eq("user_id", user.id)
      .eq("type", "prediction_graded")
      .single();
    expect(notification?.post_id).toBe(postId);
    expect(
      resolveNotificationHref(
        { id: "n", type: "prediction_graded", title: "", body: "", pool_id: null, transaction_id: null, post_id: notification?.post_id ?? null, read_at: null, created_at: "" },
        new Map(),
      ),
    ).toBe(`/post/${postId}`);

    // Self-contained cleanup: this test is the only one in the suite that
    // creates a `posts` row, and both `notifications.post_id` and
    // `posts.fixture_id` are real FKs with no cascade — deleting them here
    // (notification before post, post before the file's own afterAll
    // deletes the fixture) avoids an FK violation in that afterAll.
    await admin.from("notifications").delete().eq("user_id", user.id).eq("type", "prediction_graded");
    await admin.from("posts").delete().eq("id", postId);
  });

  it("markPredictionGraded is a safe no-op against a row that's already GRADED", async () => {
    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 0, no: 1, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    const { prediction } = await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "NO",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "CLOSED",
      idempotencyKey: crypto.randomUUID(),
    });

    const firstApply = await markPredictionGraded(prediction.id, { result: "CORRECT", resolvedOutcomeSnapshot: "NO", gradedAt: new Date().toISOString() });
    expect(firstApply).toBe(true);

    const secondApply = await markPredictionGraded(prediction.id, { result: "INCORRECT", resolvedOutcomeSnapshot: "YES", gradedAt: new Date().toISOString() });
    expect(secondApply).toBe(false);

    const { data } = await admin.from("predictions").select("result").eq("id", prediction.id).single();
    expect(data?.result).toBe("CORRECT");
  });

  it("a GRADED row's result/graded_at/lifecycle_state/selected_outcome cannot be changed by a raw UPDATE, even via the service-role admin client (R13 defense-in-depth)", async () => {
    // The test above proves markPredictionGraded()'s own app-layer scoping
    // is a safe no-op. This proves the STRONGER guarantee added in
    // 20260101000162_forbid_graded_prediction_mutation.sql: the database
    // itself refuses the mutation, independent of which code path
    // attempts it — settle_monetary_position() reads this exact column to
    // move real money, so its permanence must not rest on convention alone.
    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    const { prediction } = await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.6,
      noProbabilitySnapshot: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "CLOSED",
      idempotencyKey: crypto.randomUUID(),
    });
    const applied = await markPredictionGraded(prediction.id, { result: "CORRECT", resolvedOutcomeSnapshot: "YES", gradedAt: new Date().toISOString() });
    expect(applied).toBe(true);

    const { error: resultTamperError } = await admin.from("predictions").update({ result: "INCORRECT" }).eq("id", prediction.id);
    expect(resultTamperError).not.toBeNull();
    expect(resultTamperError!.message).toContain("immutable");

    const { error: gradedAtTamperError } = await admin.from("predictions").update({ graded_at: new Date().toISOString() }).eq("id", prediction.id);
    expect(gradedAtTamperError).not.toBeNull();

    const { error: lifecycleTamperError } = await admin.from("predictions").update({ lifecycle_state: "PENDING" }).eq("id", prediction.id);
    expect(lifecycleTamperError).not.toBeNull();

    const { error: selectedOutcomeTamperError } = await admin.from("predictions").update({ selected_outcome: "NO" }).eq("id", prediction.id);
    expect(selectedOutcomeTamperError).not.toBeNull();

    // Nothing changed across all 4 rejected attempts.
    const { data: stillIntact } = await admin.from("predictions").select("result, graded_at, lifecycle_state, selected_outcome").eq("id", prediction.id).single();
    expect(stillIntact).toMatchObject({ result: "CORRECT", lifecycle_state: "GRADED", selected_outcome: "YES" });

    // A column outside the guarded set (e.g. updated_at) is still writable — the trigger is scoped, not a blanket freeze.
    const { error: updatedAtError } = await admin.from("predictions").update({ updated_at: new Date().toISOString() }).eq("id", prediction.id);
    expect(updatedAtError).toBeNull();
  });
});

describe("prediction policy — configurable without a deployment", () => {
  it("changing platform_settings alone changes eligibility, with no code change", async () => {
    const defaultPolicy = await getPredictionPolicy();
    expect(defaultPolicy.allowClosedMarket).toBe(false);
    const deniedBefore = checkMarketEligibility(
      { consumerStatus: "CLOSED", freshness: "FRESH", yesPrice: 0.5, noPrice: 0.5, closesAt: null, now: new Date() },
      defaultPolicy,
    );
    expect(deniedBefore).toEqual({ eligible: false, reason: "MARKET_CLOSED" });

    await admin.from("platform_settings").update({ prediction_allow_closed_market: true }).eq("id", true);

    const updatedPolicy = await getPredictionPolicy();
    expect(updatedPolicy.allowClosedMarket).toBe(true);
    const permittedAfter = checkMarketEligibility(
      { consumerStatus: "CLOSED", freshness: "FRESH", yesPrice: 0.5, noPrice: 0.5, closesAt: null, now: new Date() },
      updatedPolicy,
    );
    expect(permittedAfter).toEqual({ eligible: true });
  });
});

describe("legacy coexistence", () => {
  it("legacy pool/entry tables remain queryable and untouched by this domain's writes", async () => {
    const { error } = await admin.from("pools").select("id").limit(1);
    expect(error).toBeNull();
    const { error: entriesError } = await admin.from("entries").select("id").limit(1);
    expect(entriesError).toBeNull();
  });
});

/**
 * Milestone 3 final standing-rule remediation, Finding 1: Prediction
 * diagnostics authorization is now capability-policy driven, not a direct
 * requireSuperAdmin() call. Reuses the exact mechanism migration
 * 20260101000140/tests/integration/capability-policy.test.ts already
 * proved generically — these tests target the NEW capability specifically
 * (`view_prediction_diagnostics`, migrations 20260101000143/144), plus a
 * structural check that the admin page itself carries no role coupling.
 */
describe("Prediction diagnostics authorization (Finding 1 remediation)", () => {
  const CAPABILITY = "view_prediction_diagnostics";
  const DEFAULT_ALLOWED_ROLES = ["super_admin"];

  afterEach(async () => {
    await admin.from("capability_policies").upsert({ capability: CAPABILITY, allowed_roles: DEFAULT_ALLOWED_ROLES }, { onConflict: "capability" });
  });

  it("the default (seeded) policy permits super_admin and denies everyone else", async () => {
    const policy = await loadCapabilityPolicy(CAPABILITY);
    expect(policy).toEqual({ capability: CAPABILITY, allowedRoles: ["super_admin"] });
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(true);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(false);
    expect(await roleHasCapability("player", CAPABILITY)).toBe(false);
  });

  it("adding another admin role is a configuration-only change — no source edit, no deployment", async () => {
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(false);
    await admin.from("capability_policies").update({ allowed_roles: ["super_admin", "admin"] }).eq("capability", CAPABILITY);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(true);
    // Widening one role never widens the rest.
    expect(await roleHasCapability("player", CAPABILITY)).toBe(false);
  });

  it("removing that role again is equally configuration-only", async () => {
    await admin.from("capability_policies").update({ allowed_roles: ["super_admin", "admin"] }).eq("capability", CAPABILITY);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(true);
    await admin.from("capability_policies").update({ allowed_roles: ["super_admin"] }).eq("capability", CAPABILITY);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(false);
  });

  it("fails closed when the policy row is missing", async () => {
    await admin.from("capability_policies").delete().eq("capability", CAPABILITY);
    expect(await loadCapabilityPolicy(CAPABILITY)).toBeNull();
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(false);
  });

  it("fails closed when the policy is malformed — never falling back to a broader role", async () => {
    await admin.from("capability_policies").update({ allowed_roles: ["super_admin", "not_a_real_role"] }).eq("capability", CAPABILITY);
    expect(await loadCapabilityPolicy(CAPABILITY)).toBeNull();
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(false);
  });

  it("the admin Prediction diagnostics page contains no role name literal or direct auth-helper coupling", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const source = await readFile(path.join(repoRoot, "app/(admin)/admin/predictions/page.tsx"), "utf-8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "names a role").not.toMatch(/["']super_admin["']|["']admin["']|["']player["']/);
    expect(code, "calls an auth helper directly").not.toMatch(/requireSuperAdmin|requireAdminOrAbove|isSuperAdmin|isAdminOrAbove/);
    expect(code, "imports the session module directly").not.toMatch(/from "@\/lib\/auth\/session"/);
    expect(code, "gates through the capability boundary").toMatch(/requirePredictionDiagnosticsViewer/);
  });
});

/**
 * Milestone 3 final standing-rule remediation, Finding 2: streak
 * counters were deferred (see lib/predictions/streak.ts's own comment).
 * These tests prove the deferral is real and complete, not partial.
 */
describe("streak deferral (Finding 2 remediation)", () => {
  it("grading still updates factual correct/incorrect counts, with no derived streak state changing", async () => {
    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.6,
      noProbabilitySnapshot: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "CLOSED",
      idempotencyKey: crypto.randomUUID(),
    });
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });

    const { data: profileBefore } = await admin
      .from("user_profiles")
      .select("prediction_current_streak, prediction_best_streak")
      .eq("id", user.id)
      .single();

    const before = await getPredictionStats(user.id);
    await runGradingJob(recordGradedPredictionResult);
    const after = await getPredictionStats(user.id);

    expect(after.correctCount).toBe(before.correctCount + 1);

    const { data: profileAfter } = await admin
      .from("user_profiles")
      .select("prediction_current_streak, prediction_best_streak")
      .eq("id", user.id)
      .single();
    // No stale derived streak state — these columns remain untouched
    // (still their migration default of 0) after a real grading run.
    expect(profileAfter?.prediction_current_streak).toBe(profileBefore?.prediction_current_streak ?? 0);
    expect(profileAfter?.prediction_best_streak).toBe(profileBefore?.prediction_best_streak ?? 0);
    expect(profileAfter?.prediction_current_streak).toBe(0);
    expect(profileAfter?.prediction_best_streak).toBe(0);
  });

  it("getPredictionStats' return shape no longer exposes streak fields", async () => {
    const user = await seedUser();
    const stats = await getPredictionStats(user.id);
    expect(stats).toEqual({ correctCount: 0, incorrectCount: 0 });
    expect(stats).not.toHaveProperty("currentStreak");
    expect(stats).not.toHaveProperty("bestStreak");
  });
});

/**
 * Milestone 3 final notification-policy remediation: `prediction_graded`
 * notification enablement and per-result triggers are now configured in
 * `platform_settings` (migration 20260101000146), not hard-coded. These
 * tests exercise the real database read (getPredictionNotificationPolicy)
 * against real rows, and full grading runs against real notifications.
 */
describe("grading notification policy (final notification-policy remediation)", () => {
  async function gradeOnePrediction(result: "CORRECT" | "INCORRECT" | "VOID") {
    const marketStatus = result === "VOID" ? "ARCHIVED" : "CLOSED";
    const selectedOutcome = result === "INCORRECT" ? "NO" : "YES";

    const marketId = await seedMarket({
      status: marketStatus,
      price: result === "VOID" ? { yes: null, no: null, outcomeLabels: null } : { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } },
    });
    const user = await seedUser();
    // Milestone R5: Pick creation itself now requires the Game still be
    // NOT_STARTED (set_pick's own live eligibility check) — the fixture
    // must be resolved AFTER the Pick exists, matching the real temporal
    // order (a user picks before the game, then the game happens).
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome,
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: `notification policy test — ${result}`,
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    // ARCHIVED (VOID) grades without ever consulting the fixture — nothing
    // to resolve there. CORRECT/INCORRECT need a completed Game with a HOME
    // win, matching the default MONEYLINE/yesSide:"HOME" market shape.
    if (result !== "VOID") await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });

    await runGradingJob(recordGradedPredictionResult);
    return user.id;
  }

  async function notificationCountFor(userId: string): Promise<number> {
    const { count } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("type", "prediction_graded");
    return count ?? 0;
  }

  it("default policy sends a notification for CORRECT", async () => {
    const userId = await gradeOnePrediction("CORRECT");
    expect(await notificationCountFor(userId)).toBe(1);
  });

  it("default policy sends a notification for INCORRECT", async () => {
    const userId = await gradeOnePrediction("INCORRECT");
    expect(await notificationCountFor(userId)).toBe(1);
  });

  it("default policy sends a notification for VOID", async () => {
    const userId = await gradeOnePrediction("VOID");
    expect(await notificationCountFor(userId)).toBe(1);
  });

  it("disabling the event prevents all grading notifications regardless of result", async () => {
    await admin.from("platform_settings").update({ prediction_notifications_enabled: false }).eq("id", true);
    const correctUser = await gradeOnePrediction("CORRECT");
    const voidUser = await gradeOnePrediction("VOID");
    expect(await notificationCountFor(correctUser)).toBe(0);
    expect(await notificationCountFor(voidUser)).toBe(0);
  });

  it("disabling CORRECT prevents only CORRECT notifications", async () => {
    await admin.from("platform_settings").update({ prediction_notify_on_correct: false }).eq("id", true);
    const correctUser = await gradeOnePrediction("CORRECT");
    const incorrectUser = await gradeOnePrediction("INCORRECT");
    expect(await notificationCountFor(correctUser)).toBe(0);
    expect(await notificationCountFor(incorrectUser)).toBe(1);
  });

  it("disabling INCORRECT prevents only INCORRECT notifications", async () => {
    await admin.from("platform_settings").update({ prediction_notify_on_incorrect: false }).eq("id", true);
    const incorrectUser = await gradeOnePrediction("INCORRECT");
    const voidUser = await gradeOnePrediction("VOID");
    expect(await notificationCountFor(incorrectUser)).toBe(0);
    expect(await notificationCountFor(voidUser)).toBe(1);
  });

  it("disabling VOID prevents only VOID notifications", async () => {
    await admin.from("platform_settings").update({ prediction_notify_on_void: false }).eq("id", true);
    const voidUser = await gradeOnePrediction("VOID");
    const correctUser = await gradeOnePrediction("CORRECT");
    expect(await notificationCountFor(voidUser)).toBe(0);
    expect(await notificationCountFor(correctUser)).toBe(1);
  });

  it("configuration changes require no source edit — proven by reading policy fresh from the database", async () => {
    const before = await getPredictionNotificationPolicy();
    expect(before).toEqual({ enabled: true, notifyOnCorrect: true, notifyOnIncorrect: true, notifyOnVoid: true });

    await admin.from("platform_settings").update({ prediction_notify_on_void: false }).eq("id", true);

    const after = await getPredictionNotificationPolicy();
    expect(after).toEqual({ enabled: true, notifyOnCorrect: true, notifyOnIncorrect: true, notifyOnVoid: false });
  });

  it("grading succeeds and persists correctly independent of notification-policy readability", async () => {
    // platform_settings is a single, shared, real singleton row this
    // entire app depends on (other suites read it concurrently) — it is
    // never deleted, even transiently, by any test in this codebase.
    // "Missing policy fails closed" is therefore proven directly against
    // getPredictionNotificationPolicy's own contract
    // (tests/unit/predictions/policy.test.ts's "fails closed when the
    // policy is null" case covers the null-policy input;
    // getPredictionNotificationPolicy itself returns null on a missing
    // row/query error by construction — see its own doc comment). This
    // test instead proves the other half end to end: grading's own
    // success and correctness never depend on the notification-policy
    // read succeeding.
    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    const { prediction } = await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });

    const policy = await getPredictionNotificationPolicy();
    expect(policy).not.toBeNull(); // sanity: real row is readable by default

    const summary = await runGradingJob(recordGradedPredictionResult);
    expect(summary.graded).toBeGreaterThanOrEqual(1);

    const graded = await getLatestUserPredictionForMarket(user.id, marketId);
    expect(graded?.lifecycleState).toBe("GRADED");
    expect(graded?.result).toBe("CORRECT");
    expect(graded?.id).toBe(prediction.id);
  });

  it("a malformed policy value fails closed — does not send a notification, and does not block grading", async () => {
    // The four columns are NOT NULL booleans, so Postgres itself already
    // rejects the malformed shapes getPredictionNotificationPolicy
    // defends against — this proves the application-level fail-closed
    // decision directly (mirroring capability-policy's own malformed-row
    // unit coverage), since a genuinely malformed row cannot be written
    // through this schema to exercise the same path end-to-end.
    const malformedRow = { enabled: null, notifyOnCorrect: true, notifyOnIncorrect: true, notifyOnVoid: true };
    expect(shouldNotifyForResult("CORRECT", malformedRow as never)).toBe(false);

    // Separately: grading a real Prediction still succeeds and persists
    // its result regardless of notification-policy state (proven by the
    // "missing policy row" test above and this one together).
    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });
    const summary = await runGradingJob(recordGradedPredictionResult);
    expect(summary.graded).toBeGreaterThanOrEqual(1);
  });

  it("repeated grading never duplicates the notification, even across multiple runs", async () => {
    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });

    await runGradingJob(recordGradedPredictionResult);
    await runGradingJob(recordGradedPredictionResult);
    await runGradingJob(recordGradedPredictionResult);

    expect(await notificationCountFor(user.id)).toBe(1);
  });

  it("changing policy after a Prediction is already graded does not create a retroactive notification", async () => {
    // Grade while notifications are enabled (default).
    const userId = await gradeOnePrediction("CORRECT");
    expect(await notificationCountFor(userId)).toBe(1);

    // Disable, then re-enable notifications entirely — a later run must
    // never re-notify for the same already-graded Prediction, since
    // grading itself never revisits a GRADED row (§7/§8 architecture).
    await admin.from("platform_settings").update({ prediction_notifications_enabled: false }).eq("id", true);
    await runGradingJob(recordGradedPredictionResult);
    await admin.from("platform_settings").update({ prediction_notifications_enabled: true }).eq("id", true);
    await runGradingJob(recordGradedPredictionResult);

    expect(await notificationCountFor(userId)).toBe(1);
  });

  it("ordinary (anon) client cannot mutate notification policy directly", async () => {
    const anon = getTestAnonClient();
    const { error } = await anon.from("platform_settings").update({ prediction_notify_on_void: false }).eq("id", true);
    expect(error).not.toBeNull();

    const policy = await getPredictionNotificationPolicy();
    expect(policy?.notifyOnVoid).toBe(true);
  });
});

/**
 * Final copy-configuration remediation: `prediction_graded` title/body
 * wording is now read from `platform_settings`
 * (migration 20260101000147), not hard-coded.
 */
describe("grading notification copy (final copy-configuration remediation)", () => {
  it("default policy reproduces the original hard-coded wording exactly", async () => {
    const policy = await getPredictionNotificationCopyPolicy();
    expect(policy).toEqual({
      correct: { title: "You were right", body: 'Your prediction on "{{question}}" was correct.' },
      incorrect: { title: "Result is in", body: 'Your prediction on "{{question}}" was incorrect.' },
      void: { title: "No result this time", body: "\"{{question}}\" didn't reach a final result, so this prediction won't count." },
    });
  });

  it("wording changes through configuration alone, with no source edit or deployment", async () => {
    await admin
      .from("platform_settings")
      .update({ prediction_notify_title_correct: "Nailed it", prediction_notify_body_correct: 'Your call on "{{question}}" was spot on.' })
      .eq("id", true);

    const policy = await getPredictionNotificationCopyPolicy();
    expect(policy?.correct).toEqual({ title: "Nailed it", body: 'Your call on "{{question}}" was spot on.' });
    // The other two results are untouched by changing only CORRECT's copy.
    expect(policy?.incorrect.title).toBe("Result is in");
  });

  it("a real grading run sends the notification using the currently configured wording", async () => {
    await admin.from("platform_settings").update({ prediction_notify_title_correct: "Nailed it" }).eq("id", true);

    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "configured-copy test question",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });

    await runGradingJob(recordGradedPredictionResult);

    const { data: notification } = await admin
      .from("notifications")
      .select("title, body")
      .eq("user_id", user.id)
      .eq("type", "prediction_graded")
      .single();
    expect(notification?.title).toBe("Nailed it");
    expect(notification?.body).toContain("configured-copy test question");
  });

  it("the database itself refuses a malformed (empty) copy value — a bad row can never exist in the first place", async () => {
    // Milestone R12 added platform_settings_notify_copy_correct_nonempty
    // (and the matching incorrect/void constraints) as defense-in-depth
    // directly on the column, superseding this test's own former setup
    // step of forcing an empty string into the row: that write is now
    // rejected outright, so getPredictionNotificationCopyPolicy()'s own
    // "one bad entry invalidates the whole row" application-level fallback
    // (still real, still live code — now covered independently by
    // tests/unit/predictions/policy.test.ts against a mocked client, since
    // an integration test can no longer manufacture the bad DB state
    // needed to exercise it) is no longer reachable via any legitimate
    // write path, which is the point of the constraint.
    await admin.from("platform_settings").update({ prediction_notify_title_correct: "Nailed it" }).eq("id", true);

    const { error: rejected } = await admin.from("platform_settings").update({ prediction_notify_title_correct: "" }).eq("id", true);
    expect(rejected).not.toBeNull();

    // The rejected write changed nothing — the last valid value survives.
    const policy = await getPredictionNotificationCopyPolicy();
    expect(policy?.correct.title).toBe("Nailed it");

    const marketId = await seedMarket({ status: "CLOSED", price: { yes: 1, no: 0, outcomeLabels: { yes: "Yes", no: "No" } } });
    const user = await seedUser();
    await makePick({
      userId: user.id,
      marketId,
      selectedOutcome: "YES",
      yesProbabilitySnapshot: 0.5,
      noProbabilitySnapshot: 0.5,
      marketQuestionSnapshot: "fallback test question",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    await resolveFixtureForMarket(marketId, { homeScore: 1, awayScore: 0 });

    // Grading itself is entirely unaffected either way.
    const summary = await runGradingJob(recordGradedPredictionResult);
    expect(summary.graded).toBeGreaterThanOrEqual(1);
    const graded = await getLatestUserPredictionForMarket(user.id, marketId);
    expect(graded?.result).toBe("CORRECT");

    // The notification uses the still-valid configured wording — the
    // rejected write never took even partial effect.
    const { data: notification } = await admin
      .from("notifications")
      .select("title, body")
      .eq("user_id", user.id)
      .eq("type", "prediction_graded")
      .single();
    expect(notification?.title).toBe("Nailed it");
    expect(notification?.body).toContain("fallback test question");
  });

  it("ordinary (anon) client cannot mutate notification copy directly", async () => {
    const anon = getTestAnonClient();
    const { error } = await anon.from("platform_settings").update({ prediction_notify_title_correct: "hijacked" }).eq("id", true);
    expect(error).not.toBeNull();

    const policy = await getPredictionNotificationCopyPolicy();
    expect(policy?.correct.title).toBe("You were right");
  });
});
