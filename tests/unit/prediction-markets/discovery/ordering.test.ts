import { describe, expect, it } from "vitest";
import { compareDiscoveryMarkets, DEFAULT_SORT_POLICY, type OrderableMarket, type SortPolicy } from "@/lib/prediction-markets/discovery/ordering";

function market(overrides: Partial<OrderableMarket>): OrderableMarket {
  return {
    id: "m",
    question: "Q",
    categories: [],
    yesPercent: 50,
    noPercent: 50,
    status: "ACTIVE",
    closesAt: null,
    freshness: "FRESH",
    liquidity: null,
    ...overrides,
  };
}

describe("compareDiscoveryMarkets — default policy (reproduces original Milestone 2 behavior)", () => {
  it("ranks FRESH before STALE before UNAVAILABLE, regardless of other signals", () => {
    const fresh = market({ id: "fresh", freshness: "FRESH", liquidity: 1 });
    const stale = market({ id: "stale", freshness: "STALE", liquidity: 1000 });
    const list = [stale, fresh].sort((a, b) => compareDiscoveryMarkets(a, b, DEFAULT_SORT_POLICY));
    expect(list.map((m) => m.id)).toEqual(["fresh", "stale"]);
  });

  it("within the same freshness tier, sorts soonest-closing first", () => {
    const soon = market({ id: "soon", closesAt: "2026-01-01T00:00:00Z" });
    const later = market({ id: "later", closesAt: "2026-06-01T00:00:00Z" });
    const list = [later, soon].sort((a, b) => compareDiscoveryMarkets(a, b, DEFAULT_SORT_POLICY));
    expect(list.map((m) => m.id)).toEqual(["soon", "later"]);
  });

  it("sorts markets with no close time after ones with a close time, within the same freshness tier", () => {
    const withClose = market({ id: "withClose", closesAt: "2026-01-01T00:00:00Z" });
    const noClose = market({ id: "noClose", closesAt: null });
    const list = [noClose, withClose].sort((a, b) => compareDiscoveryMarkets(a, b, DEFAULT_SORT_POLICY));
    expect(list.map((m) => m.id)).toEqual(["withClose", "noClose"]);
  });

  it("uses liquidity only as a final tiebreaker, never overriding freshness or close time", () => {
    const highLiquidity = market({ id: "high", closesAt: "2026-01-01T00:00:00Z", liquidity: 1_000_000 });
    const lowLiquidity = market({ id: "low", closesAt: "2026-01-01T00:00:00Z", liquidity: 10 });
    const list = [lowLiquidity, highLiquidity].sort((a, b) => compareDiscoveryMarkets(a, b, DEFAULT_SORT_POLICY));
    expect(list.map((m) => m.id)).toEqual(["high", "low"]);
  });
});

describe("compareDiscoveryMarkets — configurable policy (hard-coding remediation Finding 1)", () => {
  it("changes ranking when the configured priority order changes, with no source change", () => {
    const soonButStale = market({ id: "soonButStale", freshness: "STALE", closesAt: "2026-01-01T00:00:00Z" });
    const laterButFresh = market({ id: "laterButFresh", freshness: "FRESH", closesAt: "2026-06-01T00:00:00Z" });

    const freshnessFirst: SortPolicy = [
      { criterion: "FRESHNESS", direction: "ASC" },
      { criterion: "CLOSE_TIME", direction: "ASC" },
    ];
    const closeTimeFirst: SortPolicy = [
      { criterion: "CLOSE_TIME", direction: "ASC" },
      { criterion: "FRESHNESS", direction: "ASC" },
    ];

    const byFreshness = [soonButStale, laterButFresh].sort((a, b) => compareDiscoveryMarkets(a, b, freshnessFirst));
    expect(byFreshness.map((m) => m.id)).toEqual(["laterButFresh", "soonButStale"]);

    const byCloseTime = [soonButStale, laterButFresh].sort((a, b) => compareDiscoveryMarkets(a, b, closeTimeFirst));
    expect(byCloseTime.map((m) => m.id)).toEqual(["soonButStale", "laterButFresh"]);
  });

  it("changes ranking when a criterion is disabled (simply absent from the policy), with no source change", () => {
    const highLiquidityStale = market({ id: "highLiqStale", freshness: "STALE", liquidity: 1_000_000 });
    const lowLiquidityFresh = market({ id: "lowLiqFresh", freshness: "FRESH", liquidity: 1 });

    const freshnessEnabled: SortPolicy = [{ criterion: "FRESHNESS", direction: "ASC" }];
    const freshnessDisabledLiquidityOnly: SortPolicy = [{ criterion: "LIQUIDITY", direction: "DESC" }];

    const withFreshness = [highLiquidityStale, lowLiquidityFresh].sort((a, b) => compareDiscoveryMarkets(a, b, freshnessEnabled));
    expect(withFreshness.map((m) => m.id)).toEqual(["lowLiqFresh", "highLiqStale"]);

    const withoutFreshness = [highLiquidityStale, lowLiquidityFresh].sort((a, b) => compareDiscoveryMarkets(a, b, freshnessDisabledLiquidityOnly));
    expect(withoutFreshness.map((m) => m.id)).toEqual(["highLiqStale", "lowLiqFresh"]);
  });

  it("honors ASC vs DESC direction per criterion", () => {
    const a = market({ id: "a", liquidity: 10 });
    const b = market({ id: "b", liquidity: 100 });

    const ascending: SortPolicy = [{ criterion: "LIQUIDITY", direction: "ASC" }];
    const descending: SortPolicy = [{ criterion: "LIQUIDITY", direction: "DESC" }];

    expect([b, a].sort((x, y) => compareDiscoveryMarkets(x, y, ascending)).map((m) => m.id)).toEqual(["a", "b"]);
    expect([a, b].sort((x, y) => compareDiscoveryMarkets(x, y, descending)).map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("an empty policy leaves relative order unspecified but never throws", () => {
    const a = market({ id: "a" });
    const b = market({ id: "b" });
    expect(() => compareDiscoveryMarkets(a, b, [])).not.toThrow();
  });

  it("a market missing the active criterion's value always sorts after one that has it, regardless of direction", () => {
    const withLiquidity = market({ id: "withLiquidity", liquidity: 5 });
    const withoutLiquidity = market({ id: "withoutLiquidity", liquidity: null });

    const asc: SortPolicy = [{ criterion: "LIQUIDITY", direction: "ASC" }];
    const desc: SortPolicy = [{ criterion: "LIQUIDITY", direction: "DESC" }];

    expect([withoutLiquidity, withLiquidity].sort((a, b) => compareDiscoveryMarkets(a, b, asc)).map((m) => m.id)).toEqual(["withLiquidity", "withoutLiquidity"]);
    expect([withoutLiquidity, withLiquidity].sort((a, b) => compareDiscoveryMarkets(a, b, desc)).map((m) => m.id)).toEqual(["withLiquidity", "withoutLiquidity"]);
  });
});
