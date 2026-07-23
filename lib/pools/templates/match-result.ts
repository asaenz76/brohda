import { z } from "zod";
import type { PoolTemplate, TemplateFixtureScore } from "./types";

// Shared by every template below that lets the admin pick which side of
// the fixture the question is about — only 2 valid values since a fixture
// only ever has 2 teams.
export const teamSideSchema = z.enum(["HOME", "AWAY"]);
export type TeamSide = z.infer<typeof teamSideSchema>;

export function teamName(fixture: TemplateFixtureScore, side: TeamSide): string {
  return side === "HOME" ? fixture.homeTeamName : fixture.awayTeamName;
}

function regulationScores(fixture: TemplateFixtureScore, side: TeamSide) {
  const selected = side === "HOME" ? fixture.regulationHomeScore : fixture.regulationAwayScore;
  const opponent = side === "HOME" ? fixture.regulationAwayScore : fixture.regulationHomeScore;
  return { selected, opponent };
}

// Every Phase-1 template reads regulation_home_score/regulation_away_score
// (90 min + stoppage only, never home_score/away_score which include ET/
// penalties) — matches the "exclude extra time and shootouts" rule by
// construction, not by branching on match period inside each rule. `null`
// (even though the fixture is COMPLETED) means the sync hasn't backfilled
// the regulation score yet — never coerced to 0, always PENDING so the
// next cron tick retries instead of mis-grading.
function pendingIfMissing(...values: Array<number | null>): boolean {
  return values.some((v) => v == null);
}

export const emptyConfigSchema = z.object({}).strict();
export type EmptyConfig = z.infer<typeof emptyConfigSchema>;

export const teamSideConfigSchema = z.object({ team: teamSideSchema }).strict();
export type TeamSideConfig = z.infer<typeof teamSideConfigSchema>;

export const homeTeamToWin: PoolTemplate<EmptyConfig> = {
  id: "HOME_TEAM_TO_WIN",
  category: "MATCH_RESULT",
  name: "Home team to win",
  description: "Will the home team win after regulation?",
  questionBuilder: (fixture) => `Will ${fixture.homeTeamName} win after regulation?`,
  requiredConfigFields: [],
  requiredDataSources: ["FIXTURE"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data) => {
    const fixture = data.fixture!;
    if (pendingIfMissing(fixture.regulationHomeScore, fixture.regulationAwayScore)) {
      return {
        result: "PENDING",
        reason: "Regulation score isn't available yet.",
        evidence: [],
      };
    }
    const home = fixture.regulationHomeScore as number;
    const away = fixture.regulationAwayScore as number;
    const yes = home > away;
    return {
      result: yes ? "YES" : "NO",
      reason: yes
        ? `${fixture.homeTeamName} won ${home}-${away} after regulation.`
        : `${fixture.homeTeamName} did not win after regulation (${home}-${away}).`,
      evidence: [
        { source: "FIXTURE", field: "regulation_home_score", rawValue: home, normalizedValue: home },
        { source: "FIXTURE", field: "regulation_away_score", rawValue: away, normalizedValue: away },
      ],
    };
  },
};

export const awayTeamToWin: PoolTemplate<EmptyConfig> = {
  id: "AWAY_TEAM_TO_WIN",
  category: "MATCH_RESULT",
  name: "Away team to win",
  description: "Will the away team win after regulation?",
  questionBuilder: (fixture) => `Will ${fixture.awayTeamName} win after regulation?`,
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
    const yes = away > home;
    return {
      result: yes ? "YES" : "NO",
      reason: yes
        ? `${fixture.awayTeamName} won ${away}-${home} after regulation.`
        : `${fixture.awayTeamName} did not win after regulation (${away}-${home}).`,
      evidence: [
        { source: "FIXTURE", field: "regulation_home_score", rawValue: home, normalizedValue: home },
        { source: "FIXTURE", field: "regulation_away_score", rawValue: away, normalizedValue: away },
      ],
    };
  },
};

export const eitherTeamToWin: PoolTemplate<EmptyConfig> = {
  id: "EITHER_TEAM_TO_WIN",
  category: "MATCH_RESULT",
  name: "Either team to win",
  description: "Will this match have a winner after regulation (not a draw)?",
  questionBuilder: () => "Will this match have a winner after regulation?",
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
    const yes = home !== away;
    return {
      result: yes ? "YES" : "NO",
      reason: yes
        ? `The match had a winner after regulation (${home}-${away}).`
        : `The match was a draw after regulation (${home}-${away}).`,
      evidence: [
        { source: "FIXTURE", field: "regulation_home_score", rawValue: home, normalizedValue: home },
        { source: "FIXTURE", field: "regulation_away_score", rawValue: away, normalizedValue: away },
      ],
    };
  },
};

export const teamToAvoidDefeat: PoolTemplate<TeamSideConfig> = {
  id: "TEAM_TO_AVOID_DEFEAT",
  category: "MATCH_RESULT",
  name: "Team to avoid defeat",
  description: "Will the selected team win or draw after regulation?",
  questionBuilder: (fixture, config) => `Will ${teamName(fixture, config.team)} avoid defeat after regulation?`,
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
    const name = teamName(fixture, config.team);
    const yes = selectedScore >= opponentScore;
    return {
      result: yes ? "YES" : "NO",
      reason: yes
        ? `${name} avoided defeat (${selectedScore}-${opponentScore}).`
        : `${name} lost (${selectedScore}-${opponentScore}).`,
      evidence: [
        { source: "FIXTURE", field: "regulation_score_selected", rawValue: selectedScore, normalizedValue: selectedScore },
        { source: "FIXTURE", field: "regulation_score_opponent", rawValue: opponentScore, normalizedValue: opponentScore },
      ],
    };
  },
};
