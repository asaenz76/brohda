import { describe, expect, it } from "vitest";
import {
  nflGameTotal,
  nflGameTotalConfigSchema,
  nflSpread,
  nflSpreadConfigSchema,
  nflTeamTotal,
  nflTeamTotalConfigSchema,
} from "@/lib/pools/templates/nfl";
import type { TemplateFixtureScore } from "@/lib/pools/templates/types";

// Note: `team` on NFL_SPREAD/NFL_TEAM_TOTAL is TEAM_SIDE (HOME/AWAY), not a
// raw team id — "subject team doesn't belong to this game" is structurally
// impossible by construction, so there's no test for it.

function fixture(overrides: Partial<TemplateFixtureScore> = {}): TemplateFixtureScore {
  return {
    homeTeamName: "Green Bay Packers",
    awayTeamName: "Pittsburgh Steelers",
    homeTeamExternalId: "1",
    awayTeamExternalId: "2",
    regulationHomeScore: null,
    regulationAwayScore: null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
    ...overrides,
  };
}

describe("nflSpread", () => {
  // Packers -1.5 -> stored as { team: "HOME", line: 1.5 } (the config is
  // always normalized around the favorite, never a raw signed spread).
  const config = { team: "HOME" as const, line: 1.5 };

  it("YES — Packers win 24-21 (margin 3 > 1.5)", () => {
    const result = nflSpread.gradingRule(
      { fixture: fixture({ regulationHomeScore: 24, regulationAwayScore: 21 }) },
      config,
    );
    expect(result.result).toBe("YES");
  });

  it("NO — Packers win 21-20 (margin 1, not > 1.5)", () => {
    const result = nflSpread.gradingRule(
      { fixture: fixture({ regulationHomeScore: 21, regulationAwayScore: 20 }) },
      config,
    );
    expect(result.result).toBe("NO");
  });

  it("NO — game ends tied 20-20 (margin 0) — resolves deterministically, no special-case branch needed", () => {
    const result = nflSpread.gradingRule(
      { fixture: fixture({ regulationHomeScore: 20, regulationAwayScore: 20 }) },
      config,
    );
    expect(result.result).toBe("NO");
  });

  it("NO — Packers lose", () => {
    const result = nflSpread.gradingRule(
      { fixture: fixture({ regulationHomeScore: 17, regulationAwayScore: 24 }) },
      config,
    );
    expect(result.result).toBe("NO");
  });

  it("PENDING when either score is missing", () => {
    expect(
      nflSpread.gradingRule({ fixture: fixture({ regulationHomeScore: 24, regulationAwayScore: null }) }, config)
        .result,
    ).toBe("PENDING");
    expect(
      nflSpread.gradingRule({ fixture: fixture({ regulationHomeScore: null, regulationAwayScore: 21 }) }, config)
        .result,
    ).toBe("PENDING");
  });

  it("question wording rounds the half-point line up to the next whole number", () => {
    expect(nflSpread.questionBuilder(fixture(), config)).toBe(
      "Will Green Bay Packers win by 2+ points?",
    );
  });
});

describe("nflGameTotal", () => {
  const config = { line: 39.5 };

  it("YES — 45 total (> 39.5)", () => {
    expect(
      nflGameTotal.gradingRule({ fixture: fixture({ regulationHomeScore: 24, regulationAwayScore: 21 }) }, config)
        .result,
    ).toBe("YES");
  });

  it("YES — 40 total (> 39.5)", () => {
    expect(
      nflGameTotal.gradingRule({ fixture: fixture({ regulationHomeScore: 20, regulationAwayScore: 20 }) }, config)
        .result,
    ).toBe("YES");
  });

  it("NO — 39 total (not > 39.5)", () => {
    expect(
      nflGameTotal.gradingRule({ fixture: fixture({ regulationHomeScore: 20, regulationAwayScore: 19 }) }, config)
        .result,
    ).toBe("NO");
  });

  it("PENDING when either score is missing", () => {
    expect(
      nflGameTotal.gradingRule({ fixture: fixture({ regulationHomeScore: null, regulationAwayScore: 21 }) }, config)
        .result,
    ).toBe("PENDING");
  });

  it("question wording is exact — a 39.5 line reads as 40+, never 39+", () => {
    expect(nflGameTotal.questionBuilder(fixture(), config)).toBe("Will there be 40+ total points scored?");
  });
});

describe("nflTeamTotal", () => {
  const config = { team: "HOME" as const, line: 21.5 };

  it("YES — Packers score 22 (> 21.5)", () => {
    expect(
      nflTeamTotal.gradingRule({ fixture: fixture({ regulationHomeScore: 22, regulationAwayScore: 10 }) }, config)
        .result,
    ).toBe("YES");
  });

  it("NO — Packers score 21 (not > 21.5)", () => {
    expect(
      nflTeamTotal.gradingRule({ fixture: fixture({ regulationHomeScore: 21, regulationAwayScore: 10 }) }, config)
        .result,
    ).toBe("NO");
  });

  it("PENDING when the selected team's score is missing", () => {
    expect(
      nflTeamTotal.gradingRule({ fixture: fixture({ regulationHomeScore: null, regulationAwayScore: 10 }) }, config)
        .result,
    ).toBe("PENDING");
  });

  it("question wording rounds up", () => {
    expect(nflTeamTotal.questionBuilder(fixture(), config)).toBe("Will Green Bay Packers score 22+ points?");
  });
});

describe("half-point line validation — server-side, the actual enforcement boundary", () => {
  it("accepts half-point lines", () => {
    expect(nflSpreadConfigSchema.safeParse({ team: "HOME", line: 1.5 }).success).toBe(true);
    expect(nflSpreadConfigSchema.safeParse({ team: "HOME", line: 2.5 }).success).toBe(true);
    expect(nflGameTotalConfigSchema.safeParse({ line: 39.5 }).success).toBe(true);
    expect(nflTeamTotalConfigSchema.safeParse({ team: "AWAY", line: 21.5 }).success).toBe(true);
  });

  it("rejects whole-number lines — no push/tie outcome is ever possible in this model", () => {
    expect(nflSpreadConfigSchema.safeParse({ team: "HOME", line: 1 }).success).toBe(false);
    expect(nflSpreadConfigSchema.safeParse({ team: "HOME", line: 2 }).success).toBe(false);
    expect(nflGameTotalConfigSchema.safeParse({ line: 40 }).success).toBe(false);
    expect(nflTeamTotalConfigSchema.safeParse({ team: "AWAY", line: 21 }).success).toBe(false);
  });

  it("rejects a non-half-point fractional line", () => {
    expect(nflGameTotalConfigSchema.safeParse({ line: 39.3 }).success).toBe(false);
  });

  it("rejects a line outside the configured bounds", () => {
    expect(nflSpreadConfigSchema.safeParse({ team: "HOME", line: 0 }).success).toBe(false);
    expect(nflGameTotalConfigSchema.safeParse({ line: 100.5 }).success).toBe(false);
  });

  it("rejects an unknown extra config key (strict schemas)", () => {
    expect(nflGameTotalConfigSchema.safeParse({ line: 39.5, pushRule: "void" }).success).toBe(false);
  });
});
