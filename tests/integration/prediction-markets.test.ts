/**
 * Integration tests for the `markets` persistence layer (Milestone R0,
 * docs/architecture/sports-prediction-network.md) — repurposed from the
 * abandoned Polymarket-market catalog into the candidate schema for a
 * sports PredictionQuestion. Real local Supabase only (pnpm supabase:start);
 * every fixture here is constructed in-process, exercising persistence,
 * upsert, and RLS without any network call.
 */
import { afterAll, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { getMarketByProviderMarketId, upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

// Calling this triggers test-env.ts's one-way projection of TEST_SUPABASE_*
// onto NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, which is what
// lets lib/prediction-markets/repository.ts's createAdminClient() calls
// land on the local test instance instead of crashing with no config.
const admin = getTestAdminClient();

const createdIds: string[] = [];
const createdFixtureIds: string[] = [];
const testProvider = `test_provider_${Date.now()}`;

// Milestone R1: every Market now belongs to a canonical Game (fixture_id is
// a real, NOT NULL FK — supabase/migrations/20260101000148_*.sql). One
// shared test fixture is enough here since these tests never exercise
// grading (that's covered in tests/integration/predictions.test.ts and
// tests/integration/market-game-foundation.test.ts) — only persistence,
// upsert, and RLS — but each test still needs a *distinct* proposition
// (fixture_id, market_template, line_value, yes_side) to avoid colliding
// with the new proposition-uniqueness constraint, so each fixture() call
// gets its own dedicated fixture row.
async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `prediction-markets-test-${crypto.randomUUID()}`,
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

async function fixture(providerMarketId: string, overrides: Partial<NormalizedMarket> = {}): Promise<NormalizedMarket> {
  const fixtureId = overrides.fixtureId ?? (await createTestFixture());
  return {
    provider: testProvider,
    providerMarketId,
    providerEventId: null,
    question: `Integration test market ${providerMarketId}`,
    description: null,
    status: "ACTIVE",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.5, no: 0.5, outcomeLabels: { yes: "Yes", no: "No" } },
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

describe("prediction-markets Market domain", () => {
  afterAll(async () => {
    if (createdIds.length > 0) {
      await admin.from("markets").delete().in("id", createdIds);
    }
    // Markets first (FK child), fixtures last (FK parent).
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
  });

  // RLS-enabled-ness is proven behaviorally by the two tests below (an anon
  // client can neither write nor read), rather than via SQL introspection —
  // this repo has no general-purpose "run arbitrary SQL" RPC, and adding
  // one just to assert `relrowsecurity` would be a needless new privileged
  // surface for a fact these two tests already establish directly.

  it("rejects a direct write from an unauthorized (anon) client", async () => {
    const anon = getTestAnonClient();
    const fixtureId = await createTestFixture();
    const { error } = await anon.from("markets").insert({
      provider: testProvider,
      provider_market_id: `anon-write-${Date.now()}`,
      question: "Should never be writable by anon",
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      last_synced_at: new Date().toISOString(),
      ingestion_source: "test",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a direct read from an unauthorized (anon) client — no consumer surface exists yet", async () => {
    const anon = getTestAnonClient();
    const { data, error } = await anon.from("markets").select("*").limit(1);
    // RLS with no policy for `authenticated`/`anon` means either an empty
    // result set or an explicit error, depending on PostgREST's handling of
    // a table with zero applicable policies — either outcome proves no data
    // is exposed, which is the actual requirement.
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data).toEqual([]);
    }
  });

  it("allows a service-role write, and the market can be read back", async () => {
    const market = await fixture(`svc-${Date.now()}`);
    const { id, outcome } = await upsertMarket(market);
    createdIds.push(id);

    expect(outcome).toBe("inserted");

    const record = await getMarketByProviderMarketId(testProvider, market.providerMarketId);
    expect(record).not.toBeNull();
    expect(record?.question).toBe(market.question);
    expect(record?.yesPrice).toBe(0.5);
  });

  it("enforces the unique (provider, provider_market_id) constraint via upsert semantics — first ingestion inserts, second updates rather than duplicating", async () => {
    const providerMarketId = `dup-${Date.now()}`;
    const originalMarket = await fixture(providerMarketId, { question: "Original question" });
    const first = await upsertMarket(originalMarket);
    createdIds.push(first.id);
    expect(first.outcome).toBe("inserted");

    // Same fixture_id as the original — identity columns are immutable
    // (Milestone R1), so an update-in-place must never try to change it;
    // only mutable fields (question, price, status) differ here.
    const second = await upsertMarket(await fixture(providerMarketId, { fixtureId: originalMarket.fixtureId, question: "Updated question" }));
    expect(second.outcome).toBe("updated");
    // Stable Brohda UUID across the update — this is the whole point of
    // upserting on (provider, provider_market_id) rather than always
    // inserting.
    expect(second.id).toBe(first.id);

    const { data: rows, error } = await admin
      .from("markets")
      .select("id")
      .eq("provider", testProvider)
      .eq("provider_market_id", providerMarketId);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);

    const record = await getMarketByProviderMarketId(testProvider, providerMarketId);
    expect(record?.question).toBe("Updated question");
  });

  it("keeps previously-valid data intact when a later ingestion attempt for a DIFFERENT market fails — no wipe/reset ever happens", async () => {
    const goodMarketId = `survives-${Date.now()}`;
    const good = await upsertMarket(await fixture(goodMarketId));
    createdIds.push(good.id);

    // Simulate the "one malformed market shouldn't affect others" guarantee
    // at the persistence layer: an upsert failure for an unrelated market
    // (e.g. a constraint violation) must never touch this row. Also missing
    // the Milestone R1 NOT NULL fixture_id/market_template columns, which
    // would independently fail the same way — either failure proves the
    // point, but including them keeps this test's stated intent (a broken
    // `question`) the one actually exercised.
    const brokenFixtureId = await createTestFixture();
    await expect(
      admin.from("markets").insert({
        // Missing required `question` NOT NULL column — a deliberate DB-level failure.
        provider: testProvider,
        provider_market_id: `broken-${Date.now()}`,
        status: "ACTIVE",
        fixture_id: brokenFixtureId,
        market_template: "MONEYLINE",
        yes_side: "HOME",
        last_synced_at: new Date().toISOString(),
        ingestion_source: "test",
      }),
    ).resolves.toMatchObject({ error: expect.anything() });

    const record = await getMarketByProviderMarketId(testProvider, goodMarketId);
    expect(record).not.toBeNull();
    expect(record?.question).toBe(`Integration test market ${goodMarketId}`);
  });
});
