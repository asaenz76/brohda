import { describe, expect, it } from "vitest";
import { isDetailReachable, isFeedEligible } from "@/lib/prediction-markets/discovery/eligibility";
import type { MarketRecord } from "@/lib/prediction-markets/repository";

function record(overrides: Partial<MarketRecord> = {}): MarketRecord {
  return {
    id: "m1",
    provider: "api-sports",
    providerMarketId: "p1",
    providerEventId: null,
    question: "Will X happen?",
    description: null,
    status: "ACTIVE",
    fixtureId: "f1",
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    yesPrice: 0.5,
    noPrice: 0.5,
    volume24hr: null,
    liquidity: null,
    resolvedOutcome: null,
    closesAt: null,
    lastSyncedAt: new Date().toISOString(),
    ingestionSource: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    categoryTags: [],
    ...overrides,
  };
}

describe("isFeedEligible", () => {
  it("is eligible for an ACTIVE market with a question", () => {
    expect(isFeedEligible(record())).toBe(true);
  });

  it("is not eligible for a CLOSED market — the feed shows only currently-open questions", () => {
    expect(isFeedEligible(record({ status: "CLOSED" }))).toBe(false);
  });

  it("is not eligible for a RESOLVED market", () => {
    expect(isFeedEligible(record({ status: "CLOSED", resolvedOutcome: "Yes" }))).toBe(false);
  });

  it("is not eligible for INACTIVE/ARCHIVED", () => {
    expect(isFeedEligible(record({ status: "INACTIVE" }))).toBe(false);
    expect(isFeedEligible(record({ status: "ARCHIVED" }))).toBe(false);
  });

  it("is not eligible with a blank question", () => {
    expect(isFeedEligible(record({ question: "   " }))).toBe(false);
  });

  it("is still eligible with no usable price — the card renders an honest unavailable state instead of being hidden", () => {
    expect(isFeedEligible(record({ yesPrice: null, noPrice: null }))).toBe(true);
  });
});

describe("isDetailReachable", () => {
  it("is reachable for ACTIVE, CLOSED, and RESOLVED", () => {
    expect(isDetailReachable(record({ status: "ACTIVE" }))).toBe(true);
    expect(isDetailReachable(record({ status: "CLOSED" }))).toBe(true);
    expect(isDetailReachable(record({ status: "CLOSED", resolvedOutcome: "Yes" }))).toBe(true);
  });

  it("is not reachable for INACTIVE/ARCHIVED — same as a nonexistent market", () => {
    expect(isDetailReachable(record({ status: "INACTIVE" }))).toBe(false);
    expect(isDetailReachable(record({ status: "ARCHIVED" }))).toBe(false);
  });
});
