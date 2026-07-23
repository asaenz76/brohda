import type { ZodType } from "zod";
import type { PoolTemplate, PoolTemplateCategory } from "./types";
import {
  awayTeamToWin,
  eitherTeamToWin,
  emptyConfigSchema,
  homeTeamToWin,
  teamSideConfigSchema,
  teamToAvoidDefeat,
} from "./match-result";
import {
  bothTeamsToScore,
  cleanSheet,
  firstHalfTotalGoals,
  matchTotalGoals,
  minimumGoalsConfigSchema,
  teamMinimumGoalsConfigSchema,
  teamSideOnlyConfigSchema,
  teamTotalGoals,
  winToNil,
  winningMargin,
  winningMarginConfigSchema,
} from "./goals";
import {
  firstTeamToScore,
  goalAfterMinute,
  goalAfterMinuteConfigSchema,
  ownGoal,
  penaltyAwarded,
  redCard,
  redCardConfigSchema,
} from "./match-events";
import { playerToScore, playerToScoreConfigSchema } from "./player-props";

// Every registry-driven template (Phase 1: match-result + goals; Phase 2:
// match-events + player-props). Adding a template means writing a
// PoolTemplate definition in its category file and listing it here —
// nothing else needs to change to make it show up in the wizard, and
// nothing else needs to change for lib/sports-data/sync.ts to know it
// needs FIXTURE_EVENTS (see EVENT_DEPENDENT_TEMPLATE_IDS below). The 4
// legacy pool_types (WHO_WILL_ADVANCE/REGULATION_RESULT/COMBO/CUSTOM) are
// deliberately NOT in this registry — their grading lives in SQL, not
// gradingRule, so wrapping them here would be misleading.
export const TEMPLATE_REGISTRY: PoolTemplate<Record<string, unknown>>[] = [
  homeTeamToWin,
  awayTeamToWin,
  eitherTeamToWin,
  teamToAvoidDefeat,
  matchTotalGoals,
  bothTeamsToScore,
  teamTotalGoals,
  winningMargin,
  cleanSheet,
  winToNil,
  firstHalfTotalGoals,
  firstTeamToScore,
  redCard,
  penaltyAwarded,
  ownGoal,
  goalAfterMinute,
  playerToScore,
];

// Single source of truth for "which template ids need FIXTURE_EVENTS" —
// lib/sports-data/sync.ts imports this (not the full template objects) to
// decide which fixtures are worth fetching /fixtures/events for, so a
// future template's data-source choice can never silently drift out of
// sync with what the cron actually fetches.
export const EVENT_DEPENDENT_TEMPLATE_IDS: string[] = TEMPLATE_REGISTRY.filter((t) =>
  t.requiredDataSources.includes("FIXTURE_EVENTS"),
).map((t) => t.id);

export function getTemplate(templateId: string): PoolTemplate<Record<string, unknown>> | null {
  return TEMPLATE_REGISTRY.find((t) => t.id === templateId) ?? null;
}

// One Zod schema per template, keyed by id — validated against the
// client-submitted templateConfig once templateId is known (see
// createPoolFromTemplate). Kept here rather than on PoolTemplate itself so
// the interface's gradingRule/questionBuilder stay bivariantly checkable
// (see types.ts's comment) without also needing a generic schema field.
export const TEMPLATE_CONFIG_SCHEMAS: Record<string, ZodType> = {
  HOME_TEAM_TO_WIN: emptyConfigSchema,
  AWAY_TEAM_TO_WIN: emptyConfigSchema,
  EITHER_TEAM_TO_WIN: emptyConfigSchema,
  TEAM_TO_AVOID_DEFEAT: teamSideConfigSchema,
  MATCH_TOTAL_GOALS: minimumGoalsConfigSchema,
  BOTH_TEAMS_TO_SCORE: emptyConfigSchema,
  TEAM_TOTAL_GOALS: teamMinimumGoalsConfigSchema,
  WINNING_MARGIN: winningMarginConfigSchema,
  CLEAN_SHEET: teamSideOnlyConfigSchema,
  WIN_TO_NIL: teamSideOnlyConfigSchema,
  FIRST_HALF_TOTAL_GOALS: minimumGoalsConfigSchema,
  FIRST_TEAM_TO_SCORE: teamSideConfigSchema,
  RED_CARD: redCardConfigSchema,
  PENALTY_AWARDED: emptyConfigSchema,
  OWN_GOAL: emptyConfigSchema,
  GOAL_AFTER_MINUTE: goalAfterMinuteConfigSchema,
  PLAYER_TO_SCORE: playerToScoreConfigSchema,
};

export function listByCategory(): Partial<Record<PoolTemplateCategory, PoolTemplate<Record<string, unknown>>[]>> {
  const grouped: Partial<Record<PoolTemplateCategory, PoolTemplate<Record<string, unknown>>[]>> = {};
  for (const template of TEMPLATE_REGISTRY) {
    (grouped[template.category] ??= []).push(template);
  }
  return grouped;
}
