import { describe, expect, it } from "vitest";
import { isDetailReachable, isFeedEligible, presentedStatus } from "@/lib/prediction-markets/discovery/eligibility";
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
    priceOutcomeLabels: null,
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

describe("a retired line that carries Picks stays reachable (the provider moved Total 47.5 to 48.5)", () => {
  it("INACTIVE/ARCHIVED with Picks is reachable; without Picks it is still not", () => {
    for (const status of ["INACTIVE", "ARCHIVED"]) {
      expect(isDetailReachable(record({ status }), true), status).toBe(true);
      expect(isDetailReachable(record({ status }), false), status).toBe(false);
      expect(isDetailReachable(record({ status })), status).toBe(false);
    }
  });

  it("a market with no question is never reachable, Picks or not", () => {
    expect(isDetailReachable(record({ status: "INACTIVE", question: " " }), true)).toBe(false);
  });

  it("is presented as CLOSED (never open for new Picks), and ordinary statuses are unchanged", () => {
    expect(presentedStatus(record({ status: "INACTIVE" }))).toBe("CLOSED");
    expect(presentedStatus(record({ status: "ARCHIVED" }))).toBe("CLOSED");
    expect(presentedStatus(record({ status: "ACTIVE" }))).toBe("ACTIVE");
    expect(presentedStatus(record({ status: "CLOSED" }))).toBe("CLOSED");
  });
});
