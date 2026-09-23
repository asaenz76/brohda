import { describe, expect, it } from "vitest";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import type { MarketRecord } from "@/lib/prediction-markets/repository";

function market(overrides: Partial<MarketRecord> = {}): MarketRecord {
  return {
    id: "m1",
    provider: "api_nfl",
    providerMarketId: "p1",
    providerEventId: null,
    question: "q",
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
    lastSyncedAt: "2026-01-01T00:00:00Z",
    ingestionSource: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    categoryTags: [],
    ...overrides,
  };
}

describe("selectPrimaryMarket", () => {
  it("returns null when no Markets are active", () => {
    expect(selectPrimaryMarket([], ["MONEYLINE", "TOTAL", "SPREAD"])).toBeNull();
  });

  it("picks the first template in priority order that has a match", () => {
    const moneyline = market({ id: "ml", marketTemplate: "MONEYLINE" });
    const total = market({ id: "tot", marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    expect(selectPrimaryMarket([total, moneyline], ["MONEYLINE", "TOTAL"])?.id).toBe("ml");
    expect(selectPrimaryMarket([total, moneyline], ["TOTAL", "MONEYLINE"])?.id).toBe("tot");
  });

  it("falls through to the next priority entry when the first is unavailable", () => {
    const total = market({ id: "tot", marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    expect(selectPrimaryMarket([total], ["MONEYLINE", "TOTAL", "SPREAD"])?.id).toBe("tot");
  });

  it("returns null when the only active Market's template is not in the priority list at all", () => {
    const total = market({ id: "tot", marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    expect(selectPrimaryMarket([total], ["MONEYLINE"])).toBeNull();
  });

  it("changing the priority order changes the result without touching any Market row", () => {
    const moneyline = market({ id: "ml", marketTemplate: "MONEYLINE" });
    const total = market({ id: "tot", marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    const markets = [moneyline, total];
    const first = selectPrimaryMarket(markets, ["MONEYLINE", "TOTAL"]);
    const second = selectPrimaryMarket(markets, ["TOTAL", "MONEYLINE"]);
    expect(first?.id).not.toBe(second?.id);
  });
});
