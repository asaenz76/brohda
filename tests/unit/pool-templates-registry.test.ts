import { describe, expect, it } from "vitest";
import {
  awayTeamToWin,
  eitherTeamToWin,
  homeTeamToWin,
  teamToAvoidDefeat,
} from "@/lib/pools/templates/match-result";
import {
  bothTeamsToScore,
  cleanSheet,
  firstHalfTotalGoals,
  matchTotalGoals,
  teamTotalGoals,
  winToNil,
  winningMargin,
} from "@/lib/pools/templates/goals";
import {
  findDuplicateTemplateKeys,
  getLatestTemplate,
  getTemplate,
  getTemplateConfigSchema,
  listByCategory,
  TEMPLATE_REGISTRY,
} from "@/lib/pools/templates/registry";
import type { PoolTemplate } from "@/lib/pools/templates/types";
import type { TemplateFixtureScore } from "@/lib/pools/templates/types";

function fixture(overrides: Partial<TemplateFixtureScore> = {}): TemplateFixtureScore {
  return {
    homeTeamName: "Real Madrid",
    awayTeamName: "Barcelona",
    homeTeamExternalId: "1",
    awayTeamExternalId: "2",
    regulationHomeScore: null,
    regulationAwayScore: null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
    ...overrides,
  };
}

describe("registry", () => {
  it("has 17 templates (11 Phase-1 + 6 Phase-2)", () => {
    expect(TEMPLATE_REGISTRY).toHaveLength(17);
  });

  it("getTemplate resolves an exact (id, version) pair and returns null otherwise", () => {
    expect(getTemplate("WINNING_MARGIN", 1)?.name).toBe("Winning margin");
    expect(getTemplate("WINNING_MARGIN", 2)).toBeNull();
    expect(getTemplate("NOT_A_TEMPLATE", 1)).toBeNull();
  });

  it("getLatestTemplate resolves the highest activeForCreation version, and null for an unknown id", () => {
    expect(getLatestTemplate("WINNING_MARGIN")?.name).toBe("Winning margin");
    expect(getLatestTemplate("NOT_A_TEMPLATE")).toBeNull();
  });

  it("every registry template is version 1 and activeForCreation today", () => {
    for (const template of TEMPLATE_REGISTRY) {
      expect(template.version).toBe(1);
      expect(template.activeForCreation).toBe(true);
    }
  });

  it("getTemplateConfigSchema resolves by (id, version) and null otherwise", () => {
    expect(getTemplateConfigSchema("WINNING_MARGIN", 1)).toBeTruthy();
    expect(getTemplateConfigSchema("WINNING_MARGIN", 2)).toBeNull();
    expect(getTemplateConfigSchema("NOT_A_TEMPLATE", 1)).toBeNull();
  });

  it("findDuplicateTemplateKeys rejects a duplicate (id, version) pair", () => {
    const base = TEMPLATE_REGISTRY[0] as PoolTemplate<Record<string, unknown>>;
    expect(findDuplicateTemplateKeys(TEMPLATE_REGISTRY)).toEqual([]);
    expect(findDuplicateTemplateKeys([base, { ...base }])).toEqual([`${base.id}:${base.version}`]);
    // A different version of the same id is NOT a duplicate.
    expect(findDuplicateTemplateKeys([base, { ...base, version: base.version + 1 }])).toEqual([]);
  });

  it("listByCategory groups by category", () => {
    const grouped = listByCategory();
    expect(grouped.MATCH_RESULT?.length).toBe(4);
    expect(grouped.GOALS?.length).toBe(11);
    expect(grouped.DISCIPLINE?.length).toBe(1);
    expect(grouped.PLAYER_PROPS?.length).toBe(1);
  });
});

describe("homeTeamToWin", () => {
  it("YES when home wins", () => {
    const result = homeTeamToWin.gradingRule(
      { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 1 }) },
      {},
    );
    expect(result.result).toBe("YES");
  });

  it("NO on a draw", () => {
    const result = homeTeamToWin.gradingRule(
      { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 0 }) },
      {},
    );
    expect(result.result).toBe("NO");
  });

  it("NO when away wins", () => {
    const result = homeTeamToWin.gradingRule(
      { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 2 }) },
      {},
    );
    expect(result.result).toBe("NO");
  });

  it("PENDING when regulation score is missing", () => {
    const result = homeTeamToWin.gradingRule({ fixture: fixture() }, {});
    expect(result.result).toBe("PENDING");
    expect(result.evidence).toEqual([]);
  });

  it("question reads the home team's name", () => {
    expect(homeTeamToWin.questionBuilder(fixture(), {})).toBe(
      "Will Real Madrid win after regulation?",
    );
  });
});

describe("awayTeamToWin", () => {
  it("YES when away wins", () => {
    expect(
      awayTeamToWin.gradingRule({ fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 1 }) }, {})
        .result,
    ).toBe("YES");
  });

  it("NO on a draw", () => {
    expect(
      awayTeamToWin.gradingRule({ fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 1 }) }, {})
        .result,
    ).toBe("NO");
  });
});

describe("eitherTeamToWin", () => {
  it("YES when there's a winner", () => {
    expect(
      eitherTeamToWin.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 1 }) },
        {},
      ).result,
    ).toBe("YES");
  });

  it("NO on 0-0", () => {
    expect(
      eitherTeamToWin.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 0 }) },
        {},
      ).result,
    ).toBe("NO");
  });

  it("NO on any other draw", () => {
    expect(
      eitherTeamToWin.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 2 }) },
        {},
      ).result,
    ).toBe("NO");
  });
});

describe("teamToAvoidDefeat", () => {
  it("YES on a win", () => {
    expect(
      teamToAvoidDefeat.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 0 }) },
        { team: "HOME" },
      ).result,
    ).toBe("YES");
  });

  it("YES on a draw", () => {
    expect(
      teamToAvoidDefeat.gradingRule(
        { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 1 }) },
        { team: "HOME" },
      ).result,
    ).toBe("YES");
  });

  it("NO on a loss", () => {
    expect(
      teamToAvoidDefeat.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 1 }) },
        { team: "HOME" },
      ).result,
    ).toBe("NO");
  });

  it("grades the away side when configured", () => {
    expect(
      teamToAvoidDefeat.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 1 }) },
        { team: "AWAY" },
      ).result,
    ).toBe("NO");
  });
});

describe("matchTotalGoals", () => {
  it("YES at exact threshold", () => {
    expect(
      matchTotalGoals.gradingRule(
        { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 2 }) },
        { minimumGoals: 3 },
      ).result,
    ).toBe("YES");
  });

  it("NO one below threshold", () => {
    expect(
      matchTotalGoals.gradingRule(
        { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 1 }) },
        { minimumGoals: 3 },
      ).result,
    ).toBe("NO");
  });

  it("YES one above threshold", () => {
    expect(
      matchTotalGoals.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 2 }) },
        { minimumGoals: 3 },
      ).result,
    ).toBe("YES");
  });

  it("NO on 0-0", () => {
    expect(
      matchTotalGoals.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 0 }) },
        { minimumGoals: 1 },
      ).result,
    ).toBe("NO");
  });

  it("PENDING when only one score is missing", () => {
    const result = matchTotalGoals.gradingRule(
      { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: null }) },
      { minimumGoals: 2 },
    );
    expect(result.result).toBe("PENDING");
  });

  it("never displays decimal handicap language", () => {
    expect(matchTotalGoals.questionBuilder(fixture(), { minimumGoals: 3 })).toBe(
      "Will there be 3 or more goals?",
    );
  });
});

describe("bothTeamsToScore", () => {
  it("YES when both score", () => {
    expect(
      bothTeamsToScore.gradingRule(
        { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 1 }) },
        {},
      ).result,
    ).toBe("YES");
  });

  it("NO on 0-0", () => {
    expect(
      bothTeamsToScore.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 0 }) },
        {},
      ).result,
    ).toBe("NO");
  });

  it("NO when only one team scores", () => {
    expect(
      bothTeamsToScore.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 0 }) },
        {},
      ).result,
    ).toBe("NO");
  });
});

describe("teamTotalGoals", () => {
  it("YES at exact threshold for the selected team", () => {
    expect(
      teamTotalGoals.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 0 }) },
        { team: "HOME", minimumGoals: 2 },
      ).result,
    ).toBe("YES");
  });

  it("NO one below threshold", () => {
    expect(
      teamTotalGoals.gradingRule(
        { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 0 }) },
        { team: "HOME", minimumGoals: 2 },
      ).result,
    ).toBe("NO");
  });
});

describe("winningMargin", () => {
  it("matches the spec's own worked example: Real Madrid 2-1 Barcelona, margin 2 -> NO", () => {
    const result = winningMargin.gradingRule(
      { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 1 }) },
      { team: "HOME", minimumMargin: 2 },
    );
    expect(result.result).toBe("NO");
  });

  it("YES at exact margin threshold", () => {
    expect(
      winningMargin.gradingRule(
        { fixture: fixture({ regulationHomeScore: 3, regulationAwayScore: 1 }) },
        { team: "HOME", minimumMargin: 2 },
      ).result,
    ).toBe("YES");
  });

  it("NO on a draw", () => {
    expect(
      winningMargin.gradingRule(
        { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 1 }) },
        { team: "HOME", minimumMargin: 1 },
      ).result,
    ).toBe("NO");
  });

  it("NO on a loss", () => {
    expect(
      winningMargin.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 1 }) },
        { team: "HOME", minimumMargin: 1 },
      ).result,
    ).toBe("NO");
  });

  it("question never uses decimal handicap language", () => {
    expect(winningMargin.questionBuilder(fixture(), { team: "HOME", minimumMargin: 2 })).toBe(
      "Will Real Madrid win by 2 or more goals?",
    );
  });
});

describe("cleanSheet", () => {
  it("YES on 0-0 — the selected team doesn't have to win", () => {
    expect(
      cleanSheet.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 0 }) },
        { team: "HOME" },
      ).result,
    ).toBe("YES");
  });

  it("YES on 1-0", () => {
    expect(
      cleanSheet.gradingRule(
        { fixture: fixture({ regulationHomeScore: 1, regulationAwayScore: 0 }) },
        { team: "HOME" },
      ).result,
    ).toBe("YES");
  });

  it("NO on 0-1 when the selected team concedes (and loses)", () => {
    expect(
      cleanSheet.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 1 }) },
        { team: "HOME" },
      ).result,
    ).toBe("NO");
  });
});

describe("winToNil", () => {
  it("YES on a win with a clean sheet", () => {
    expect(
      winToNil.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 0 }) },
        { team: "HOME" },
      ).result,
    ).toBe("YES");
  });

  it("NO on 0-0 — must win, not just avoid conceding (distinct from cleanSheet)", () => {
    expect(
      winToNil.gradingRule(
        { fixture: fixture({ regulationHomeScore: 0, regulationAwayScore: 0 }) },
        { team: "HOME" },
      ).result,
    ).toBe("NO");
  });

  it("NO when conceding even if winning", () => {
    expect(
      winToNil.gradingRule(
        { fixture: fixture({ regulationHomeScore: 2, regulationAwayScore: 1 }) },
        { team: "HOME" },
      ).result,
    ).toBe("NO");
  });
});

describe("firstHalfTotalGoals", () => {
  it("uses halftime score, not full-time score", () => {
    const result = firstHalfTotalGoals.gradingRule(
      {
        fixture: fixture({
          halftimeHomeScore: 1,
          halftimeAwayScore: 0,
          regulationHomeScore: 3,
          regulationAwayScore: 2,
        }),
      },
      { minimumGoals: 1 },
    );
    expect(result.result).toBe("YES");
    expect(result.evidence.some((e) => e.field === "halftime_home_score")).toBe(true);
  });

  it("PENDING when halftime score is missing even if full-time score is present", () => {
    const result = firstHalfTotalGoals.gradingRule(
      { fixture: fixture({ regulationHomeScore: 3, regulationAwayScore: 2 }) },
      { minimumGoals: 1 },
    );
    expect(result.result).toBe("PENDING");
  });

  it("NO below threshold", () => {
    expect(
      firstHalfTotalGoals.gradingRule(
        { fixture: fixture({ halftimeHomeScore: 0, halftimeAwayScore: 0 }) },
        { minimumGoals: 1 },
      ).result,
    ).toBe("NO");
  });
});
