import { describe, expect, it } from "vitest";
import { computeSportsMarketOutcome, type SportsMarketDefinition } from "@/lib/predictions/sports-resolution";
import type { FixtureForGrading } from "@/lib/sports-data/fixture-lookup";

/**
 * Pure unit coverage for Milestone R1's objective sports-Market resolution
 * (docs/BROHDA_2_0_MILESTONE_MAP.md, Game <-> Market Foundation §9-10, §33).
 * No database — a plain SportsMarketDefinition + FixtureForGrading in,
 * one of YES/NO/VOID/PENDING out.
 */

function fixture(overrides: Partial<FixtureForGrading> = {}): FixtureForGrading {
  return { id: "f1", internalStatus: "COMPLETED", homeScore: 0, awayScore: 0, ...overrides };
}

const moneyline = (overrides: Partial<SportsMarketDefinition> = {}): SportsMarketDefinition => ({
  marketTemplate: "MONEYLINE",
  lineValue: null,
  yesSide: "HOME",
  ...overrides,
});

const spread = (overrides: Partial<SportsMarketDefinition> = {}): SportsMarketDefinition => ({
  marketTemplate: "SPREAD",
  lineValue: 6.5,
  yesSide: "HOME",
  ...overrides,
});

const total = (overrides: Partial<SportsMarketDefinition> = {}): SportsMarketDefinition => ({
  marketTemplate: "TOTAL",
  lineValue: 47.5,
  yesSide: null,
  ...overrides,
});

describe("computeSportsMarketOutcome — event lifecycle", () => {
  it("is PENDING while the Game has not started", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "NOT_STARTED", homeScore: null, awayScore: null }))).toBe("PENDING");
  });

  it("is PENDING while the Game is LIVE — never fabricates a result mid-game", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "LIVE", homeScore: 10, awayScore: 3 }))).toBe("PENDING");
  });

  it("is PENDING when POSTPONED — the Game will still happen, this is temporary", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "POSTPONED", homeScore: null, awayScore: null }))).toBe("PENDING");
  });

  it("is VOID when CANCELLED — the Game never happened, deterministically", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "CANCELLED", homeScore: null, awayScore: null }))).toBe("VOID");
  });

  it("is PENDING (deferred product policy, not guessed) for SUSPENDED", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "SUSPENDED" }))).toBe("PENDING");
  });

  it("is PENDING (deferred product policy, not guessed) for ABANDONED", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "ABANDONED" }))).toBe("PENDING");
  });

  it("is PENDING (deferred product policy, not guessed) for AWARDED", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "AWARDED" }))).toBe("PENDING");
  });

  it("is PENDING if COMPLETED but somehow missing a score — never guesses", () => {
    expect(computeSportsMarketOutcome(moneyline(), fixture({ internalStatus: "COMPLETED", homeScore: null, awayScore: 3 }))).toBe("PENDING");
  });
});

describe("computeSportsMarketOutcome — MONEYLINE", () => {
  it("YES when the yes_side (HOME) wins outright", () => {
    expect(computeSportsMarketOutcome(moneyline({ yesSide: "HOME" }), fixture({ homeScore: 24, awayScore: 17 }))).toBe("YES");
  });

  it("NO when the yes_side (HOME) loses", () => {
    expect(computeSportsMarketOutcome(moneyline({ yesSide: "HOME" }), fixture({ homeScore: 10, awayScore: 20 }))).toBe("NO");
  });

  it("is symmetric for yes_side AWAY", () => {
    expect(computeSportsMarketOutcome(moneyline({ yesSide: "AWAY" }), fixture({ homeScore: 10, awayScore: 20 }))).toBe("YES");
    expect(computeSportsMarketOutcome(moneyline({ yesSide: "AWAY" }), fixture({ homeScore: 20, awayScore: 10 }))).toBe("NO");
  });

  it("a draw resolves NO for the yes_side — MONEYLINE is a strict 'wins outright' proposition, not VOID", () => {
    expect(computeSportsMarketOutcome(moneyline({ yesSide: "HOME" }), fixture({ homeScore: 14, awayScore: 14 }))).toBe("NO");
  });
});

describe("computeSportsMarketOutcome — SPREAD", () => {
  it("YES when yes_side covers (score + line still ahead)", () => {
    // Giants (HOME) +6.5, lose by 3 -> 3+6.5=9.5 > opponent's raw score margin -> covers
    expect(computeSportsMarketOutcome(spread({ yesSide: "HOME", lineValue: 6.5 }), fixture({ homeScore: 17, awayScore: 20 }))).toBe("YES");
  });

  it("NO when yes_side fails to cover", () => {
    expect(computeSportsMarketOutcome(spread({ yesSide: "HOME", lineValue: 6.5 }), fixture({ homeScore: 10, awayScore: 20 }))).toBe("NO");
  });

  it("a favorite laying points (negative line) must win by more than the line to be YES", () => {
    // Wins by 7 (21-14), needs more than 6.5 to cover -6.5 -> covers.
    expect(computeSportsMarketOutcome(spread({ yesSide: "HOME", lineValue: -6.5 }), fixture({ homeScore: 21, awayScore: 14 }))).toBe("YES");
    // Wins by only 6 (20-14), short of 6.5 -> does not cover.
    expect(computeSportsMarketOutcome(spread({ yesSide: "HOME", lineValue: -6.5 }), fixture({ homeScore: 20, awayScore: 14 }))).toBe("NO");
  });

  it("VOID on an exact push — the line lands exactly on the final margin", () => {
    // HOME +6.5 can never push (half-point line) — use a whole-number line to construct a true push.
    expect(computeSportsMarketOutcome(spread({ yesSide: "HOME", lineValue: 6 }), fixture({ homeScore: 14, awayScore: 20 }))).toBe("VOID");
  });
});

describe("computeSportsMarketOutcome — TOTAL", () => {
  it("YES (over) when combined score exceeds the line", () => {
    expect(computeSportsMarketOutcome(total({ lineValue: 47.5 }), fixture({ homeScore: 28, awayScore: 24 }))).toBe("YES");
  });

  it("NO (under) when combined score is below the line", () => {
    expect(computeSportsMarketOutcome(total({ lineValue: 47.5 }), fixture({ homeScore: 10, awayScore: 13 }))).toBe("NO");
  });

  it("VOID on an exact push against a whole-number total line", () => {
    expect(computeSportsMarketOutcome(total({ lineValue: 47 }), fixture({ homeScore: 24, awayScore: 23 }))).toBe("VOID");
  });
});

describe("computeSportsMarketOutcome — historical permanence property", () => {
  it("the same fixture result always produces the same outcome for a given, unchanged proposition — proving no hidden mutable state", () => {
    const definition = spread({ yesSide: "HOME", lineValue: 6.5 });
    const finalFixture = fixture({ homeScore: 14, awayScore: 20 });
    const first = computeSportsMarketOutcome(definition, finalFixture);
    const second = computeSportsMarketOutcome(definition, finalFixture);
    expect(first).toBe(second);
    expect(first).toBe("YES");

    // A DIFFERENT proposition (the line moved to 5.5) on the identical final
    // score can produce a different outcome — this is exactly why a moved
    // line must be a new Market row, never an update to this one: the two
    // definitions below are not the same proposition and are never
    // conflated by this function.
    const movedLine = spread({ yesSide: "HOME", lineValue: 5.5 });
    expect(computeSportsMarketOutcome(movedLine, finalFixture)).toBe("NO");
  });
});
