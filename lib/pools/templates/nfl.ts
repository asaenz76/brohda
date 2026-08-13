import { z } from "zod";
import type { PoolTemplate, TemplateFixtureScore } from "./types";
import { teamName, teamSideSchema, type TeamSide } from "./match-result";

// NFL fixtures write their final score (including any overtime — the NFL
// has no separate "extra time" phase the way soccer does) into the same
// regulationHomeScore/regulationAwayScore fields soccer templates read.
// The field names are soccer-era naming on a plain integer pair; nothing
// about TemplateFixtureScore itself is soccer-specific, so these templates
// reuse it unchanged rather than introducing a parallel type.
function pendingIfMissing(...values: Array<number | null>): boolean {
  return values.some((v) => v == null);
}

function regulationScores(fixture: TemplateFixtureScore, side: TeamSide) {
  const selected = side === "HOME" ? fixture.regulationHomeScore : fixture.regulationAwayScore;
  const opponent = side === "HOME" ? fixture.regulationAwayScore : fixture.regulationHomeScore;
  return { selected, opponent };
}

// Product decision: NFL pools are modeled on real sportsbook lines (spread,
// game total, team total), always as a half-point value — never a whole
// number. A half-point line can never exactly equal an integer final-score
// margin/total/team-score, so grading can never land on a push/tie; there
// is deliberately no PUSH outcome in this model. `.5` is exactly
// representable in IEEE-754 floats, so the `% 1 !== 0` check below is
// float-safe (unlike checking multiples of e.g. 0.1).
function halfPointLineSchema(min: number, max: number) {
  return z
    .number()
    .min(min)
    .max(max)
    .multipleOf(0.5)
    .refine((v) => v % 1 !== 0, {
      message: "Line must be a half-point value (e.g. 1.5), not a whole number.",
    });
}

// For any half-point line n+0.5 (n integer), Math.ceil(n+0.5) = n+1, and
// since NFL scores/margins/totals are always integers, value > n+0.5 is
// exactly equivalent to value >= n+1 = Math.ceil(line). questionBuilder
// uses this for the human-facing "N+" wording; gradingRule uses the raw
// `>` comparison against the stored line directly — the two are provably
// consistent, not independently-maintained rounding logic.
function displayThreshold(line: number): number {
  return Math.ceil(line);
}

export const nflSpreadConfigSchema = z
  .object({ team: teamSideSchema, line: halfPointLineSchema(0.5, 27.5) })
  .strict();
export type NflSpreadConfig = z.infer<typeof nflSpreadConfigSchema>;

export const nflGameTotalConfigSchema = z.object({ line: halfPointLineSchema(0.5, 99.5) }).strict();
export type NflGameTotalConfig = z.infer<typeof nflGameTotalConfigSchema>;

export const nflTeamTotalConfigSchema = z
  .object({ team: teamSideSchema, line: halfPointLineSchema(0.5, 69.5) })
  .strict();
export type NflTeamTotalConfig = z.infer<typeof nflTeamTotalConfigSchema>;

// `team` is normalized to the FAVORITE — the admin picks whichever side is
// favored and enters the positive half-point magnitude of the spread (e.g.
// "Packers -1.5" is entered as team: HOME/line: 1.5), so the stored line is
// always positive and the question always reads naturally ("will the
// favorite win by N+"), never in the awkward "win by -1.5" form a raw
// signed spread would produce. Since `team` is TEAM_SIDE (HOME/AWAY), not a
// raw team id, "subject team doesn't belong to this game" is structurally
// impossible rather than something to validate against.
export const nflSpread: PoolTemplate<NflSpreadConfig> = {
  id: "NFL_SPREAD",
  version: 1,
  activeForCreation: true,
  sports: ["american_football"],
  category: "GOALS",
  name: "Spread",
  description: "Will the favorite win by more than the spread?",
  questionBuilder: (fixture, config) =>
    `Will ${teamName(fixture, config.team)} win by ${displayThreshold(config.line)}+ points?`,
  requiredConfigFields: [
    { key: "team", label: "Favorite", type: "TEAM_SIDE" },
    { key: "line", label: "Spread (half-point, e.g. 1.5)", type: "HALF_POINT_LINE", min: 0.5, max: 27.5 },
  ],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    const { selected, opponent } = regulationScores(fixture, config.team);
    if (pendingIfMissing(selected, opponent)) {
      return { result: "PENDING", reason: "Final score isn't available yet.", evidence: [] };
    }
    const selectedScore = selected as number;
    const opponentScore = opponent as number;
    const margin = selectedScore - opponentScore;
    const yes = margin > config.line;
    const name = teamName(fixture, config.team);
    return {
      result: yes ? "YES" : "NO",
      reason: `${name}'s margin: ${margin} (needed >${config.line}). Final score ${selectedScore}-${opponentScore}.`,
      evidence: [
        { source: "FIXTURE", field: "regulation_score_selected", rawValue: selectedScore, normalizedValue: selectedScore },
        { source: "FIXTURE", field: "regulation_score_opponent", rawValue: opponentScore, normalizedValue: opponentScore },
      ],
    };
  },
};

export const nflGameTotal: PoolTemplate<NflGameTotalConfig> = {
  id: "NFL_GAME_TOTAL",
  version: 1,
  activeForCreation: true,
  sports: ["american_football"],
  category: "GOALS",
  name: "Game total",
  description: "Will the combined final score be over the total?",
  questionBuilder: (_fixture, config) => `Will there be ${displayThreshold(config.line)}+ total points scored?`,
  requiredConfigFields: [
    { key: "line", label: "Game total (half-point, e.g. 39.5)", type: "HALF_POINT_LINE", min: 0.5, max: 99.5 },
  ],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    if (pendingIfMissing(fixture.regulationHomeScore, fixture.regulationAwayScore)) {
      return { result: "PENDING", reason: "Final score isn't available yet.", evidence: [] };
    }
    const home = fixture.regulationHomeScore as number;
    const away = fixture.regulationAwayScore as number;
    const total = home + away;
    const yes = total > config.line;
    return {
      result: yes ? "YES" : "NO",
      reason: `Combined final score: ${total} (needed >${config.line}).`,
      evidence: [
        { source: "FIXTURE", field: "regulation_home_score", rawValue: home, normalizedValue: home },
        { source: "FIXTURE", field: "regulation_away_score", rawValue: away, normalizedValue: away },
      ],
    };
  },
};

export const nflTeamTotal: PoolTemplate<NflTeamTotalConfig> = {
  id: "NFL_TEAM_TOTAL",
  version: 1,
  activeForCreation: true,
  sports: ["american_football"],
  category: "GOALS",
  name: "Team total",
  description: "Will the selected team's final score be over their total?",
  questionBuilder: (fixture, config) =>
    `Will ${teamName(fixture, config.team)} score ${displayThreshold(config.line)}+ points?`,
  requiredConfigFields: [
    { key: "team", label: "Team", type: "TEAM_SIDE" },
    { key: "line", label: "Team total (half-point, e.g. 21.5)", type: "HALF_POINT_LINE", min: 0.5, max: 69.5 },
  ],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    const { selected } = regulationScores(fixture, config.team);
    if (pendingIfMissing(selected)) {
      return { result: "PENDING", reason: "Final score isn't available yet.", evidence: [] };
    }
    const selectedScore = selected as number;
    const yes = selectedScore > config.line;
    const name = teamName(fixture, config.team);
    return {
      result: yes ? "YES" : "NO",
      reason: `${name} scored ${selectedScore} (needed >${config.line}).`,
      evidence: [{ source: "FIXTURE", field: "regulation_score_selected", rawValue: selectedScore, normalizedValue: selectedScore }],
    };
  },
};
