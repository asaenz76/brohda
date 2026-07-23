import { describe, expect, it } from "vitest";
import { firstTeamToScore, goalAfterMinute, ownGoal, penaltyAwarded, redCard } from "@/lib/pools/templates/match-events";
import { playerToScore } from "@/lib/pools/templates/player-props";
import type { NormalizedFixtureEvent, FixtureEventDetail } from "@/lib/sports-data/types";
import type { TemplateFixtureScore } from "@/lib/pools/templates/types";

function fixture(overrides: Partial<TemplateFixtureScore> = {}): TemplateFixtureScore {
  return {
    homeTeamName: "Home Test FC",
    awayTeamName: "Away Test FC",
    homeTeamExternalId: "1",
    awayTeamExternalId: "2",
    regulationHomeScore: null,
    regulationAwayScore: null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
    ...overrides,
  };
}

function event(overrides: Partial<NormalizedFixtureEvent> & { detail: FixtureEventDetail }): NormalizedFixtureEvent {
  return {
    effectiveMinute: 45,
    teamExternalId: "1",
    playerExternalId: "p1",
    playerName: "Test Player",
    assistPlayerExternalId: null,
    assistPlayerName: null,
    type: "GOAL",
    ...overrides,
  };
}

describe("firstTeamToScore", () => {
  it("YES when the selected team scores the first valid goal", () => {
    const events = [
      event({ effectiveMinute: 23, teamExternalId: "1", detail: "GOAL_NORMAL" }),
      event({ effectiveMinute: 55, teamExternalId: "2", detail: "GOAL_NORMAL" }),
    ];
    const result = firstTeamToScore.gradingRule({ fixture: fixture(), events }, { team: "HOME" });
    expect(result.result).toBe("YES");
  });

  it("NO when the other team scores first", () => {
    const events = [event({ effectiveMinute: 23, teamExternalId: "2", detail: "GOAL_NORMAL" })];
    const result = firstTeamToScore.gradingRule({ fixture: fixture(), events }, { team: "HOME" });
    expect(result.result).toBe("NO");
  });

  it("NO on a scoreless match (0-0)", () => {
    const result = firstTeamToScore.gradingRule({ fixture: fixture(), events: [] }, { team: "HOME" });
    expect(result.result).toBe("NO");
    expect(result.reason).toMatch(/0-0/);
  });

  it("ignores a VAR-cancelled goal when determining who scored first", () => {
    const events = [
      // Cancelled: paired with a same-team, same-minute VAR event.
      event({ effectiveMinute: 10, teamExternalId: "1", detail: "GOAL_NORMAL" }),
      event({ effectiveMinute: 10, teamExternalId: "1", detail: "UNKNOWN", type: "VAR" }),
      event({ effectiveMinute: 30, teamExternalId: "2", detail: "GOAL_NORMAL" }),
    ];
    const result = firstTeamToScore.gradingRule({ fixture: fixture(), events }, { team: "AWAY" });
    expect(result.result).toBe("YES");
  });

  it("excludes a shootout goal (effectiveMinute > 120) from first-goal determination", () => {
    const events = [event({ effectiveMinute: 121, teamExternalId: "1", detail: "GOAL_NORMAL" })];
    const result = firstTeamToScore.gradingRule({ fixture: fixture(), events }, { team: "HOME" });
    expect(result.result).toBe("NO");
  });
});

describe("ownGoal", () => {
  it("YES when an own goal is recorded", () => {
    const events = [event({ detail: "GOAL_OWN" })];
    const result = ownGoal.gradingRule({ fixture: fixture(), events }, {});
    expect(result.result).toBe("YES");
  });

  it("NO when only normal/penalty goals are recorded", () => {
    const events = [event({ detail: "GOAL_NORMAL" }), event({ detail: "GOAL_PENALTY" })];
    const result = ownGoal.gradingRule({ fixture: fixture(), events }, {});
    expect(result.result).toBe("NO");
  });
});

describe("penaltyAwarded", () => {
  it("YES when a penalty is scored", () => {
    const events = [event({ detail: "GOAL_PENALTY" })];
    expect(penaltyAwarded.gradingRule({ fixture: fixture(), events }, {}).result).toBe("YES");
  });

  it("YES when a penalty is missed — awarded still counts even if not scored", () => {
    const events = [event({ detail: "GOAL_PENALTY_MISSED" })];
    expect(penaltyAwarded.gradingRule({ fixture: fixture(), events }, {}).result).toBe("YES");
  });

  it("NO when no penalty was awarded", () => {
    const events = [event({ detail: "GOAL_NORMAL" })];
    expect(penaltyAwarded.gradingRule({ fixture: fixture(), events }, {}).result).toBe("NO");
  });
});

describe("redCard", () => {
  it("YES on a direct red card regardless of config", () => {
    const events = [event({ type: "CARD", detail: "CARD_RED" })];
    expect(redCard.gradingRule({ fixture: fixture(), events }, { includeSecondYellowDismissal: false }).result).toBe(
      "YES",
    );
  });

  it("excludes a second-yellow dismissal when the config says direct-only", () => {
    const events = [event({ type: "CARD", detail: "CARD_SECOND_YELLOW" })];
    const result = redCard.gradingRule({ fixture: fixture(), events }, { includeSecondYellowDismissal: false });
    expect(result.result).toBe("NO");
  });

  it("includes a second-yellow dismissal when the config opts in", () => {
    const events = [event({ type: "CARD", detail: "CARD_SECOND_YELLOW" })];
    const result = redCard.gradingRule({ fixture: fixture(), events }, { includeSecondYellowDismissal: true });
    expect(result.result).toBe("YES");
  });

  it("NO when no red card was recorded", () => {
    const events = [event({ type: "CARD", detail: "CARD_YELLOW" })];
    expect(redCard.gradingRule({ fixture: fixture(), events }, { includeSecondYellowDismissal: true }).result).toBe(
      "NO",
    );
  });
});

describe("goalAfterMinute", () => {
  it("excludes a goal recorded at exactly the boundary minute", () => {
    const events = [event({ effectiveMinute: 75, detail: "GOAL_NORMAL" })];
    const result = goalAfterMinute.gradingRule({ fixture: fixture(), events }, { minute: 75 });
    expect(result.result).toBe("NO");
  });

  it("includes a goal recorded one minute after the boundary", () => {
    const events = [event({ effectiveMinute: 76, detail: "GOAL_NORMAL" })];
    const result = goalAfterMinute.gradingRule({ fixture: fixture(), events }, { minute: 75 });
    expect(result.result).toBe("YES");
  });
});

describe("playerToScore", () => {
  it("YES when the selected player scores a valid goal", () => {
    const events = [event({ playerExternalId: "p1", detail: "GOAL_NORMAL" })];
    const result = playerToScore.gradingRule(
      { fixture: fixture(), events },
      { playerExternalId: "p1", playerName: "Test Player" },
    );
    expect(result.result).toBe("YES");
  });

  it("NO when the player never appears in the events at all (non-participant)", () => {
    const events = [event({ playerExternalId: "someone-else", detail: "GOAL_NORMAL" })];
    const result = playerToScore.gradingRule(
      { fixture: fixture(), events },
      { playerExternalId: "p1", playerName: "Test Player" },
    );
    expect(result.result).toBe("NO");
  });

  it("NO when the player only scores an own goal (own goals don't count for them)", () => {
    const events = [event({ playerExternalId: "p1", detail: "GOAL_OWN" })];
    const result = playerToScore.gradingRule(
      { fixture: fixture(), events },
      { playerExternalId: "p1", playerName: "Test Player" },
    );
    expect(result.result).toBe("NO");
  });
});
