/**
 * Integration tests for Phase G (Brohda 2.0 redesign)'s
 * lib/reputation/repository.ts's getUserPredictionRecords — the batched,
 * many-commenters reputation read Post conversation uses. (The
 * notification-center type filtering in lib/notifications/fetch.ts is
 * covered at the E2E level instead — that module's getNotifications/
 * getUnreadCount use the request-scoped Supabase client, which cannot be
 * constructed outside real Next.js request scope, so a faithful test of
 * the actual functions needs a real running app, not a replica query.)
 * Real local Supabase throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { getUserPredictionRecords } from "@/lib/reputation/repository";

const admin = getTestAdminClient();
const PROVIDER = "g_center_test";

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];
const createdPredictionIds: string[] = [];

async function createFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({ provider: PROVIDER, external_fixture_id: `g-fixture-${randomUUID()}`, home_team_name: "Home", away_team_name: "Away", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  createdFixtureIds.push(data.id);
  return data.id;
}

async function createMarket(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket({
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
  });
  createdMarketIds.push(id);
  return id;
}

async function createUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `g-center-${randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "G Center Test", role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function pickAndGrade(userId: string, marketId: string, result: "CORRECT" | "INCORRECT" | "VOID") {
  const resolvedOutcomeSnapshot = result === "VOID" ? null : result === "CORRECT" ? "YES" : "NO";
  const { data, error } = await admin
    .from("predictions")
    .insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "q",
      market_close_at_snapshot: null,
      market_status_snapshot: "ACTIVE",
      lifecycle_state: "GRADED",
      result,
      resolved_outcome_snapshot: resolvedOutcomeSnapshot,
      graded_at: new Date().toISOString(),
      idempotency_key: randomUUID(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create graded prediction");
  createdPredictionIds.push(data.id);
  return data.id as string;
}

afterEach(async () => {
  if (createdPredictionIds.length > 0) {
    await admin.from("predictions").delete().in("id", createdPredictionIds);
    createdPredictionIds.length = 0;
  }
  if (createdMarketIds.length > 0) {
    await admin.from("markets").delete().in("id", createdMarketIds);
    createdMarketIds.length = 0;
  }
  if (createdFixtureIds.length > 0) {
    await admin.from("fixtures").delete().in("id", createdFixtureIds);
    createdFixtureIds.length = 0;
  }
  for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
  createdUserIds.length = 0;
});

describe("getUserPredictionRecords (batched)", () => {
  it("computes the same correct/incorrect/void/decided/accuracy math as the single-user RPC, for multiple users in one call", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const fixtureA1 = await createFixture();
    const fixtureA2 = await createFixture();
    const fixtureB1 = await createFixture();

    await pickAndGrade(userA, await createMarket(fixtureA1), "CORRECT");
    await pickAndGrade(userA, await createMarket(fixtureA2), "INCORRECT");
    await pickAndGrade(userB, await createMarket(fixtureB1), "VOID");

    const records = await getUserPredictionRecords([userA, userB]);

    expect(records.get(userA)).toMatchObject({ correct: 1, incorrect: 1, void: 0, decided: 2, accuracy: 0.5 });
    expect(records.get(userB)).toMatchObject({ correct: 0, incorrect: 0, void: 1, decided: 0, accuracy: null });
  });

  it("gives a user with zero GRADED predictions a full zero-everything record, not an absent Map entry", async () => {
    const user = await createUser();
    const records = await getUserPredictionRecords([user]);
    expect(records.get(user)).toMatchObject({ correct: 0, incorrect: 0, void: 0, decided: 0, accuracy: null });
  });

  it("never counts a PENDING (ungraded) prediction", async () => {
    const user = await createUser();
    const fixture = await createFixture();
    const marketId = await createMarket(fixture);
    const { data } = await admin
      .from("predictions")
      .insert({ user_id: user, market_id: marketId, selected_outcome: "YES", yes_probability_snapshot: 0.6, no_probability_snapshot: 0.4, market_question_snapshot: "q", market_close_at_snapshot: null, market_status_snapshot: "ACTIVE", idempotency_key: randomUUID() })
      .select("id")
      .single();
    createdPredictionIds.push(data!.id);

    const records = await getUserPredictionRecords([user]);
    expect(records.get(user)).toMatchObject({ decided: 0, accuracy: null });
  });

  it("returns an empty Map for an empty input, not an error", async () => {
    await expect(getUserPredictionRecords([])).resolves.toEqual(new Map());
  });
});
