import { describe, expect, it, vi } from "vitest";
import { checkMarketEligibility, priceSnapshotFor, type MarketEligibilityInput } from "@/lib/predictions/policy";
import type { PredictionPolicy } from "@/lib/predictions/types";
import { snapshotOrNull } from "@/lib/predictions/repository";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

/** Brohda 2.1 M2: price is enrichment, never a substituted value — what a Pick records, and when a price is (not) required. */
describe("priceSnapshotFor", () => {
  it("both prices, whenever both exist, while the price is required (exactly the pre-M2 behaviour, including an old price)", () => {
    expect(priceSnapshotFor(0.6, 0.4, "FRESH", true)).toEqual({ yes: 0.6, no: 0.4 });
    expect(priceSnapshotFor(0.6, 0.4, "STALE", true)).toEqual({ yes: 0.6, no: 0.4 });
    expect(priceSnapshotFor(0.6, 0.4, "UNAVAILABLE", true)).toEqual({ yes: 0.6, no: 0.4 });
  });
  it("with the price optional, a price too old to be current is recorded as NULL, not as if it were live", () => {
    expect(priceSnapshotFor(0.6, 0.4, "FRESH", false)).toEqual({ yes: 0.6, no: 0.4 });
    expect(priceSnapshotFor(0.6, 0.4, "STALE", false)).toEqual({ yes: 0.6, no: 0.4 });
    expect(priceSnapshotFor(0.6, 0.4, "UNAVAILABLE", false)).toEqual({ yes: null, no: null });
  });
  it("a missing side is a missing snapshot: the pair is never half-filled, and never a substituted number", () => {
    for (const requirePrice of [true, false]) {
      for (const [y, n] of [[null, null], [0.6, null], [null, 0.4]] as const) {
        const s = priceSnapshotFor(y, n, "FRESH", requirePrice);
        expect(s).toEqual({ yes: null, no: null });
        expect([0.5, 0, -110]).not.toContain(s.yes);
      }
    }
  });
});

describe("snapshotOrNull (the Number(null) === 0 trap)", () => {
  it("carries absence through; it never turns NULL into 0", () => {
    expect(snapshotOrNull(null)).toBeNull();
    expect(snapshotOrNull(undefined)).toBeNull();
    expect(snapshotOrNull("0.42")).toBeCloseTo(0.42);
    expect(snapshotOrNull(0)).toBe(0); // a genuine zero price stays a zero
  });
});

describe("checkMarketEligibility: structural vs price eligibility", () => {
  const policy = (over: Partial<PredictionPolicy> = {}): PredictionPolicy => ({
    allowRepeat: false, cutoffMinutesBeforeClose: 0, allowStalePrice: true, allowUnavailablePrice: false, allowClosedMarket: false, requirePrice: true, allowedTemplates: ["MONEYLINE"], ...over,
  });
  const input = (over: Partial<MarketEligibilityInput> = {}): MarketEligibilityInput => ({
    consumerStatus: "ACTIVE", marketTemplate: "MONEYLINE", freshness: "FRESH", yesPrice: 0.6, noPrice: 0.4, closesAt: null, now: new Date("2026-01-01T00:00:00Z"), ...over,
  });

  it("an offered template with a live price is eligible", () => {
    expect(checkMarketEligibility(input(), policy())).toEqual({ eligible: true });
  });
  it("a template that is not offered is refused first, whatever the price says", () => {
    expect(checkMarketEligibility(input({ marketTemplate: "SPREAD" }), policy({ requirePrice: false }))).toEqual({ eligible: false, reason: "TEMPLATE_NOT_ALLOWED" });
    expect(checkMarketEligibility(input({ marketTemplate: "SPREAD" }), policy())).toEqual({ eligible: false, reason: "TEMPLATE_NOT_ALLOWED" });
  });
  it("an empty allow-list (the fail-closed value) offers nothing", () => {
    expect(checkMarketEligibility(input(), policy({ allowedTemplates: [] }))).toEqual({ eligible: false, reason: "TEMPLATE_NOT_ALLOWED" });
  });
  it("price required: no price, an unavailable price and a half price are all refused (pre-M2)", () => {
    expect(checkMarketEligibility(input({ freshness: "UNAVAILABLE", yesPrice: null, noPrice: null }), policy())).toEqual({ eligible: false, reason: "PRICE_UNAVAILABLE" });
    expect(checkMarketEligibility(input({ yesPrice: 0.5, noPrice: null }), policy())).toEqual({ eligible: false, reason: "PRICE_UNAVAILABLE" });
  });
  it("price not required: the same Markets are eligible — availability does not oscillate with sportsbook coverage", () => {
    const relaxed = policy({ requirePrice: false });
    expect(checkMarketEligibility(input({ freshness: "UNAVAILABLE", yesPrice: null, noPrice: null }), relaxed)).toEqual({ eligible: true });
    expect(checkMarketEligibility(input({ freshness: "STALE" }), policy({ requirePrice: false, allowStalePrice: false }))).toEqual({ eligible: true });
    expect(checkMarketEligibility(input({ yesPrice: 0.5, noPrice: null }), relaxed)).toEqual({ eligible: true });
  });
  it("the structural invariants never relax: a resolved or inactive Market is not Pickable whatever the policy", () => {
    const relaxed = policy({ requirePrice: false });
    expect(checkMarketEligibility(input({ consumerStatus: "RESOLVED" }), relaxed)).toEqual({ eligible: false, reason: "MARKET_RESOLVED" });
    expect(checkMarketEligibility(input({ consumerStatus: null }), relaxed)).toEqual({ eligible: false, reason: "MARKET_INACTIVE" });
    expect(checkMarketEligibility(input({ consumerStatus: "CLOSED" }), relaxed)).toEqual({ eligible: false, reason: "MARKET_CLOSED" });
  });
});
