import { describe, expect, it } from "vitest";
import { checkMarketEligibility, shouldNotifyForResult, type MarketEligibilityInput } from "@/lib/predictions/policy";
import type { PredictionNotificationPolicy, PredictionPolicy, PredictionResult } from "@/lib/predictions/types";

/**
 * The pure Prediction market-eligibility decision, in isolation from any
 * database (Milestone 3). Everything here is about one property: a
 * RESOLVED market is never predictable regardless of policy (true
 * invariant); every other rule is genuinely configurable.
 */

const PERMISSIVE_POLICY: PredictionPolicy = {
  allowRepeat: false,
  cutoffMinutesBeforeClose: 0,
  allowStalePrice: true,
  allowUnavailablePrice: true,
  allowClosedMarket: true,
};

const DEFAULT_POLICY: PredictionPolicy = {
  allowRepeat: false,
  cutoffMinutesBeforeClose: 0,
  allowStalePrice: true,
  allowUnavailablePrice: false,
  allowClosedMarket: false,
};

function baseInput(overrides: Partial<MarketEligibilityInput> = {}): MarketEligibilityInput {
  return {
    consumerStatus: "ACTIVE",
    freshness: "FRESH",
    yesPrice: 0.62,
    noPrice: 0.38,
    closesAt: null,
    now: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("checkMarketEligibility", () => {
  it("permits an ACTIVE, FRESH market with real prices", () => {
    expect(checkMarketEligibility(baseInput(), DEFAULT_POLICY)).toEqual({ eligible: true });
  });

  it("never permits a RESOLVED market, regardless of policy — true invariant", () => {
    const input = baseInput({ consumerStatus: "RESOLVED" });
    expect(checkMarketEligibility(input, DEFAULT_POLICY)).toEqual({ eligible: false, reason: "MARKET_RESOLVED" });
    expect(checkMarketEligibility(input, PERMISSIVE_POLICY)).toEqual({ eligible: false, reason: "MARKET_RESOLVED" });
  });

  it("denies an INACTIVE/ARCHIVED market (null consumer status)", () => {
    expect(checkMarketEligibility(baseInput({ consumerStatus: null }), PERMISSIVE_POLICY)).toEqual({
      eligible: false,
      reason: "MARKET_INACTIVE",
    });
  });

  describe("CLOSED market policy", () => {
    it("denies by default", () => {
      expect(checkMarketEligibility(baseInput({ consumerStatus: "CLOSED" }), DEFAULT_POLICY)).toEqual({
        eligible: false,
        reason: "MARKET_CLOSED",
      });
    });

    it("permits when policy explicitly allows it — configuration-only change", () => {
      expect(
        checkMarketEligibility(baseInput({ consumerStatus: "CLOSED" }), { ...DEFAULT_POLICY, allowClosedMarket: true }),
      ).toEqual({ eligible: true });
    });
  });

  describe("price availability policy", () => {
    it("denies an unavailable price by default", () => {
      expect(checkMarketEligibility(baseInput({ freshness: "UNAVAILABLE", yesPrice: null, noPrice: null }), DEFAULT_POLICY)).toEqual(
        { eligible: false, reason: "PRICE_UNAVAILABLE" },
      );
    });

    it("permits an unavailable price when policy explicitly allows it — still needs a real snapshot value though", () => {
      // Policy allows UNAVAILABLE freshness, but a genuine snapshot still
      // needs both real numbers — freshness classification alone doesn't
      // guarantee that.
      const result = checkMarketEligibility(
        baseInput({ freshness: "UNAVAILABLE", yesPrice: null, noPrice: null }),
        { ...DEFAULT_POLICY, allowUnavailablePrice: true },
      );
      expect(result).toEqual({ eligible: false, reason: "PRICE_UNAVAILABLE" });
    });

    it("denies a STALE price by policy", () => {
      expect(checkMarketEligibility(baseInput({ freshness: "STALE" }), { ...DEFAULT_POLICY, allowStalePrice: false })).toEqual({
        eligible: false,
        reason: "PRICE_STALE",
      });
    });

    it("permits a STALE price by default", () => {
      expect(checkMarketEligibility(baseInput({ freshness: "STALE" }), DEFAULT_POLICY)).toEqual({ eligible: true });
    });

    it("never derives NO from YES or vice versa — a missing single side still denies", () => {
      expect(checkMarketEligibility(baseInput({ yesPrice: null }), PERMISSIVE_POLICY)).toEqual({
        eligible: false,
        reason: "PRICE_UNAVAILABLE",
      });
      expect(checkMarketEligibility(baseInput({ noPrice: null }), PERMISSIVE_POLICY)).toEqual({
        eligible: false,
        reason: "PRICE_UNAVAILABLE",
      });
    });
  });

  describe("cutoff policy", () => {
    const closesAt = "2026-01-01T12:00:00Z";

    it("permits right up to the market's own close time when cutoff is 0 (default)", () => {
      const input = baseInput({ closesAt, now: new Date("2026-01-01T11:59:59Z") });
      expect(checkMarketEligibility(input, DEFAULT_POLICY)).toEqual({ eligible: true });
    });

    it("denies inside the configured cutoff window", () => {
      const policy: PredictionPolicy = { ...DEFAULT_POLICY, cutoffMinutesBeforeClose: 15 };
      const input = baseInput({ closesAt, now: new Date("2026-01-01T11:50:00Z") }); // 10 min before close
      expect(checkMarketEligibility(input, policy)).toEqual({ eligible: false, reason: "PAST_CUTOFF" });
    });

    it("permits outside the configured cutoff window", () => {
      const policy: PredictionPolicy = { ...DEFAULT_POLICY, cutoffMinutesBeforeClose: 15 };
      const input = baseInput({ closesAt, now: new Date("2026-01-01T11:00:00Z") }); // 60 min before close
      expect(checkMarketEligibility(input, policy)).toEqual({ eligible: true });
    });

    it("never applies a cutoff when the market has no known close time", () => {
      const policy: PredictionPolicy = { ...DEFAULT_POLICY, cutoffMinutesBeforeClose: 15 };
      expect(checkMarketEligibility(baseInput({ closesAt: null }), policy)).toEqual({ eligible: true });
    });
  });
});

/**
 * The pure grading-notification decision (Milestone 3 final
 * notification-policy remediation). Everything here is about two
 * properties: an unreadable/malformed policy always denies (fail closed —
 * unlike eligibility policy above, which fails open), and no
 * PredictionResult can bypass policy by not being explicitly recognized.
 */
describe("shouldNotifyForResult", () => {
  const ALL_ENABLED: PredictionNotificationPolicy = {
    enabled: true,
    notifyOnCorrect: true,
    notifyOnIncorrect: true,
    notifyOnVoid: true,
  };

  it("permits CORRECT/INCORRECT/VOID under the default (all-enabled) policy", () => {
    expect(shouldNotifyForResult("CORRECT", ALL_ENABLED)).toBe(true);
    expect(shouldNotifyForResult("INCORRECT", ALL_ENABLED)).toBe(true);
    expect(shouldNotifyForResult("VOID", ALL_ENABLED)).toBe(true);
  });

  it("denies everything when the master switch is off, even if every per-result flag is true", () => {
    const policy: PredictionNotificationPolicy = { ...ALL_ENABLED, enabled: false };
    expect(shouldNotifyForResult("CORRECT", policy)).toBe(false);
    expect(shouldNotifyForResult("INCORRECT", policy)).toBe(false);
    expect(shouldNotifyForResult("VOID", policy)).toBe(false);
  });

  it("denies only CORRECT when notifyOnCorrect is off, leaving the other two untouched", () => {
    const policy: PredictionNotificationPolicy = { ...ALL_ENABLED, notifyOnCorrect: false };
    expect(shouldNotifyForResult("CORRECT", policy)).toBe(false);
    expect(shouldNotifyForResult("INCORRECT", policy)).toBe(true);
    expect(shouldNotifyForResult("VOID", policy)).toBe(true);
  });

  it("denies only INCORRECT when notifyOnIncorrect is off, leaving the other two untouched", () => {
    const policy: PredictionNotificationPolicy = { ...ALL_ENABLED, notifyOnIncorrect: false };
    expect(shouldNotifyForResult("CORRECT", policy)).toBe(true);
    expect(shouldNotifyForResult("INCORRECT", policy)).toBe(false);
    expect(shouldNotifyForResult("VOID", policy)).toBe(true);
  });

  it("denies only VOID when notifyOnVoid is off, leaving the other two untouched", () => {
    const policy: PredictionNotificationPolicy = { ...ALL_ENABLED, notifyOnVoid: false };
    expect(shouldNotifyForResult("CORRECT", policy)).toBe(true);
    expect(shouldNotifyForResult("INCORRECT", policy)).toBe(true);
    expect(shouldNotifyForResult("VOID", policy)).toBe(false);
  });

  it("fails closed when the policy is null (unreadable/malformed) — never falls back to notifying", () => {
    expect(shouldNotifyForResult("CORRECT", null)).toBe(false);
    expect(shouldNotifyForResult("INCORRECT", null)).toBe(false);
    expect(shouldNotifyForResult("VOID", null)).toBe(false);
  });

  it("denies a result value this function does not explicitly recognize — no default-true fallthrough", () => {
    // A hypothetical future/corrupt result value cannot bypass policy by
    // simply not matching CORRECT/INCORRECT/VOID.
    const unknownResult = "SOMETHING_ELSE" as unknown as PredictionResult;
    expect(shouldNotifyForResult(unknownResult, ALL_ENABLED)).toBe(false);
  });
});
