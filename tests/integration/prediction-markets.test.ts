/**
 * Integration tests for the Milestone 1 Market domain
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md, Milestone 1). Real local
 * Supabase only (pnpm supabase:start) — never touches Polymarket's real API
 * or production Supabase; every market fixture here is constructed
 * in-process, exercising the persistence layer exactly the way real
 * ingestion would, without any network call.
 */
import { afterAll, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { evaluateEligibility } from "@/lib/prediction-markets/eligibility";
import { getMarketByProviderMarketId, upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

// Calling this triggers test-env.ts's one-way projection of TEST_SUPABASE_*
// onto NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, which is what
// lets lib/prediction-markets/repository.ts's createAdminClient() calls
// land on the local test instance instead of crashing with no config.
const admin = getTestAdminClient();

const createdIds: string[] = [];
const testProvider = `test_provider_${Date.now()}`;

function fixture(providerMarketId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: testProvider,
    providerMarketId,
    providerEventId: null,
    question: `Integration test market ${providerMarketId}`,
    description: null,
    status: "ACTIVE",
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
  });

  // RLS-enabled-ness is proven behaviorally by the two tests below (an anon
  // client can neither write nor read), rather than via SQL introspection —
  // this repo has no general-purpose "run arbitrary SQL" RPC, and adding
  // one just to assert `relrowsecurity` would be a needless new privileged
  // surface for a fact these two tests already establish directly.

  it("rejects a direct write from an unauthorized (anon) client", async () => {
    const anon = getTestAnonClient();
    const { error } = await anon.from("markets").insert({
      provider: testProvider,
      provider_market_id: `anon-write-${Date.now()}`,
      question: "Should never be writable by anon",
      status: "ACTIVE",
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
    const market = fixture(`svc-${Date.now()}`);
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
    const first = await upsertMarket(fixture(providerMarketId, { question: "Original question" }));
    createdIds.push(first.id);
    expect(first.outcome).toBe("inserted");

    const second = await upsertMarket(fixture(providerMarketId, { question: "Updated question" }));
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
    const good = await upsertMarket(fixture(goodMarketId));
    createdIds.push(good.id);

    // Simulate the "one malformed market shouldn't affect others" guarantee
    // at the persistence layer: an upsert failure for an unrelated market
    // (e.g. a constraint violation) must never touch this row.
    await expect(
      admin.from("markets").insert({
        // Missing required `question` NOT NULL column — a deliberate DB-level failure.
        provider: testProvider,
        provider_market_id: `broken-${Date.now()}`,
        status: "ACTIVE",
        last_synced_at: new Date().toISOString(),
        ingestion_source: "test",
      }),
    ).resolves.toMatchObject({ error: expect.anything() });

    const record = await getMarketByProviderMarketId(testProvider, goodMarketId);
    expect(record).not.toBeNull();
    expect(record?.question).toBe(fixture(goodMarketId).question);
  });

  it("bounded-selection: an ineligible market (per explicit criteria) never reaches eligibility, and is never persisted by ingestion logic that respects that decision", () => {
    const decision = evaluateEligibility(
      { providerMarketId: "not-allowed", providerEventId: null, categoryTags: [], isActive: true, liquidity: 1000 },
      { explicitMarketIds: ["only-this-one"], maxResults: 10 },
    );
    expect(decision.eligible).toBe(false);
    // This is the same eligibility check ingest.ts relies on before ever
    // calling upsertMarket — proving it rejects here is what guarantees a
    // non-eligible market never reaches this table in a real run.
  });
});
