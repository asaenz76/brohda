import { describe, expect, it } from "vitest";
import { TEMPLATE_REGISTRY, getLatestTemplate } from "@/lib/pools/templates/registry";
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

describe("estimateYesProbability", () => {
  it("stays within [0.02, 0.98] for every registry template's default config", () => {
    for (const template of TEMPLATE_REGISTRY) {
      const p = estimateYesProbability(template.id, defaultConfigFor(template));
      expect(p, template.id).toBeGreaterThanOrEqual(0.02);
      expect(p, template.id).toBeLessThanOrEqual(0.98);
    }
  });

  // No real-odds-driven estimation exists anymore (see recommendations.ts's
  // own header comment) — every template, of any config, gets the same
  // flat static prior until a future sport gives this its own typed
  // per-template estimate.
  it("is a flat 0.5 for every template regardless of id or config", () => {
    expect(estimateYesProbability("NFL_SPREAD", { team: "HOME", line: 3.5 })).toBe(0.5);
    expect(estimateYesProbability("NFL_GAME_TOTAL", { line: 40.5 })).toBe(0.5);
    expect(estimateYesProbability("UNKNOWN_TEMPLATE", {})).toBe(0.5);
  });
});

describe("relationshipToActivePools", () => {
  it("is NONE with no active pools", () => {
    expect(relationshipToActivePools({ templateId: "NFL_GAME_TOTAL", config: {} }, [])).toBe("NONE");
  });

  it("is EXACT_DUPLICATE when the same template+config is already active", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "NFL_GAME_TOTAL", templateConfig: { line: 40.5 } },
    ];
    expect(relationshipToActivePools({ templateId: "NFL_GAME_TOTAL", config: { line: 40.5 } }, active)).toBe(
      "EXACT_DUPLICATE",
    );
  });

  it("is MIRROR_EXISTS when the opposite side of a team-scoped template is already active", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "NFL_SPREAD", templateConfig: { team: "HOME", line: 3.5 } },
    ];
    expect(
      relationshipToActivePools({ templateId: "NFL_SPREAD", config: { team: "AWAY", line: 3.5 } }, active),
    ).toBe("MIRROR_EXISTS");
  });

  it("is DUPLICATE_FAMILY when a related-but-different legacy pool type is active", () => {
    // WHO_WILL_ADVANCE and REGULATION_RESULT are both retired from new
    // creation but still classified (families.ts) — both genuinely
    // MATCH_RESULT-shaped, so they still split the same liquidity on a
    // historical fixture that somehow carries both.
    const active: ActivePoolSummary[] = [{ poolType: "REGULATION_RESULT", templateId: null, templateConfig: null }];
    expect(relationshipToActivePools({ templateId: "WHO_WILL_ADVANCE", config: {} }, active)).toBe(
      "DUPLICATE_FAMILY",
    );
  });

  it("is NONE when the active pool is in a different family entirely", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "NFL_TEAM_TOTAL", templateConfig: { team: "HOME", line: 21.5 } },
    ];
    expect(relationshipToActivePools({ templateId: "WHO_WILL_ADVANCE", config: {} }, active)).toBe("NONE");
  });
});

describe("detectConflicts", () => {
  it("has no warnings for a balanced question with no active pools", () => {
    const warnings = detectConflicts({ templateId: "NFL_GAME_TOTAL", config: {} }, [], 0.5);
    expect(warnings).toEqual([]);
  });

  it("flags EXACT_DUPLICATE", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "NFL_GAME_TOTAL", templateConfig: { line: 40.5 } },
    ];
    const warnings = detectConflicts({ templateId: "NFL_GAME_TOTAL", config: { line: 40.5 } }, active, 0.45);
    expect(warnings.map((w) => w.code)).toContain("EXACT_DUPLICATE");
  });

  it("flags MIRROR_EXISTS", () => {
    const active: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "NFL_SPREAD", templateConfig: { team: "HOME", line: 3.5 } },
    ];
    const warnings = detectConflicts({ templateId: "NFL_SPREAD", config: { team: "AWAY", line: 3.5 } }, active, 0.29);
    expect(warnings.map((w) => w.code)).toContain("MIRROR_EXISTS");
  });

  it("flags DUPLICATE_FAMILY for a same-family, non-mirror overlap", () => {
    const active: ActivePoolSummary[] = [{ poolType: "REGULATION_RESULT", templateId: null, templateConfig: null }];
    const warnings = detectConflicts({ templateId: "WHO_WILL_ADVANCE", config: {} }, active, 0.45);
    expect(warnings.map((w) => w.code)).toContain("DUPLICATE_FAMILY");
  });

  it("flags VERY_UNBALANCED for an extreme probability", () => {
    const warnings = detectConflicts({ templateId: "NFL_GAME_TOTAL", config: { line: 90.5 } }, [], 0.05);
    expect(warnings.map((w) => w.code)).toContain("VERY_UNBALANCED");
  });

  it("flags POOR_BALANCE (not VERY_UNBALANCED) for a moderately skewed probability", () => {
    const warnings = detectConflicts({ templateId: "NFL_GAME_TOTAL", config: {} }, [], 0.75);
    expect(warnings.map((w) => w.code)).toContain("POOR_BALANCE");
    expect(warnings.map((w) => w.code)).not.toContain("VERY_UNBALANCED");
  });
});

describe("scoreTemplate", () => {
  it("scores a clean question higher than one with an active mirror", () => {
    const gameTotal = getLatestTemplate("NFL_GAME_TOTAL")!;
    const spread = getLatestTemplate("NFL_SPREAD")!;
    const activeMirror: ActivePoolSummary[] = [
      { poolType: "TEMPLATE_GRADED", templateId: "NFL_SPREAD", templateConfig: { team: "AWAY", line: 0.5 } },
    ];

    const clean = scoreTemplate(gameTotal, []);
    const mirrored = scoreTemplate(spread, activeMirror, { team: "HOME", line: 0.5 });

    expect(clean.stars).toBeGreaterThan(mirrored.stars);
    expect(mirrored.warnings.map((w) => w.code)).toContain("MIRROR_EXISTS");
  });

  it("carries the estimated probability and grading reliability through", () => {
    const template = getLatestTemplate("NFL_GAME_TOTAL")!;
    const rec = scoreTemplate(template, []);
    expect(rec.yesProbability).toBe(0.5);
    expect(rec.gradingReliability).toBe("AUTO");
  });
});

describe("rankRecommendations", () => {
  it("returns nothing for american_football — every NFL template names a real-money threshold with no real-odds path yet, so isDataBackedRecommendation excludes all 3", () => {
    const { recommended, other } = rankRecommendations([], "american_football");
    expect(recommended).toHaveLength(0);
    expect(other).toHaveLength(0);
  });

  it("returns nothing for a null/unknown sport", () => {
    const { recommended, other } = rankRecommendations([], null);
    expect(recommended).toHaveLength(0);
    expect(other).toHaveLength(0);
  });
});

describe("estimateYesProbabilityWithSource", () => {
  it("always resolves to STATIC_PRIOR — no real-odds-driven estimation path exists", () => {
    const estimate = estimateYesProbabilityWithSource("NFL_GAME_TOTAL", {});
    expect(estimate.source).toBe("STATIC_PRIOR");
    expect(estimate.probability).toBe(estimateYesProbability("NFL_GAME_TOTAL", {}));
    expect(estimate.bookmakerCount).toBe(0);
    expect(estimate.resolvedConfig).toBeNull();
  });
});
