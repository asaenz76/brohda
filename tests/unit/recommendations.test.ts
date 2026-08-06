import { describe, expect, it } from "vitest";
import { TEMPLATE_REGISTRY, getLatestTemplate } from "@/lib/pools/templates/registry";
import { cleanSheet } from "@/lib/pools/templates/goals";
import {
  defaultConfigFor,
  detectConflicts,
  estimateYesProbability,
  estimateYesProbabilityWithSource,
  rankRecommendations,
  relationshipToActivePools,
  scoreTemplate,
  type ActivePoolSummary,
} from "@/lib/pools/templates/recommendations";
import type { NormalizedFixtureMarkets } from "@/lib/sports-data/types";

describe("estimateYesProbability", () => {
  it("stays within [0.02, 0.98] for every registry template's default config", () => {
    for (const template of TEMPLATE_REGISTRY) {
      const p = estimateYesProbability(template.id, defaultConfigFor(template));
      expect(p, template.id).toBeGreaterThanOrEqual(0.02);
      expect(p, template.id).toBeLessThanOrEqual(0.98);
    }
  });

  it("decreases as MATCH_TOTAL_GOALS' threshold rises", () => {
    const low = estimateYesProbability("MATCH_TOTAL_GOALS", { minimumGoals: 1 });
    const mid = estimateYesProbability("MATCH_TOTAL_GOALS", { minimumGoals: 3 });
    const high = estimateYesProbability("MATCH_TOTAL_GOALS", { minimumGoals: 6 });
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
  });

  it("home win is estimated more likely than away win (generic home-advantage prior)", () => {
    expect(estimateYesProbability("HOME_TEAM_TO_WIN", {})).toBeGreaterThan(
      estimateYesProbability("AWAY_TEAM_TO_WIN", {}),
    );
  });

  it("both teams to score is close to a coin flip", () => {
    expect(estimateYesProbability("BOTH_TEAMS_TO_SCORE", {})).toBe(0.5);
  });
});

describe("relationshipToActivePools", () => {
  it("is NONE with no active pools", () => {
    expect(relationshipToActivePools({ templateId: "HOME_TEAM_TO_WIN", config: {} }, [])).toBe("NONE");
  });

  it("is EXACT_DUPLICATE when the same template+config is already active", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "MATCH_TOTAL_GOALS", templateConfig: { minimumGoals: 3 } },
    ];
    expect(relationshipToActivePools({ templateId: "MATCH_TOTAL_GOALS", config: { minimumGoals: 3 } }, active)).toBe(
      "EXACT_DUPLICATE",
    );
  });

  it("is MIRROR_EXISTS when the opposite side of the same question is already active", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "HOME_TEAM_TO_WIN", templateConfig: {} },
    ];
    expect(relationshipToActivePools({ templateId: "AWAY_TEAM_TO_WIN", config: {} }, active)).toBe("MIRROR_EXISTS");
  });

  it("is DUPLICATE_FAMILY when a related-but-different question in the same family is active", () => {
    // Legacy WHO_WILL_ADVANCE and registry HOME_TEAM_TO_WIN share the
    // MATCH_RESULT family but are neither an exact duplicate nor a mirror.
    const active: ActivePoolSummary[] = [{ poolType: "WHO_WILL_ADVANCE", templateId: null, templateConfig: null }];
    expect(relationshipToActivePools({ templateId: "HOME_TEAM_TO_WIN", config: {} }, active)).toBe(
      "DUPLICATE_FAMILY",
    );
  });

  it("is NONE when the active pool is in a different family entirely", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "RED_CARD", templateConfig: { includeSecondYellowDismissal: false } },
    ];
    expect(relationshipToActivePools({ templateId: "BOTH_TEAMS_TO_SCORE", config: {} }, active)).toBe("NONE");
  });
});

describe("detectConflicts", () => {
  it("has no warnings for a balanced question with no active pools", () => {
    const warnings = detectConflicts({ templateId: "BOTH_TEAMS_TO_SCORE", config: {} }, [], 0.5);
    expect(warnings).toEqual([]);
  });

  it("flags EXACT_DUPLICATE", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "HOME_TEAM_TO_WIN", templateConfig: {} },
    ];
    const warnings = detectConflicts({ templateId: "HOME_TEAM_TO_WIN", config: {} }, active, 0.45);
    expect(warnings.map((w) => w.code)).toContain("EXACT_DUPLICATE");
  });

  it("flags MIRROR_EXISTS", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "HOME_TEAM_TO_WIN", templateConfig: {} },
    ];
    const warnings = detectConflicts({ templateId: "AWAY_TEAM_TO_WIN", config: {} }, active, 0.29);
    expect(warnings.map((w) => w.code)).toContain("MIRROR_EXISTS");
  });

  it("flags DUPLICATE_FAMILY for a same-family, non-mirror overlap", () => {
    const active: ActivePoolSummary[] = [{ poolType: "REGULATION_RESULT", templateId: null, templateConfig: null }];
    const warnings = detectConflicts({ templateId: "HOME_TEAM_TO_WIN", config: {} }, active, 0.45);
    expect(warnings.map((w) => w.code)).toContain("DUPLICATE_FAMILY");
  });

  it("flags VERY_UNBALANCED for an extreme probability", () => {
    const warnings = detectConflicts({ templateId: "MATCH_TOTAL_GOALS", config: { minimumGoals: 15 } }, [], 0.05);
    expect(warnings.map((w) => w.code)).toContain("VERY_UNBALANCED");
  });

  it("flags POOR_BALANCE (not VERY_UNBALANCED) for a moderately skewed probability", () => {
    const warnings = detectConflicts({ templateId: "AWAY_TEAM_TO_WIN", config: {} }, [], 0.75);
    expect(warnings.map((w) => w.code)).toContain("POOR_BALANCE");
    expect(warnings.map((w) => w.code)).not.toContain("VERY_UNBALANCED");
  });
});

describe("scoreTemplate", () => {
  it("scores a balanced, clean question higher than one with an active mirror", () => {
    const bothTeamsToScore = getLatestTemplate("BOTH_TEAMS_TO_SCORE")!;
    const homeTeamToWin = getLatestTemplate("HOME_TEAM_TO_WIN")!;
    const activeMirror: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "AWAY_TEAM_TO_WIN", templateConfig: {} },
    ];

    const clean = scoreTemplate(bothTeamsToScore, []);
    const mirrored = scoreTemplate(homeTeamToWin, activeMirror);

    expect(clean.stars).toBeGreaterThan(mirrored.stars);
    expect(mirrored.warnings.map((w) => w.code)).toContain("MIRROR_EXISTS");
  });

  it("carries the estimated probability and grading reliability through", () => {
    const template = getLatestTemplate("BOTH_TEAMS_TO_SCORE")!;
    const rec = scoreTemplate(template, []);
    expect(rec.yesProbability).toBe(0.5);
    expect(rec.gradingReliability).toBe("AUTO");
  });
});

describe("rankRecommendations", () => {
  it("splits eligible registry templates into recommended (capped) and other", () => {
    const { recommended, other } = rankRecommendations([]);
    // Launch simplification retired 12 of 17 templates from creation (see
    // template-cards.ts) — getLatestTemplate (which rankRecommendations
    // resolves every candidate through) returns null for a retired
    // template, so only the 5 still-active templates are scorable today:
    // HOME_TEAM_TO_WIN/AWAY_TEAM_TO_WIN (MATCH_RESULT) +
    // MATCH_TOTAL_GOALS/BOTH_TEAMS_TO_SCORE/WINNING_MARGIN (GOALS).
    // PLAYER_TO_SCORE (PLAYER_PROPS) is excluded from ranking entirely,
    // regardless of activeForCreation.
    expect(recommended.length + other.length).toBe(5);
    expect(recommended.length).toBeLessThanOrEqual(5);
    expect(recommended.every((r) => r.template.category !== "PLAYER_PROPS")).toBe(true);
    expect(other.every((r) => r.template.category !== "PLAYER_PROPS")).toBe(true);
  });

  it("never recommends a template with an active exact duplicate or mirror", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "HOME_TEAM_TO_WIN", templateConfig: {} },
    ];
    const { recommended } = rankRecommendations(active);
    expect(recommended.some((r) => r.template.id === "HOME_TEAM_TO_WIN")).toBe(false); // exact duplicate
    expect(recommended.some((r) => r.template.id === "AWAY_TEAM_TO_WIN")).toBe(false); // mirror
  });

  it("orders recommended templates by star rating, highest first", () => {
    const { recommended } = rankRecommendations([]);
    for (let i = 1; i < recommended.length; i++) {
      expect(recommended[i - 1].stars).toBeGreaterThanOrEqual(recommended[i].stars);
    }
  });
});

describe("estimateYesProbabilityWithSource", () => {
  it("falls back to STATIC_PRIOR when markets is null", () => {
    const estimate = estimateYesProbabilityWithSource("BOTH_TEAMS_TO_SCORE", {}, null);
    expect(estimate.source).toBe("STATIC_PRIOR");
    expect(estimate.probability).toBe(estimateYesProbability("BOTH_TEAMS_TO_SCORE", {}));
    expect(estimate.bookmakerCount).toBe(0);
    expect(estimate.resolvedConfig).toBeNull();
  });

  it("falls back to STATIC_PRIOR for a non-allowlisted template even with markets present", () => {
    const markets: NormalizedFixtureMarkets = {
      externalFixtureId: "f1",
      providerUpdatedAt: "2026-08-03T00:15:08Z",
      matchWinner: [],
      markets: [],
    };
    const estimate = estimateYesProbabilityWithSource("RED_CARD", { includeSecondYellowDismissal: false }, markets);
    expect(estimate.source).toBe("STATIC_PRIOR");
  });

  it("uses real market consensus for an allowlisted template when markets clear the bar", () => {
    const markets: NormalizedFixtureMarkets = {
      externalFixtureId: "f1",
      providerUpdatedAt: "2026-08-03T00:15:08Z",
      matchWinner: [],
      markets: [
        {
          key: "BOTH_TEAMS_SCORE",
          lines: [
            {
              point: 0,
              propositions: [
                { bookmakerId: 1, bookmakerName: "10Bet", yesOdd: 2.1, noOdd: 1.65 },
                { bookmakerId: 4, bookmakerName: "Pinnacle", yesOdd: 2.05, noOdd: 1.7 },
                { bookmakerId: 8, bookmakerName: "Bet365", yesOdd: 2.15, noOdd: 1.6 },
              ],
            },
          ],
        },
      ],
    };
    const estimate = estimateYesProbabilityWithSource("BOTH_TEAMS_TO_SCORE", {}, markets);
    expect(estimate.source).toBe("MARKET_CONSENSUS");
    expect(estimate.bookmakerCount).toBe(3);
    expect(estimate.probability).not.toBe(estimateYesProbability("BOTH_TEAMS_TO_SCORE", {}));
  });
});

describe("rankRecommendations — HOME/AWAY unbiased generation", () => {
  it("picks the better-balanced side of a team-scoped template instead of always defaulting to HOME", () => {
    // Real odds: home clean sheet is very unlikely (~15%), away clean sheet
    // is close to a coin flip (~50%) — the away side should win.
    const markets: NormalizedFixtureMarkets = {
      externalFixtureId: "f1",
      providerUpdatedAt: "2026-08-03T00:15:08Z",
      matchWinner: [],
      markets: [
        {
          key: "CLEAN_SHEET_HOME",
          lines: [
            {
              point: 0,
              propositions: [
                { bookmakerId: 1, bookmakerName: "10Bet", yesOdd: 6.5, noOdd: 1.12 },
                { bookmakerId: 4, bookmakerName: "Pinnacle", yesOdd: 6.6, noOdd: 1.11 },
                { bookmakerId: 8, bookmakerName: "Bet365", yesOdd: 6.4, noOdd: 1.13 },
              ],
            },
          ],
        },
        {
          key: "CLEAN_SHEET_AWAY",
          lines: [
            {
              point: 0,
              propositions: [
                { bookmakerId: 1, bookmakerName: "10Bet", yesOdd: 2.0, noOdd: 1.9 },
                { bookmakerId: 4, bookmakerName: "Pinnacle", yesOdd: 1.95, noOdd: 1.95 },
                { bookmakerId: 8, bookmakerName: "Bet365", yesOdd: 2.05, noOdd: 1.85 },
              ],
            },
          ],
        },
      ],
    };

    // CLEAN_SHEET is retired from creation for launch (activeForCreation:
    // false — see lib/pools/templates/goals.ts), so it's no longer
    // reachable through rankRecommendations (which resolves every
    // candidate through getLatestTemplate). The HOME/AWAY market-balancing
    // logic under test here — score both sides, keep whichever lands
    // closer to 50/50 — lives in recommendations.ts's private
    // scoreCandidate/betterBalanced helpers; reproduced directly against
    // scoreTemplate (still fully functional, just no longer offered for
    // creation) rather than exporting a private helper solely for this test.
    const homeRec = scoreTemplate(cleanSheet, [], { ...defaultConfigFor(cleanSheet), team: "HOME" }, markets);
    const awayRec = scoreTemplate(cleanSheet, [], { ...defaultConfigFor(cleanSheet), team: "AWAY" }, markets);
    const cleanSheetRec =
      Math.abs(homeRec.yesProbability - 0.5) <= Math.abs(awayRec.yesProbability - 0.5) ? homeRec : awayRec;
    expect(cleanSheetRec.config.team).toBe("AWAY");
    expect(Math.abs(cleanSheetRec.yesProbability - 0.5)).toBeLessThan(0.1);
  });

  it("still returns exactly one entry per template id (never both home and away)", () => {
    const { recommended, other } = rankRecommendations([], null);
    const ids = [...recommended, ...other].map((r) => r.template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("with markets=null, behaves identically to the pre-odds version for every candidate", () => {
    const { recommended, other } = rankRecommendations([]);
    for (const rec of [...recommended, ...other]) {
      expect(rec.probabilitySource).toBe("STATIC_PRIOR");
      expect(rec.bookmakerCount).toBe(0);
      expect(rec.oddsLine).toBeNull();
    }
  });
});
