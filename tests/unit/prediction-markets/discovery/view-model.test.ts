import { describe, expect, it } from "vitest";
import { toDiscoveryMarketCard, toDiscoveryMarketDetail } from "@/lib/prediction-markets/discovery/view-model";
import type { FreshnessPolicy } from "@/lib/prediction-markets/discovery/policy";

const TEST_POLICY: FreshnessPolicy = { freshWithinMinutes: 60, staleWithinMinutes: 24 * 60 };
import type { MarketRecord } from "@/lib/prediction-markets/repository";

function record(overrides: Partial<MarketRecord> = {}): MarketRecord {
  return {
    id: "brohda-id-1",
    provider: "api-sports",
    providerMarketId: "provider-id-should-never-leak",
    providerEventId: "provider-event-should-never-leak",
    question: "Will X happen?",
    description: "Some context",
    status: "ACTIVE",
    fixtureId: "f1",
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    yesPrice: 0.62,
    noPrice: 0.38,
    priceOutcomeLabels: { yes: "X happens", no: "X does not happen" },
    volume24hr: 1000,
    liquidity: 5000,
    resolvedOutcome: null,
    closesAt: "2026-12-31T00:00:00Z",
    lastSyncedAt: new Date().toISOString(),
    ingestionSource: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    categoryTags: ["politics"],
    ...overrides,
  };
}

describe("toDiscoveryMarketCard", () => {
  it("maps a normal active market with prices", () => {
    const card = toDiscoveryMarketCard(record(), [], TEST_POLICY);
    expect(card).toMatchObject({ id: "brohda-id-1", question: "Will X happen?", yesPercent: 62, noPercent: 38, status: "ACTIVE" });
  });

  it("returns null for a market with no consumer status (INACTIVE/ARCHIVED)", () => {
    expect(toDiscoveryMarketCard(record({ status: "ARCHIVED" }), [], TEST_POLICY)).toBeNull();
  });

  it("never exposes provider, providerMarketId, providerEventId, categoryTags, or any raw metadata field", () => {
    const card = toDiscoveryMarketCard(record(), [], TEST_POLICY);
    const keys = Object.keys(card!);
    expect(keys).not.toContain("provider");
    expect(keys).not.toContain("providerMarketId");
    expect(keys).not.toContain("providerEventId");
    expect(keys).not.toContain("categoryTags");
    expect(keys).not.toContain("providerMetadata");
    expect(JSON.stringify(card)).not.toContain("provider-id-should-never-leak");
    expect(JSON.stringify(card)).not.toContain("provider-event-should-never-leak");
  });

  it("carries through configured category refs verbatim, whatever they're named", () => {
    const card = toDiscoveryMarketCard(record(), [{ id: "c1", slug: "custom-topic", displayName: "Anything An Admin Named It" }], TEST_POLICY);
    expect(card!.categories).toEqual([{ id: "c1", slug: "custom-topic", displayName: "Anything An Admin Named It" }]);
  });
});

describe("toDiscoveryMarketDetail", () => {
  it("includes description and resolvedOutcome on top of the card fields", () => {
    const detail = toDiscoveryMarketDetail(record({ status: "CLOSED", resolvedOutcome: "Yes" }), [], TEST_POLICY);
    expect(detail).toMatchObject({ status: "RESOLVED", resolvedOutcome: "Yes", description: "Some context" });
  });

  it("never fabricates a resolvedOutcome that isn't genuinely present", () => {
    const detail = toDiscoveryMarketDetail(record({ status: "CLOSED", resolvedOutcome: null }), [], TEST_POLICY);
    expect(detail!.status).toBe("CLOSED");
    expect(detail!.resolvedOutcome).toBeNull();
  });
});
