import { z } from "zod";
import type { PoolTemplate } from "./types";
import { teamName, type EmptyConfig, type TeamSideConfig } from "./match-result";
import { awardedPenalties, redCardEvents, validGoals } from "./event-helpers";

const MIN_MINUTE = 1;
const MAX_MINUTE = 119;

export const redCardConfigSchema = z.object({ includeSecondYellowDismissal: z.boolean() }).strict();
export type RedCardConfig = z.infer<typeof redCardConfigSchema>;

export const goalAfterMinuteConfigSchema = z
  .object({ minute: z.number().int().min(MIN_MINUTE).max(MAX_MINUTE) })
  .strict();
export type GoalAfterMinuteConfig = z.infer<typeof goalAfterMinuteConfigSchema>;

export const firstTeamToScore: PoolTemplate<TeamSideConfig> = {
  id: "FIRST_TEAM_TO_SCORE",
  category: "GOALS",
  name: "First team to score",
  description: "Will the selected team score the first valid goal of the match?",
  questionBuilder: (fixture, config) => `Will ${teamName(fixture, config.team)} score first?`,
  requiredConfigFields: [{ key: "team", label: "Team", type: "TEAM_SIDE" }],
  requiredDataSources: ["FIXTURE_EVENTS"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const goals = validGoals(data.events ?? []).sort((a, b) => a.effectiveMinute - b.effectiveMinute);
    if (goals.length === 0) {
      return { result: "NO", reason: "The match ended 0-0 — no goal to be first.", evidence: [] };
    }
    const first = goals[0];
    const fixture = data.fixture!;
    const selectedTeamExternalId = config.team === "HOME" ? fixture.homeTeamExternalId : fixture.awayTeamExternalId;
    const name = teamName(fixture, config.team);
    const yes = first.teamExternalId != null && first.teamExternalId === selectedTeamExternalId;
    return {
      result: yes ? "YES" : "NO",
      reason: yes
        ? `${name} scored the first goal (minute ${first.effectiveMinute}).`
        : `The first goal was not scored by ${name} (minute ${first.effectiveMinute}).`,
      evidence: [
        { source: "FIXTURE_EVENTS", field: "first_goal_team_external_id", rawValue: first.teamExternalId, normalizedValue: first.teamExternalId },
      ],
    };
  },
};

export const redCard: PoolTemplate<RedCardConfig> = {
  id: "RED_CARD",
  category: "DISCIPLINE",
  name: "Red card",
  description: "Will there be a red card in the match?",
  questionBuilder: (_fixture, config) =>
    config.includeSecondYellowDismissal
      ? "Will there be a red card? (Second-yellow dismissals count.)"
      : "Will there be a red card? (Direct red cards only.)",
  requiredConfigFields: [
    { key: "includeSecondYellowDismissal", label: "Include second-yellow dismissals", type: "BOOLEAN" },
  ],
  requiredDataSources: ["FIXTURE_EVENTS"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    const reds = redCardEvents(data.events ?? [], config.includeSecondYellowDismissal);
    const yes = reds.length > 0;
    return {
      result: yes ? "YES" : "NO",
      reason: yes ? `${reds.length} red card(s) recorded.` : "No red card recorded.",
      evidence: reds.map((r) => ({ source: "FIXTURE_EVENTS", field: "detail", rawValue: r.detail, normalizedValue: r.detail })),
    };
  },
};

export const penaltyAwarded: PoolTemplate<EmptyConfig> = {
  id: "PENALTY_AWARDED",
  category: "GOALS",
  name: "Penalty awarded",
  description: "Will a penalty be awarded during the match (scored or missed)?",
  questionBuilder: () => "Will a penalty be awarded?",
  requiredConfigFields: [],
  requiredDataSources: ["FIXTURE_EVENTS"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data) => {
    const penalties = awardedPenalties(data.events ?? []);
    const yes = penalties.length > 0;
    return {
      result: yes ? "YES" : "NO",
      reason: yes ? `${penalties.length} penalty/penalties awarded.` : "No penalty awarded.",
      evidence: penalties.map((p) => ({ source: "FIXTURE_EVENTS", field: "detail", rawValue: p.detail, normalizedValue: p.detail })),
    };
  },
};

export const ownGoal: PoolTemplate<EmptyConfig> = {
  id: "OWN_GOAL",
  category: "GOALS",
  name: "Own goal",
  description: "Will there be an own goal during the match?",
  questionBuilder: () => "Will there be an own goal?",
  requiredConfigFields: [],
  requiredDataSources: ["FIXTURE_EVENTS"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data) => {
    const ownGoals = validGoals(data.events ?? []).filter((e) => e.detail === "GOAL_OWN");
    const yes = ownGoals.length > 0;
    return {
      result: yes ? "YES" : "NO",
      reason: yes ? `${ownGoals.length} own goal(s) recorded.` : "No own goal recorded.",
      evidence: ownGoals.map((g) => ({ source: "FIXTURE_EVENTS", field: "player_name", rawValue: g.playerName, normalizedValue: g.playerName })),
    };
  },
};

export const goalAfterMinute: PoolTemplate<GoalAfterMinuteConfig> = {
  id: "GOAL_AFTER_MINUTE",
  category: "GOALS",
  name: "Goal after selected minute",
  description: "Will there be a goal strictly after a chosen minute (stoppage time counts)?",
  questionBuilder: (_fixture, config) => `Will there be a goal after the ${config.minute}th minute?`,
  requiredConfigFields: [{ key: "minute", label: "Minute threshold", type: "INTEGER", min: MIN_MINUTE, max: MAX_MINUTE }],
  requiredDataSources: ["FIXTURE_EVENTS"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    // Strictly after — a goal recorded at exactly `minute` does not count,
    // matching the spec's explicit boundary example (75th minute).
    const goals = validGoals(data.events ?? []).filter((e) => e.effectiveMinute > config.minute);
    const yes = goals.length > 0;
    return {
      result: yes ? "YES" : "NO",
      reason: yes
        ? `A goal was scored at minute ${goals[0].effectiveMinute} (after ${config.minute}).`
        : `No goal after minute ${config.minute}.`,
      evidence: goals.map((g) => ({ source: "FIXTURE_EVENTS", field: "effective_minute", rawValue: g.effectiveMinute, normalizedValue: g.effectiveMinute })),
    };
  },
};
