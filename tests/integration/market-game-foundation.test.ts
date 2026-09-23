/**
 * Integration tests for Milestone R1 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Game <-> Market Foundation) — the structural relationship between
 * `fixtures` (Game) and `markets` (Market) itself: FK enforcement,
 * proposition uniqueness, identity immutability, per-template shape
 * constraints, and end-to-end grading against a real fixture. Real local
 * Supabase only (pnpm supabase:start).
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { getFixtureForGrading } from "@/lib/sports-data/fixture-lookup";
import { decideGradingForMarket } from "@/lib/predictions/grading";

const admin = getTestAdminClient();
const testProvider = `market_game_foundation_test_${Date.now()}`;

async function createTestFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `market-game-foundation-${crypto.randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
      ...overrides,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  return data.id;
}

function marketPayload(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: testProvider,
    providerMarketId: `m_${Math.random().toString(36).slice(2)}`,
    providerEventId: null,
    question: "Will the home side win?",
    description: null,
    status: "ACTIVE",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.5, no: 0.5, outcomeLabels: { yes: "Yes", no: "No" } },
    volume24hr: null,
    liquidity: null,
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

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];

afterEach(async () => {
  if (createdMarketIds.length > 0) await admin.from("markets").delete().in("id", createdMarketIds);
  createdMarketIds.length = 0;
  if (createdFixtureIds.length > 0) await admin.from("fixtures").delete().in("id", createdFixtureIds);
  createdFixtureIds.length = 0;
});

async function seedFixture(overrides: Record<string, unknown> = {}) {
  const id = await createTestFixture(overrides);
  createdFixtureIds.push(id);
  return id;
}

describe("Market -> Game referential integrity", () => {
  it("rejects a Market pointing at a nonexistent fixture", async () => {
    const fakeFixtureId = "00000000-0000-0000-0000-000000000000";
    const { error } = await admin.from("markets").insert({
      provider: testProvider,
      provider_market_id: `orphan-${Date.now()}`,
      question: "Orphan market",
      status: "ACTIVE",
      fixture_id: fakeFixtureId,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      last_synced_at: new Date().toISOString(),
      ingestion_source: "test",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a Market with no fixture_id at all — every canonical Market belongs to a Game", async () => {
    const { error } = await admin.from("markets").insert({
      provider: testProvider,
      provider_market_id: `no-fixture-${Date.now()}`,
      question: "No fixture",
      status: "ACTIVE",
      market_template: "MONEYLINE",
      yes_side: "HOME",
      last_synced_at: new Date().toISOString(),
      ingestion_source: "test",
    });
    expect(error).not.toBeNull();
  });

  it("does not cascade-delete a fixture that still has a Market referencing it — permanent history is never silently erased", async () => {
    const fixtureId = await seedFixture();
    const { id } = await upsertMarket(marketPayload(fixtureId));
    createdMarketIds.push(id);

    const { error } = await admin.from("fixtures").delete().eq("id", fixtureId);
    expect(error).not.toBeNull();
  });
});

describe("Market proposition shape (per template)", () => {
  it("rejects a MONEYLINE market that carries a line_value", async () => {
    const fixtureId = await seedFixture();
    const { error } = await admin.from("markets").insert({
      provider: testProvider,
      provider_market_id: `bad-moneyline-${Date.now()}`,
      question: "bad moneyline",
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "MONEYLINE",
      line_value: 6.5,
      yes_side: "HOME",
      last_synced_at: new Date().toISOString(),
      ingestion_source: "test",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a SPREAD market missing a line_value", async () => {
    const fixtureId = await seedFixture();
    const { error } = await admin.from("markets").insert({
      provider: testProvider,
      provider_market_id: `bad-spread-${Date.now()}`,
      question: "bad spread",
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "SPREAD",
      yes_side: "HOME",
      last_synced_at: new Date().toISOString(),
      ingestion_source: "test",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a TOTAL market that carries a yes_side — OVER/UNDER is implicit, not per-row data", async () => {
    const fixtureId = await seedFixture();
    const { error } = await admin.from("markets").insert({
      provider: testProvider,
      provider_market_id: `bad-total-${Date.now()}`,
      question: "bad total",
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "TOTAL",
      line_value: 47.5,
      yes_side: "HOME",
      last_synced_at: new Date().toISOString(),
      ingestion_source: "test",
    });
    expect(error).not.toBeNull();
  });

  it("accepts a well-formed SPREAD and TOTAL market", async () => {
    const fixtureId = await seedFixture();
    const spread = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "SPREAD", lineValue: 6.5, yesSide: "AWAY" }));
    createdMarketIds.push(spread.id);
    const total = await upsertMarket(marketPayload(await seedFixture(), { marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null }));
    createdMarketIds.push(total.id);
    expect(spread.outcome).toBe("inserted");
    expect(total.outcome).toBe("inserted");
  });
});

describe("Market proposition uniqueness", () => {
  it("rejects a second Market with the identical (fixture, template, line, side) proposition", async () => {
    const fixtureId = await seedFixture();
    const first = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "SPREAD", lineValue: 6.5, yesSide: "HOME" }));
    createdMarketIds.push(first.id);

    const { error } = await admin.from("markets").insert({
      provider: testProvider,
      provider_market_id: `dup-proposition-${Date.now()}`,
      question: "duplicate proposition",
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "SPREAD",
      line_value: 6.5,
      yes_side: "HOME",
      last_synced_at: new Date().toISOString(),
      ingestion_source: "test",
    });
    expect(error).not.toBeNull();
  });

  it("allows two different lines on the same fixture — a moved line is a different proposition, not a collision", async () => {
    const fixtureId = await seedFixture();
    const original = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "SPREAD", lineValue: 6.5, yesSide: "HOME" }));
    createdMarketIds.push(original.id);
    const moved = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "SPREAD", lineValue: 5.5, yesSide: "HOME" }));
    createdMarketIds.push(moved.id);
    expect(moved.id).not.toBe(original.id);
  });

  it("allows two MONEYLINE rows for the same fixture on opposite sides (HOME vs AWAY) — genuinely distinct propositions", async () => {
    const fixtureId = await seedFixture();
    const home = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "HOME" }));
    createdMarketIds.push(home.id);
    const away = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "AWAY" }));
    createdMarketIds.push(away.id);
    expect(away.id).not.toBe(home.id);
  });
});

describe("Market identity immutability", () => {
  it("rejects an UPDATE that changes fixture_id on an existing Market", async () => {
    const fixtureId = await seedFixture();
    const otherFixtureId = await seedFixture();
    const { id } = await upsertMarket(marketPayload(fixtureId));
    createdMarketIds.push(id);

    const { error } = await admin.from("markets").update({ fixture_id: otherFixtureId }).eq("id", id);
    expect(error).not.toBeNull();
  });

  it("rejects an UPDATE that changes line_value — a moved line must be a new row, never a mutation", async () => {
    const fixtureId = await seedFixture();
    const { id } = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "SPREAD", lineValue: 6.5, yesSide: "HOME" }));
    createdMarketIds.push(id);

    const { error } = await admin.from("markets").update({ line_value: 5.5 }).eq("id", id);
    expect(error).not.toBeNull();
  });

  it("rejects an UPDATE that changes market_template", async () => {
    const fixtureId = await seedFixture();
    const { id } = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "HOME" }));
    createdMarketIds.push(id);

    const { error } = await admin.from("markets").update({ market_template: "TOTAL", line_value: 40, yes_side: null }).eq("id", id);
    expect(error).not.toBeNull();
  });

  it("still allows an UPDATE that changes only mutable fields (status/price) — upsertMarket's update-in-place path is unaffected", async () => {
    const fixtureId = await seedFixture();
    const seeded = await upsertMarket(marketPayload(fixtureId, { status: "ACTIVE" }));
    createdMarketIds.push(seeded.id);

    const reupserted = await upsertMarket(marketPayload(fixtureId, { providerMarketId: (await admin.from("markets").select("provider_market_id").eq("id", seeded.id).single()).data!.provider_market_id, status: "CLOSED" }));
    expect(reupserted.outcome).toBe("updated");
    expect(reupserted.id).toBe(seeded.id);
  });
});

describe("end-to-end objective grading from a real fixture", () => {
  it("a SPREAD market grades YES once its Game completes with a cover, via getFixtureForGrading + decideGradingForMarket", async () => {
    const fixtureId = await seedFixture();
    const { id } = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "SPREAD", lineValue: 6.5, yesSide: "HOME", status: "CLOSED" }));
    createdMarketIds.push(id);

    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 17, away_score: 20 }).eq("id", fixtureId);

    const market = { ...marketPayload(fixtureId, { marketTemplate: "SPREAD", lineValue: 6.5, yesSide: "HOME" }), id, createdAt: "", updatedAt: "", categoryTags: [], lastSyncedAt: "", yesPrice: null, noPrice: null, status: "CLOSED" as const };
    const fixture = await getFixtureForGrading(fixtureId);
    expect(fixture).not.toBeNull();
    const decision = decideGradingForMarket(market, fixture, "YES");
    expect(decision).toEqual({ decision: "graded", result: "CORRECT", resolvedOutcomeSnapshot: "YES" });
  });

  it("a TOTAL market grades VOID (push) once its Game completes exactly on the line", async () => {
    const fixtureId = await seedFixture();
    const { id } = await upsertMarket(marketPayload(fixtureId, { marketTemplate: "TOTAL", lineValue: 47, yesSide: null, status: "CLOSED" }));
    createdMarketIds.push(id);

    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 24, away_score: 23 }).eq("id", fixtureId);

    const market = { ...marketPayload(fixtureId, { marketTemplate: "TOTAL", lineValue: 47, yesSide: null }), id, createdAt: "", updatedAt: "", categoryTags: [], lastSyncedAt: "", yesPrice: null, noPrice: null, status: "CLOSED" as const };
    const fixture = await getFixtureForGrading(fixtureId);
    const decision = decideGradingForMarket(market, fixture, "YES");
    expect(decision).toEqual({ decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null });
  });

  it("stays PENDING while the Game is still NOT_STARTED — never fabricates a result", async () => {
    const fixtureId = await seedFixture();
    const { id } = await upsertMarket(marketPayload(fixtureId, { status: "ACTIVE" }));
    createdMarketIds.push(id);

    const market = { ...marketPayload(fixtureId), id, createdAt: "", updatedAt: "", categoryTags: [], lastSyncedAt: "", yesPrice: null, noPrice: null };
    const fixture = await getFixtureForGrading(fixtureId);
    const decision = decideGradingForMarket(market, fixture, "YES");
    expect(decision).toEqual({ decision: "still-pending" });
  });
});
