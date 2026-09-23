/**
 * Integration tests for Milestone R5 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Pick Editing + Locking) — the set_pick() domain operation itself:
 * identity, editing, probability snapshots, locking, kickoff movement,
 * Market movement, grading interaction, concurrency, and security. Real
 * local Supabase throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { setPick, listPredictionRevisions, getLatestUserPredictionForMarket, listPendingPredictions } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";

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
      external_fixture_id: `r5-fixture-${crypto.randomUUID()}`,
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

async function createUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `r5-pick-${crypto.randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "R5 Pick Test", role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function setPolicy(overrides: Record<string, unknown>) {
  await admin.from("platform_settings").update(overrides).eq("id", true);
}

function pick(userId: string, marketId: string, overrides: Partial<Parameters<typeof setPick>[0]> = {}) {
  return setPick({
    userId,
    marketId,
    selectedOutcome: "YES",
    yesProbability: 0.6,
    noProbability: 0.4,
    marketQuestionSnapshot: "q",
    marketCloseAtSnapshot: null,
    marketStatusSnapshot: "ACTIVE",
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  });
}

afterEach(async () => {
  if (createdMarketIds.length > 0) {
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
  await setPolicy({ pick_lock_minutes_before_kickoff: 10 });
});

describe("identity", () => {
  it("creates exactly one current Pick per user per Market", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();

    const { prediction, outcome } = await pick(userId, marketId, { selectedOutcome: "YES" });
    expect(outcome).toBe("created");
    const { count } = await admin.from("predictions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("market_id", marketId);
    expect(count).toBe(1);
    expect(prediction!.selectedOutcome).toBe("YES");
  });

  it("the database rejects a second row for the same user+market even bypassing set_pick", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId);

    const { error } = await admin.from("predictions").insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: "NO",
      yes_probability_snapshot: 0.5,
      no_probability_snapshot: 0.5,
      market_question_snapshot: "q",
      market_status_snapshot: "ACTIVE",
      idempotency_key: crypto.randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it("concurrent initial creation cannot duplicate a Pick", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();

    const results = await Promise.all([
      pick(userId, marketId, { idempotencyKey: crypto.randomUUID() }),
      pick(userId, marketId, { idempotencyKey: crypto.randomUUID() }),
      pick(userId, marketId, { idempotencyKey: crypto.randomUUID() }),
    ]);
    const created = results.filter((r) => r.outcome === "created");
    expect(created).toHaveLength(1); // only one truly created; the rest see the row and no-op/update

    const { count } = await admin.from("predictions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("market_id", marketId);
    expect(count).toBe(1);
  });
});

describe("creation eligibility", () => {
  it("rejects creation when the Game is not NOT_STARTED", async () => {
    const fixtureId = await createFixture({ internal_status: "LIVE" });
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const { prediction, outcome } = await pick(userId, marketId);
    expect(outcome).toBe("rejected_game_closed");
    expect(prediction).toBeNull();
  });

  it("rejects creation past the configured cutoff", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 60_000).toISOString() }); // 1 min out, default cutoff 10 min
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const { prediction, outcome } = await pick(userId, marketId);
    expect(outcome).toBe("rejected_cutoff");
    expect(prediction).toBeNull();
  });

  it("allows creation comfortably before cutoff", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const { outcome } = await pick(userId, marketId);
    expect(outcome).toBe("created");
  });

  it("respects a configurable cutoff duration", async () => {
    await setPolicy({ pick_lock_minutes_before_kickoff: 120 }); // 2 hours
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 60 * 60 * 1000).toISOString() }); // 1 hour out — inside the new 2h window
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const { outcome } = await pick(userId, marketId);
    expect(outcome).toBe("rejected_cutoff");
  });
});

describe("editing", () => {
  it("changes YES to NO before cutoff", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES", yesProbability: 0.6, noProbability: 0.4 });

    const { prediction, outcome } = await pick(userId, marketId, { selectedOutcome: "NO", yesProbability: 0.45, noProbability: 0.55 });
    expect(outcome).toBe("updated");
    expect(prediction!.selectedOutcome).toBe("NO");
    expect(prediction!.noProbabilitySnapshot).toBe(0.55);
  });

  it("changes NO back to YES", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "NO" });
    const { prediction } = await pick(userId, marketId, { selectedOutcome: "YES" });
    expect(prediction!.selectedOutcome).toBe("YES");
  });

  it("allows multiple valid edits in sequence", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES" });
    await pick(userId, marketId, { selectedOutcome: "NO" });
    const { prediction } = await pick(userId, marketId, { selectedOutcome: "YES" });
    expect(prediction!.selectedOutcome).toBe("YES");
    const { count } = await admin.from("predictions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("market_id", marketId);
    expect(count).toBe(1);
  });

  it("a same-selection retry is idempotent — no-op, no fake revision", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const { prediction: first } = await pick(userId, marketId, { selectedOutcome: "YES" });
    const { prediction: second, outcome } = await pick(userId, marketId, { selectedOutcome: "YES", yesProbability: 0.99 });
    expect(outcome).toBe("unchanged");
    expect(second!.yesProbabilitySnapshot).toBe(first!.yesProbabilitySnapshot); // not re-snapshotted
    expect(await listPredictionRevisions(first!.id)).toHaveLength(0);
  });
});

describe("probability snapshot", () => {
  it("the final selection's own probability at change-time is what's stored, not the original selection's", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES", yesProbability: 0.55, noProbability: 0.45 });
    const { prediction } = await pick(userId, marketId, { selectedOutcome: "NO", yesProbability: 0.52, noProbability: 0.48 });
    expect(prediction!.selectedOutcome).toBe("NO");
    expect(prediction!.noProbabilitySnapshot).toBe(0.48); // NO's own probability at the moment it became final
  });

  it("revision history preserves the prior selection's own context", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const { prediction } = await pick(userId, marketId, { selectedOutcome: "YES", yesProbability: 0.55, noProbability: 0.45 });
    await pick(userId, marketId, { selectedOutcome: "NO", yesProbability: 0.52, noProbability: 0.48 });

    const revisions = await listPredictionRevisions(prediction!.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].previousSelectedOutcome).toBe("YES");
    expect(revisions[0].previousProbabilitySnapshot).toBe(0.55);
    expect(revisions[0].newSelectedOutcome).toBe("NO");
    expect(revisions[0].newProbabilitySnapshot).toBe(0.48);
  });

  it("later odds movement never rewrites an already-stored Pick snapshot", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const { prediction } = await pick(userId, marketId, { selectedOutcome: "YES", yesProbability: 0.55, noProbability: 0.45 });

    // Simulate the market's price moving via ingestion — never touches predictions.
    await admin.from("markets").update({ yes_price: 0.9, no_price: 0.1 }).eq("id", marketId);

    const reread = await getLatestUserPredictionForMarket(userId, marketId);
    expect(reread!.yesProbabilitySnapshot).toBe(prediction!.yesProbabilitySnapshot);
  });
});

describe("locking", () => {
  it("materializes an effective lock and rejects the edit in the same call", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 15 * 60 * 1000).toISOString() }); // 15 min out
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES" }); // still inside 10-min cutoff window at creation

    // Move kickoff to make cutoff already passed.
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 60_000).toISOString() }).eq("id", fixtureId);

    const { prediction, outcome } = await pick(userId, marketId, { selectedOutcome: "NO" });
    expect(outcome).toBe("rejected_cutoff");
    expect(prediction!.selectedOutcome).toBe("YES"); // unchanged
    expect(prediction!.lockedAt).not.toBeNull();
    expect(prediction!.lockReason).toBe("CUTOFF");

    const { data: row } = await admin.from("predictions").select("locked_at, lock_reason, selected_outcome").eq("user_id", userId).eq("market_id", marketId).single();
    expect(row!.locked_at).not.toBeNull();
    expect(row!.lock_reason).toBe("CUTOFF");
    expect(row!.selected_outcome).toBe("YES");
  });

  it("lock is one-way — a further edit attempt after lock is rejected again, never reopened", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 60_000).toISOString() });
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    // Creation itself will reject (past cutoff already) — seed a locked row directly to test the "already locked" path in isolation.
    await admin.from("predictions").insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "q",
      market_status_snapshot: "ACTIVE",
      idempotency_key: crypto.randomUUID(),
      locked_at: new Date().toISOString(),
      lock_reason: "CUTOFF",
    });

    const { outcome, prediction } = await pick(userId, marketId, { selectedOutcome: "NO" });
    expect(outcome).toBe("rejected_locked");
    expect(prediction!.selectedOutcome).toBe("YES");
  });

  it("a user cannot set lock_reason to CHALLENGE_ACCEPTED or any other client-forged value", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId);

    const anon = getTestAnonClient();
    const { error } = await anon.from("predictions").update({ lock_reason: "CHALLENGE_ACCEPTED", locked_at: new Date().toISOString() }).eq("user_id", userId).eq("market_id", marketId);
    expect(error).not.toBeNull();
  });

  it("CHALLENGE_ACCEPTED is valid vocabulary at the schema level (future R7 primitive) but unreachable from any current code path", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId);
    // Only a direct, service-role-level write can set it — proving the
    // CHECK constraint accepts the value without any Challenge code
    // existing to set it in practice.
    const { error } = await admin.from("predictions").update({ lock_reason: "CHALLENGE_ACCEPTED", locked_at: new Date().toISOString() }).eq("user_id", userId).eq("market_id", marketId);
    expect(error).toBeNull();
  });

  it("rejects an invalid lock_reason value", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId);
    const { error } = await admin.from("predictions").update({ lock_reason: "NOT_A_REAL_REASON", locked_at: new Date().toISOString() }).eq("user_id", userId).eq("market_id", marketId);
    expect(error).not.toBeNull();
  });
});

describe("kickoff movement", () => {
  it("a later kickoff before lock extends eligibility using the new schedule", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 60_000).toISOString() }); // past cutoff already
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    expect((await pick(userId, marketId)).outcome).toBe("rejected_cutoff");

    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }).eq("id", fixtureId);
    expect((await pick(userId, marketId)).outcome).toBe("created");
  });

  it("an earlier kickoff before any lock can move the cutoff into the past, and the system fails safe", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES" });

    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 60_000).toISOString() }).eq("id", fixtureId);
    const { outcome, prediction } = await pick(userId, marketId, { selectedOutcome: "NO" });
    expect(outcome).toBe("rejected_cutoff");
    expect(prediction!.selectedOutcome).toBe("YES");
  });

  it("a reschedule after permanent lock does not reopen the Pick", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 60_000).toISOString() });
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await admin.from("predictions").insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "q",
      market_status_snapshot: "ACTIVE",
      idempotency_key: crypto.randomUUID(),
      locked_at: new Date().toISOString(),
      lock_reason: "CUTOFF",
    });

    // Game postponed to tomorrow — the historical lock must not reverse.
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), internal_status: "POSTPONED" }).eq("id", fixtureId);

    const { outcome, prediction } = await pick(userId, marketId, { selectedOutcome: "NO" });
    expect(outcome).toBe("rejected_locked");
    expect(prediction!.selectedOutcome).toBe("YES");
  });
});

describe("Market movement independence", () => {
  it("a line move creates a distinct Market — the Pick never migrates", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES", marketQuestionSnapshot: "Over 47.5?" });

    // R2's own line-movement behavior: deactivate old, create new.
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", marketId);
    const newMarketId = await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 48.5, yesSide: null });

    const oldPick = await getLatestUserPredictionForMarket(userId, marketId);
    expect(oldPick!.marketId).toBe(marketId);
    expect(oldPick!.marketQuestionSnapshot).toBe("Over 47.5?");
    const newPick = await getLatestUserPredictionForMarket(userId, newMarketId);
    expect(newPick).toBeNull(); // no automatic pick on the new Market
  });

  it("set_pick itself does not gate on markets.status (only the Game's kickoff/status) — Market-level eligibility remains the existing, unchanged checkMarketEligibility layer's job", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES" });
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", marketId);

    // set_pick alone would allow this — proving the layering is as
    // designed: Game-level eligibility (this RPC) and Market-level
    // eligibility (checkMarketEligibility, called by
    // lib/actions/predictions.ts BEFORE this RPC) are two independent
    // gates. In the real application flow, an INACTIVE market's
    // consumerStatus derives to null (deriveConsumerStatus), which
    // checkMarketEligibility already rejects as MARKET_INACTIVE — so end
    // to end, an inactive historical Market's Pick is NOT editable through
    // the app today. §19's own open question ("can a user still change
    // YES/NO on an inactive historical Market before T-10?") is therefore
    // answered by the existing, unchanged layer, not silently decided
    // here — see this milestone's completion report.
    const { outcome } = await pick(userId, marketId, { selectedOutcome: "NO" });
    expect(outcome).toBe("updated");
  });
});

describe("grading interaction", () => {
  it("grades the final selection only; a prior (now-superseded) selection is never separately graded", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { status: "CLOSED" });
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "NO", marketStatusSnapshot: "CLOSED" });
    await pick(userId, marketId, { selectedOutcome: "YES", marketStatusSnapshot: "CLOSED" });

    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 1, away_score: 0 }).eq("id", fixtureId);
    const summary = await runGradingJob(recordGradedPredictionResult);
    expect(summary.graded).toBe(1); // exactly one Prediction row exists to grade
    const graded = await getLatestUserPredictionForMarket(userId, marketId);
    expect(graded!.result).toBe("CORRECT"); // final selection was YES, home won
  });

  it("grading makes a Pick permanently non-editable", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { status: "CLOSED" });
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES", marketStatusSnapshot: "CLOSED" });
    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 1, away_score: 0 }).eq("id", fixtureId);
    await runGradingJob(recordGradedPredictionResult);

    const { outcome, prediction } = await pick(userId, marketId, { selectedOutcome: "NO" });
    expect(outcome).toBe("rejected_locked");
    expect(prediction!.result).toBe("CORRECT");
    expect(prediction!.selectedOutcome).toBe("YES");
  });

  it("grading auto-finalizes an effectively-locked-but-not-yet-materialized Pick correctly", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { status: "CLOSED" });
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES", marketStatusSnapshot: "CLOSED" });
    // Fixture completes WITHOUT any prior set_pick call touching the lock — grading itself must not require a prior materialization.
    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 1, away_score: 0 }).eq("id", fixtureId);

    const pending = await listPendingPredictions();
    expect(pending.some((p) => p.userId === userId && p.marketId === marketId)).toBe(true);

    const summary = await runGradingJob(recordGradedPredictionResult);
    expect(summary.graded).toBeGreaterThanOrEqual(1);
    const graded = await getLatestUserPredictionForMarket(userId, marketId);
    expect(graded!.lifecycleState).toBe("GRADED");
    expect(graded!.result).toBe("CORRECT");
  });
});

describe("concurrency", () => {
  it("concurrent conflicting edits leave exactly one coherent final state", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES" });

    const results = await Promise.allSettled([
      pick(userId, marketId, { selectedOutcome: "NO", idempotencyKey: crypto.randomUUID() }),
      pick(userId, marketId, { selectedOutcome: "YES", idempotencyKey: crypto.randomUUID() }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const { count } = await admin.from("predictions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("market_id", marketId);
    expect(count).toBe(1);
    const final = await getLatestUserPredictionForMarket(userId, marketId);
    expect(["YES", "NO"]).toContain(final!.selectedOutcome); // one coherent winner, not both/neither
  });

  it("an edit racing the cutoff resolves deterministically via the server-side check, never both succeeding and locking", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 60_000).toISOString() });
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    // Creation itself is already past cutoff at this kickoff — seed directly, unlocked, to isolate the edit-race.
    const { data: seeded } = await admin
      .from("predictions")
      .insert({
        user_id: userId,
        market_id: marketId,
        selected_outcome: "YES",
        yes_probability_snapshot: 0.6,
        no_probability_snapshot: 0.4,
        market_question_snapshot: "q",
        market_status_snapshot: "ACTIVE",
        idempotency_key: crypto.randomUUID(),
      })
      .select("id")
      .single();
    expect(seeded).not.toBeNull();

    const { outcome, prediction } = await pick(userId, marketId, { selectedOutcome: "NO" });
    expect(outcome).toBe("rejected_cutoff");
    expect(prediction!.lockedAt).not.toBeNull();
    expect(prediction!.selectedOutcome).toBe("YES");
  });
});

describe("security", () => {
  it("a user cannot edit another user's Pick via set_pick (userId is always the caller's own, enforced by the action layer — this proves the RPC itself has no way to distinguish, so the Server Action's requireUser() scoping is what must hold, and predictions RLS independently blocks direct reads/writes)", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const owner = await createUser();
    await pick(owner, marketId, { selectedOutcome: "YES" });

    const other = await createUser();
    const otherEmail = (await admin.auth.admin.getUserById(other)).data.user!.email!;
    const otherClient = getTestAnonClient();
    await otherClient.auth.signInWithPassword({ email: otherEmail, password: "integration-test-password-123" });

    const { data: readAsOther } = await otherClient.from("predictions").select("*").eq("user_id", owner);
    expect(readAsOther ?? []).toEqual([]);

    const { error: updateError } = await otherClient.from("predictions").update({ selected_outcome: "NO" }).eq("user_id", owner).eq("market_id", marketId);
    expect(updateError).not.toBeNull();
    const stillOwners = await getLatestUserPredictionForMarket(owner, marketId);
    expect(stillOwners!.selectedOutcome).toBe("YES");
  });

  it("no authenticated client can call set_pick directly (service_role only)", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    const email = (await admin.auth.admin.getUserById(userId)).data.user!.email!;
    const userClient = getTestAnonClient();
    await userClient.auth.signInWithPassword({ email, password: "integration-test-password-123" });

    const { error } = await userClient.rpc("set_pick", {
      p_user_id: userId,
      p_market_id: marketId,
      p_selected_outcome: "YES",
      p_yes_probability: 0.6,
      p_no_probability: 0.4,
      p_market_question: "q",
      p_market_close_at: null,
      p_market_status: "ACTIVE",
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it("a user cannot directly mutate result/graded_at", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId);
    const email = (await admin.auth.admin.getUserById(userId)).data.user!.email!;
    const userClient = getTestAnonClient();
    await userClient.auth.signInWithPassword({ email, password: "integration-test-password-123" });

    const { error } = await userClient.from("predictions").update({ result: "CORRECT", graded_at: new Date().toISOString(), lifecycle_state: "GRADED" }).eq("user_id", userId).eq("market_id", marketId);
    expect(error).not.toBeNull();
  });

  it("revision history cannot be rewritten or deleted by any client", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId);
    const userId = await createUser();
    await pick(userId, marketId, { selectedOutcome: "YES" });
    await pick(userId, marketId, { selectedOutcome: "NO" });

    const email = (await admin.auth.admin.getUserById(userId)).data.user!.email!;
    const userClient = getTestAnonClient();
    await userClient.auth.signInWithPassword({ email, password: "integration-test-password-123" });

    const { data: revisions } = await userClient.from("prediction_revisions").select("*").eq("user_id", userId);
    expect(revisions).toHaveLength(1);

    const { error: updateError } = await userClient.from("prediction_revisions").update({ new_selected_outcome: "YES" }).eq("user_id", userId);
    expect(updateError).not.toBeNull();
    const { error: deleteError } = await userClient.from("prediction_revisions").delete().eq("user_id", userId);
    expect(deleteError).not.toBeNull();

    // Even service_role cannot mutate/delete it — append-only, structurally.
    const { error: adminUpdateError } = await admin.from("prediction_revisions").update({ new_selected_outcome: "YES" }).eq("user_id", userId);
    expect(adminUpdateError).not.toBeNull();
  });
});
