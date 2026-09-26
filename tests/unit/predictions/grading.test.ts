import { describe, expect, it } from "vitest";
import { decideGrading, decideGradingForMarket } from "@/lib/predictions/grading";
import type { MarketRecord } from "@/lib/prediction-markets/repository";
import type { FixtureForGrading } from "@/lib/sports-data/fixture-lookup";

/**
 * The pure per-prediction grading decision, in isolation from any
 * database. Provider resolution -> normalized Market resolution ->
 * Prediction grading (roadmap STEP 18) — this test never constructs a raw
 * provider payload, only an already-normalized MarketRecord, proving
 * grading only ever reads from the normalized boundary.
 */

function market(overrides: Partial<MarketRecord> = {}): MarketRecord {
  return {
    id: "m1",
    provider: "api-sports",
    providerMarketId: "0xabc",
    providerEventId: null,
    question: "Will X happen?",
    description: null,
    status: "ACTIVE",
    fixtureId: "f1",
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    yesPrice: 0.6,
    noPrice: 0.4,
    priceOutcomeLabels: null,
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

describe("decideGrading", () => {
  it("leaves the decision still-pending when the market can't be found — a data anomaly, not a fabricated result", () => {
    expect(decideGrading(null, "YES")).toEqual({ decision: "still-pending" });
  });

  it("leaves ACTIVE markets still-pending — never fabricates a result before resolution", () => {
    expect(decideGrading(market({ status: "ACTIVE" }), "YES")).toEqual({ decision: "still-pending" });
  });

  it("leaves CLOSED-but-unresolved markets still-pending", () => {
    expect(decideGrading(market({ status: "CLOSED", resolvedOutcome: null }), "YES")).toEqual({ decision: "still-pending" });
  });

  it("grades CORRECT when the resolved outcome matches the user's selection", () => {
    const result = decideGrading(market({ status: "CLOSED", resolvedOutcome: "YES" }), "YES");
    expect(result).toEqual({ decision: "graded", result: "CORRECT", resolvedOutcomeSnapshot: "YES" });
  });

  it("grades INCORRECT when the resolved outcome contradicts the user's selection", () => {
    const result = decideGrading(market({ status: "CLOSED", resolvedOutcome: "YES" }), "NO");
    expect(result).toEqual({ decision: "graded", result: "INCORRECT", resolvedOutcomeSnapshot: "YES" });
  });

  it("grades the NO side symmetrically", () => {
    const result = decideGrading(market({ status: "CLOSED", resolvedOutcome: "NO" }), "NO");
    expect(result).toEqual({ decision: "graded", result: "CORRECT", resolvedOutcomeSnapshot: "NO" });
  });

  it("grades VOID for an ARCHIVED market that never resolved — genuinely undecidable, not left pending forever", () => {
    const result = decideGrading(market({ status: "ARCHIVED", resolvedOutcome: null }), "YES");
    expect(result).toEqual({ decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null });
  });

  it("leaves a merely INACTIVE market still-pending — not terminal, unlike ARCHIVED", () => {
    expect(decideGrading(market({ status: "INACTIVE" }), "YES")).toEqual({ decision: "still-pending" });
  });
});

/**
 * Milestone R1's grading entry point: the objective result comes from the
 * linked Game (fixture), never from `market.resolvedOutcome`. Pure —
 * fixture is passed in directly, no database.
 */
function fixture(overrides: Partial<FixtureForGrading> = {}): FixtureForGrading {
  return { id: "f1", internalStatus: "COMPLETED", homeScore: 21, awayScore: 14, ...overrides };
}

describe("decideGradingForMarket", () => {
  it("is still-pending when the market can't be found", () => {
    expect(decideGradingForMarket(null, fixture(), "YES")).toEqual({ decision: "still-pending" });
  });

  it("is VOID for an ARCHIVED market without ever looking at the fixture", () => {
    const result = decideGradingForMarket(market({ status: "ARCHIVED" }), null, "YES");
    expect(result).toEqual({ decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null });
  });

  it("is still-pending when the fixture lookup misses — never fabricates a result over a data anomaly", () => {
    expect(decideGradingForMarket(market({ status: "CLOSED" }), null, "YES")).toEqual({ decision: "still-pending" });
  });

  it("is still-pending while the Game has not completed", () => {
    const result = decideGradingForMarket(market({ status: "ACTIVE" }), fixture({ internalStatus: "LIVE" }), "YES");
    expect(result).toEqual({ decision: "still-pending" });
  });

  it("grades CORRECT from the fixture score for a MONEYLINE market, ignoring resolvedOutcome entirely", () => {
    const m = market({ status: "CLOSED", marketTemplate: "MONEYLINE", lineValue: null, yesSide: "HOME", resolvedOutcome: "NO" });
    const result = decideGradingForMarket(m, fixture({ homeScore: 21, awayScore: 14 }), "YES");
    expect(result).toEqual({ decision: "graded", result: "CORRECT", resolvedOutcomeSnapshot: "YES" });
  });

  it("grades INCORRECT from the fixture score when the user picked the losing side", () => {
    const m = market({ status: "CLOSED", marketTemplate: "MONEYLINE", lineValue: null, yesSide: "HOME" });
    const result = decideGradingForMarket(m, fixture({ homeScore: 10, awayScore: 20 }), "YES");
    expect(result).toEqual({ decision: "graded", result: "INCORRECT", resolvedOutcomeSnapshot: "NO" });
  });

  it("grades VOID on a true SPREAD push", () => {
    const m = market({ status: "CLOSED", marketTemplate: "SPREAD", lineValue: 6, yesSide: "HOME" });
    const result = decideGradingForMarket(m, fixture({ homeScore: 14, awayScore: 20 }), "YES");
    expect(result).toEqual({ decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null });
  });

  it("grades VOID when the Game was CANCELLED", () => {
    const m = market({ status: "CLOSED", marketTemplate: "MONEYLINE", lineValue: null, yesSide: "HOME" });
    const result = decideGradingForMarket(m, fixture({ internalStatus: "CANCELLED", homeScore: null, awayScore: null }), "YES");
    expect(result).toEqual({ decision: "graded", result: "VOID", resolvedOutcomeSnapshot: null });
  });
});
