import { describe, expect, it } from "vitest";
import { TEMPLATE_REGISTRY, getLatestTemplate } from "@/lib/pools/templates/registry";
import {
  defaultConfigFor,
  detectConflicts,
  estimateYesProbability,
  rankRecommendations,
  relationshipToActivePools,
  scoreTemplate,
  type ActivePoolSummary,
} from "@/lib/pools/templates/recommendations";

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
    // MATCH_RESULT(4) + GOALS(11) + DISCIPLINE(1) = 16 scorable templates;
    // PLAYER_TO_SCORE (PLAYER_PROPS) is excluded from ranking entirely.
    expect(recommended.length + other.length).toBe(16);
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
