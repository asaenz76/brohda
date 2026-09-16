import { describe, expect, it } from "vitest";
import { evaluateEligibility, type EligibilityCheckInput } from "@/lib/prediction-markets/eligibility";
import type { MarketEligibilityCriteria } from "@/lib/prediction-markets/types";

function input(overrides: Partial<EligibilityCheckInput> = {}): EligibilityCheckInput {
  return {
    providerMarketId: "m1",
    providerEventId: "e1",
    categoryTags: [],
    isActive: true,
    liquidity: 1000,
    ...overrides,
  };
}

describe("evaluateEligibility", () => {
  it("is eligible by default when no criteria are configured beyond maxResults", () => {
    const decision = evaluateEligibility(input(), { maxResults: 10 });
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe("no_filters_configured");
  });

  it("an explicit market-id allowlist takes precedence over every other filter", () => {
    const criteria: MarketEligibilityCriteria = {
      explicitMarketIds: ["m1"],
      activeOnly: true,
      minLiquidity: 999999, // would otherwise reject
      maxResults: 10,
    };
    expect(evaluateEligibility(input({ providerMarketId: "m1" }), criteria).eligible).toBe(true);
    expect(evaluateEligibility(input({ providerMarketId: "other" }), criteria).eligible).toBe(false);
  });

  it("rejects a market not in the explicit event-id allowlist", () => {
    const criteria: MarketEligibilityCriteria = { explicitEventIds: ["e1"], maxResults: 10 };
    expect(evaluateEligibility(input({ providerEventId: "e2" }), criteria).eligible).toBe(false);
    expect(evaluateEligibility(input({ providerEventId: null }), criteria).eligible).toBe(false);
    expect(evaluateEligibility(input({ providerEventId: "e1" }), criteria).eligible).toBe(true);
  });

  it("rejects a market with no matching category tag", () => {
    const criteria: MarketEligibilityCriteria = { categoryTags: ["politics"], maxResults: 10 };
    expect(evaluateEligibility(input({ categoryTags: ["sports"] }), criteria).eligible).toBe(false);
    expect(evaluateEligibility(input({ categoryTags: ["politics", "sports"] }), criteria).eligible).toBe(true);
  });

  it("rejects an inactive market when activeOnly is set", () => {
    const criteria: MarketEligibilityCriteria = { activeOnly: true, maxResults: 10 };
    expect(evaluateEligibility(input({ isActive: false }), criteria).eligible).toBe(false);
    expect(evaluateEligibility(input({ isActive: true }), criteria).eligible).toBe(true);
  });

  it("rejects a market below the configured minimum liquidity, including null liquidity", () => {
    const criteria: MarketEligibilityCriteria = { minLiquidity: 500, maxResults: 10 };
    expect(evaluateEligibility(input({ liquidity: 100 }), criteria).eligible).toBe(false);
    expect(evaluateEligibility(input({ liquidity: null }), criteria).eligible).toBe(false);
    expect(evaluateEligibility(input({ liquidity: 500 }), criteria).eligible).toBe(true);
  });

  it("reports a specific, attributable reason for every eligible decision", () => {
    const criteria: MarketEligibilityCriteria = { activeOnly: true, minLiquidity: 100, maxResults: 10 };
    const decision = evaluateEligibility(input({ liquidity: 1000 }), criteria);
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toContain("active_only");
    expect(decision.reason).toContain("min_liquidity");
  });
});
