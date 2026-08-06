import { z } from "zod";
import type { PoolTemplate, TemplateFixtureScore } from "./types";
import { teamName, teamSideSchema, type EmptyConfig, type TeamSide } from "./match-result";

function pendingIfMissing(...values: Array<number | null>): boolean {
  return values.some((v) => v == null);
}

function regulationScores(fixture: TemplateFixtureScore, side: TeamSide) {
  const selected = side === "HOME" ? fixture.regulationHomeScore : fixture.regulationAwayScore;
  const opponent = side === "HOME" ? fixture.regulationAwayScore : fixture.regulationHomeScore;
  return { selected, opponent };
}

// Bounds chosen generously (a real match rarely needs more than this) —
// just enough to keep an admin from fat-fingering an unreasonable value,
// not a meaningful business rule.
const MIN_GOALS_THRESHOLD = 1;
const MAX_GOALS_THRESHOLD = 15;
const MIN_MARGIN_THRESHOLD = 1;
const MAX_MARGIN_THRESHOLD = 10;

export const minimumGoalsConfigSchema = z
  .object({ minimumGoals: z.number().int().min(MIN_GOALS_THRESHOLD).max(MAX_GOALS_THRESHOLD) })
  .strict();
export type MinimumGoalsConfig = z.infer<typeof minimumGoalsConfigSchema>;

export const teamMinimumGoalsConfigSchema = z
  .object({
    team: teamSideSchema,
    minimumGoals: z.number().int().min(MIN_GOALS_THRESHOLD).max(MAX_GOALS_THRESHOLD),
  })
  .strict();
export type TeamMinimumGoalsConfig = z.infer<typeof teamMinimumGoalsConfigSchema>;

export const winningMarginConfigSchema = z
  .object({
    team: teamSideSchema,
    minimumMargin: z.number().int().min(MIN_MARGIN_THRESHOLD).max(MAX_MARGIN_THRESHOLD),
  })
  .strict();
export type WinningMarginConfig = z.infer<typeof winningMarginConfigSchema>;

export const teamSideOnlyConfigSchema = z.object({ team: teamSideSchema }).strict();
export type TeamSideOnlyConfig = z.infer<typeof teamSideOnlyConfigSchema>;

export const matchTotalGoals: PoolTemplate<MinimumGoalsConfig> = {
  id: "MATCH_TOTAL_GOALS",
  version: 1,
  activeForCreation: true,
  category: "GOALS",
  name: "Match total goals",
  description: "Will there be a set number of goals or more, after regulation?",
  questionBuilder: (_fixture, config) => `Will there be ${config.minimumGoals} or more goals?`,
  requiredConfigFields: [{ key: "minimumGoals", label: "Minimum goals", type: "INTEGER", min: MIN_GOALS_THRESHOLD, max: MAX_GOALS_THRESHOLD }],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    if (pendingIfMissing(fixture.regulationHomeScore, fixture.regulationAwayScore)) {
      return { result: "PENDING", reason: "Regulation score isn't available yet.", evidence: [] };
    }
    const home = fixture.regulationHomeScore as number;
    const away = fixture.regulationAwayScore as number;
    const total = home + away;
    const yes = total >= config.minimumGoals;
    return {
      result: yes ? "YES" : "NO",
      reason: `Total regulation goals: ${total} (needed ${config.minimumGoals}+).`,
      evidence: [
        { source: "FIXTURE", field: "regulation_home_score", rawValue: home, normalizedValue: home },
        { source: "FIXTURE", field: "regulation_away_score", rawValue: away, normalizedValue: away },
      ],
    };
  },
};

export const bothTeamsToScore: PoolTemplate<EmptyConfig> = {
  id: "BOTH_TEAMS_TO_SCORE",
  version: 1,
  activeForCreation: true,
  category: "GOALS",
  name: "Both teams to score",
  description: "Will both teams score at least once after regulation?",
  questionBuilder: () => "Will both teams score?",
  requiredConfigFields: [],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data) => {
    const fixture = data.fixture!;
    if (pendingIfMissing(fixture.regulationHomeScore, fixture.regulationAwayScore)) {
      return { result: "PENDING", reason: "Regulation score isn't available yet.", evidence: [] };
    }
    const home = fixture.regulationHomeScore as number;
    const away = fixture.regulationAwayScore as number;
    const yes = home >= 1 && away >= 1;
    return {
      result: yes ? "YES" : "NO",
      reason: `Regulation score ${home}-${away}.`,
      evidence: [
        { source: "FIXTURE", field: "regulation_home_score", rawValue: home, normalizedValue: home },
        { source: "FIXTURE", field: "regulation_away_score", rawValue: away, normalizedValue: away },
      ],
    };
  },
};

export const teamTotalGoals: PoolTemplate<TeamMinimumGoalsConfig> = {
  id: "TEAM_TOTAL_GOALS",
  version: 1,
  // Retired from creation for launch (fewer, higher-usage templates) —
  // getTemplate(id, version) still resolves this exactly for any pool
  // already created against it, so existing pools keep grading correctly.
  activeForCreation: false,
  category: "GOALS",
  name: "Team total goals",
  description: "Will the selected team score a set number of goals or more?",
  questionBuilder: (fixture, config) =>
    `Will ${teamName(fixture, config.team)} score ${config.minimumGoals} or more goals?`,
  requiredConfigFields: [
    { key: "team", label: "Team", type: "TEAM_SIDE" },
    { key: "minimumGoals", label: "Minimum goals", type: "INTEGER", min: MIN_GOALS_THRESHOLD, max: MAX_GOALS_THRESHOLD },
  ],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    const { selected } = regulationScores(fixture, config.team);
    if (pendingIfMissing(selected)) {
      return { result: "PENDING", reason: "Regulation score isn't available yet.", evidence: [] };
    }
    const selectedScore = selected as number;
    const yes = selectedScore >= config.minimumGoals;
    const name = teamName(fixture, config.team);
    return {
      result: yes ? "YES" : "NO",
      reason: `${name} scored ${selectedScore} (needed ${config.minimumGoals}+).`,
      evidence: [{ source: "FIXTURE", field: "regulation_score_selected", rawValue: selectedScore, normalizedValue: selectedScore }],
    };
  },
};

export const winningMargin: PoolTemplate<WinningMarginConfig> = {
  id: "WINNING_MARGIN",
  version: 1,
  activeForCreation: true,
  category: "GOALS",
  name: "Winning margin",
  description: "Will the selected team win by a set number of goals or more?",
  questionBuilder: (fixture, config) =>
    `Will ${teamName(fixture, config.team)} win by ${config.minimumMargin} or more goals?`,
  requiredConfigFields: [
    { key: "team", label: "Team", type: "TEAM_SIDE" },
    { key: "minimumMargin", label: "Minimum winning margin", type: "INTEGER", min: MIN_MARGIN_THRESHOLD, max: MAX_MARGIN_THRESHOLD },
  ],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    const { selected, opponent } = regulationScores(fixture, config.team);
    if (pendingIfMissing(selected, opponent)) {
      return { result: "PENDING", reason: "Regulation score isn't available yet.", evidence: [] };
    }
    const selectedScore = selected as number;
    const opponentScore = opponent as number;
    const margin = selectedScore - opponentScore;
    const yes = margin >= config.minimumMargin;
    const name = teamName(fixture, config.team);
    return {
      result: yes ? "YES" : "NO",
      reason: `${name}'s winning margin: ${margin} (needed ${config.minimumMargin}+). Final score ${selectedScore}-${opponentScore}.`,
      evidence: [
        { source: "FIXTURE", field: "regulation_score_selected", rawValue: selectedScore, normalizedValue: selectedScore },
        { source: "FIXTURE", field: "regulation_score_opponent", rawValue: opponentScore, normalizedValue: opponentScore },
      ],
    };
  },
};

export const cleanSheet: PoolTemplate<TeamSideOnlyConfig> = {
  id: "CLEAN_SHEET",
  version: 1,
  // Retired from creation for launch — see teamTotalGoals above.
  activeForCreation: false,
  category: "GOALS",
  name: "Clean sheet",
  description: "Will the selected team's opponent fail to score?",
  questionBuilder: (fixture, config) => `Will ${teamName(fixture, config.team)} keep a clean sheet?`,
  requiredConfigFields: [{ key: "team", label: "Team", type: "TEAM_SIDE" }],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    const { opponent } = regulationScores(fixture, config.team);
    if (pendingIfMissing(opponent)) {
      return { result: "PENDING", reason: "Regulation score isn't available yet.", evidence: [] };
    }
    const opponentScore = opponent as number;
    const yes = opponentScore === 0;
    const name = teamName(fixture, config.team);
    return {
      result: yes ? "YES" : "NO",
      reason: yes ? `${name}'s opponent did not score.` : `${name}'s opponent scored ${opponentScore}.`,
      evidence: [{ source: "FIXTURE", field: "regulation_score_opponent", rawValue: opponentScore, normalizedValue: opponentScore }],
    };
  },
};

export const winToNil: PoolTemplate<TeamSideOnlyConfig> = {
  id: "WIN_TO_NIL",
  version: 1,
  // Retired from creation for launch — see teamTotalGoals above.
  activeForCreation: false,
  category: "GOALS",
  name: "Win to nil",
  description: "Will the selected team win without conceding?",
  questionBuilder: (fixture, config) => `Will ${teamName(fixture, config.team)} win without conceding?`,
  requiredConfigFields: [{ key: "team", label: "Team", type: "TEAM_SIDE" }],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    const { selected, opponent } = regulationScores(fixture, config.team);
    if (pendingIfMissing(selected, opponent)) {
      return { result: "PENDING", reason: "Regulation score isn't available yet.", evidence: [] };
    }
    const selectedScore = selected as number;
    const opponentScore = opponent as number;
    const yes = selectedScore > opponentScore && opponentScore === 0;
    const name = teamName(fixture, config.team);
    return {
      result: yes ? "YES" : "NO",
      reason: `${name} ${selectedScore}-${opponentScore}.`,
      evidence: [
        { source: "FIXTURE", field: "regulation_score_selected", rawValue: selectedScore, normalizedValue: selectedScore },
        { source: "FIXTURE", field: "regulation_score_opponent", rawValue: opponentScore, normalizedValue: opponentScore },
      ],
    };
  },
};

export const firstHalfTotalGoals: PoolTemplate<MinimumGoalsConfig> = {
  id: "FIRST_HALF_TOTAL_GOALS",
  version: 1,
  // Retired from creation for launch — see teamTotalGoals above.
  activeForCreation: false,
  category: "GOALS",
  name: "First-half total goals",
  description: "Will there be a set number of goals or more in the first half?",
  questionBuilder: (_fixture, config) => `Will there be ${config.minimumGoals} or more goals in the first half?`,
  requiredConfigFields: [{ key: "minimumGoals", label: "Minimum first-half goals", type: "INTEGER", min: MIN_GOALS_THRESHOLD, max: MAX_GOALS_THRESHOLD }],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const fixture = data.fixture!;
    if (pendingIfMissing(fixture.halftimeHomeScore, fixture.halftimeAwayScore)) {
      return { result: "PENDING", reason: "Half-time score isn't available yet.", evidence: [] };
    }
    const home = fixture.halftimeHomeScore as number;
    const away = fixture.halftimeAwayScore as number;
    const total = home + away;
    const yes = total >= config.minimumGoals;
    return {
      result: yes ? "YES" : "NO",
      reason: `First-half goals: ${total} (needed ${config.minimumGoals}+).`,
      evidence: [
        { source: "FIXTURE", field: "halftime_home_score", rawValue: home, normalizedValue: home },
        { source: "FIXTURE", field: "halftime_away_score", rawValue: away, normalizedValue: away },
      ],
    };
  },
};
