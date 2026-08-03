import { describe, expect, it } from "vitest";
import { TEMPLATE_REGISTRY } from "@/lib/pools/templates/registry";
import { areMirrors, getQuestionFamily, isExactDuplicate } from "@/lib/pools/templates/families";

const LEGACY_AND_COMBO_IDS = ["WHO_WILL_ADVANCE", "REGULATION_RESULT", "COMBO"];

describe("getQuestionFamily", () => {
  it("classifies every registry template and every legacy pool_type", () => {
    for (const id of [...TEMPLATE_REGISTRY.map((t) => t.id), ...LEGACY_AND_COMBO_IDS]) {
      expect(getQuestionFamily(id), `${id} should have a family`).not.toBeNull();
    }
  });

  it("returns null for an unknown id", () => {
    expect(getQuestionFamily("NOT_A_TEMPLATE")).toBeNull();
  });

  it("groups legacy match-result pool_types with the registry match-result templates", () => {
    expect(getQuestionFamily("WHO_WILL_ADVANCE")).toBe("MATCH_RESULT");
    expect(getQuestionFamily("REGULATION_RESULT")).toBe("MATCH_RESULT");
    expect(getQuestionFamily("HOME_TEAM_TO_WIN")).toBe("MATCH_RESULT");
  });
});

describe("areMirrors", () => {
  it("HOME_TEAM_TO_WIN and AWAY_TEAM_TO_WIN are mirrors, in either order", () => {
    const home = { templateId: "HOME_TEAM_TO_WIN", config: {} };
    const away = { templateId: "AWAY_TEAM_TO_WIN", config: {} };
    expect(areMirrors(home, away)).toBe(true);
    expect(areMirrors(away, home)).toBe(true);
  });

  it("two unrelated templates are never mirrors", () => {
    expect(areMirrors({ templateId: "HOME_TEAM_TO_WIN", config: {} }, { templateId: "RED_CARD", config: {} })).toBe(
      false,
    );
  });

  it("a team-scoped template mirrors itself across HOME/AWAY with identical remaining config", () => {
    const homeClean = { templateId: "CLEAN_SHEET", config: { team: "HOME" } };
    const awayClean = { templateId: "CLEAN_SHEET", config: { team: "AWAY" } };
    expect(areMirrors(homeClean, awayClean)).toBe(true);

    const homeScores2 = { templateId: "TEAM_TOTAL_GOALS", config: { team: "HOME", minimumGoals: 2 } };
    const awayScores2 = { templateId: "TEAM_TOTAL_GOALS", config: { team: "AWAY", minimumGoals: 2 } };
    expect(areMirrors(homeScores2, awayScores2)).toBe(true);
  });

  it("does not mirror the same team-scoped template with a different threshold", () => {
    const homeScores2 = { templateId: "TEAM_TOTAL_GOALS", config: { team: "HOME", minimumGoals: 2 } };
    const awayScores3 = { templateId: "TEAM_TOTAL_GOALS", config: { team: "AWAY", minimumGoals: 3 } };
    expect(areMirrors(homeScores2, awayScores3)).toBe(false);
  });

  it("does not mirror the same side of a team-scoped template against itself", () => {
    const homeA = { templateId: "CLEAN_SHEET", config: { team: "HOME" } };
    const homeB = { templateId: "CLEAN_SHEET", config: { team: "HOME" } };
    expect(areMirrors(homeA, homeB)).toBe(false);
  });

  it("a non-team-scoped template never mirrors itself", () => {
    const a = { templateId: "BOTH_TEAMS_TO_SCORE", config: {} };
    const b = { templateId: "BOTH_TEAMS_TO_SCORE", config: {} };
    expect(areMirrors(a, b)).toBe(false);
  });
});

describe("isExactDuplicate", () => {
  it("is true for the same template and identical config", () => {
    const a = { templateId: "MATCH_TOTAL_GOALS", config: { minimumGoals: 3 } };
    const b = { templateId: "MATCH_TOTAL_GOALS", config: { minimumGoals: 3 } };
    expect(isExactDuplicate(a, b)).toBe(true);
  });

  it("is false when config differs", () => {
    const a = { templateId: "MATCH_TOTAL_GOALS", config: { minimumGoals: 3 } };
    const b = { templateId: "MATCH_TOTAL_GOALS", config: { minimumGoals: 4 } };
    expect(isExactDuplicate(a, b)).toBe(false);
  });

  it("is false when the template id differs", () => {
    const a = { templateId: "HOME_TEAM_TO_WIN", config: {} };
    const b = { templateId: "AWAY_TEAM_TO_WIN", config: {} };
    expect(isExactDuplicate(a, b)).toBe(false);
  });
});
