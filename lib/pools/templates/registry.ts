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

// Guards against a copy-paste mistake (two entries sharing an id+version)
// silently shadowing each other in getTemplate/getLatestTemplate — thrown at
// module load, not just documented, so it fails immediately rather than
// surfacing as a confusing grading bug later. Exported as a pure function so
// it's directly unit-testable against a synthetic list, not just this real
// registry.
export function findDuplicateTemplateKeys(templates: PoolTemplate<Record<string, unknown>>[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const t of templates) {
    const key = `${t.id}:${t.version}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

const duplicateTemplateKeys = findDuplicateTemplateKeys(TEMPLATE_REGISTRY);
if (duplicateTemplateKeys.length > 0) {
  throw new Error(`Duplicate template (id, version) pairs in TEMPLATE_REGISTRY: ${duplicateTemplateKeys.join(", ")}`);
}

// Single source of truth for "which template ids need FIXTURE_EVENTS" —
// lib/sports-data/sync.ts imports this (not the full template objects) to
// decide which fixtures are worth fetching /fixtures/events for, so a
// future template's data-source choice can never silently drift out of
// sync with what the cron actually fetches.
export const EVENT_DEPENDENT_TEMPLATE_IDS: string[] = TEMPLATE_REGISTRY.filter((t) =>
  t.requiredDataSources.includes("FIXTURE_EVENTS"),
).map((t) => t.id);

// Exact-version resolution — grading (grade.ts) always resolves the exact
// version a pool was created against, even if that version is no longer
// activeForCreation, so a template's later retirement/replacement never
// changes how an already-created pool is graded.
export function getTemplate(templateId: string, version: number): PoolTemplate<Record<string, unknown>> | null {
  return TEMPLATE_REGISTRY.find((t) => t.id === templateId && t.version === version) ?? null;
}

// Creation-time resolution — the highest version among activeForCreation
// entries for this id. Returns null if the id is unknown, or every version
// of it has been retired from creation (still gradable via getTemplate).
export function getLatestTemplate(templateId: string): PoolTemplate<Record<string, unknown>> | null {
  const candidates = TEMPLATE_REGISTRY.filter((t) => t.id === templateId && t.activeForCreation);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, t) => (t.version > latest.version ? t : latest));
}

// One Zod schema per (template id, version) pair — validated against the
// client-submitted templateConfig once templateId is known (see
// createPoolFromTemplate). Kept here rather than on PoolTemplate itself so
// the interface's gradingRule/questionBuilder stay bivariantly checkable
// (see types.ts's comment) without also needing a generic schema field.
// Composite string key (not a nested map) so a duplicate (id, version) pair
// is a plain object-key collision, easy to unit-test for directly.
export const TEMPLATE_CONFIG_SCHEMAS: Record<string, ZodType> = {
  "HOME_TEAM_TO_WIN:1": emptyConfigSchema,
  "AWAY_TEAM_TO_WIN:1": emptyConfigSchema,
  "EITHER_TEAM_TO_WIN:1": emptyConfigSchema,
  "TEAM_TO_AVOID_DEFEAT:1": teamSideConfigSchema,
  "MATCH_TOTAL_GOALS:1": minimumGoalsConfigSchema,
  "BOTH_TEAMS_TO_SCORE:1": emptyConfigSchema,
  "TEAM_TOTAL_GOALS:1": teamMinimumGoalsConfigSchema,
  "WINNING_MARGIN:1": winningMarginConfigSchema,
  "CLEAN_SHEET:1": teamSideOnlyConfigSchema,
  "WIN_TO_NIL:1": teamSideOnlyConfigSchema,
  "FIRST_HALF_TOTAL_GOALS:1": minimumGoalsConfigSchema,
  "FIRST_TEAM_TO_SCORE:1": teamSideConfigSchema,
  "RED_CARD:1": redCardConfigSchema,
  "PENALTY_AWARDED:1": emptyConfigSchema,
  "OWN_GOAL:1": emptyConfigSchema,
  "GOAL_AFTER_MINUTE:1": goalAfterMinuteConfigSchema,
  "PLAYER_TO_SCORE:1": playerToScoreConfigSchema,
};

export function getTemplateConfigSchema(templateId: string, version: number): ZodType | null {
  return TEMPLATE_CONFIG_SCHEMAS[`${templateId}:${version}`] ?? null;
}

export function listByCategory(): Partial<Record<PoolTemplateCategory, PoolTemplate<Record<string, unknown>>[]>> {
  const grouped: Partial<Record<PoolTemplateCategory, PoolTemplate<Record<string, unknown>>[]>> = {};
  for (const template of TEMPLATE_REGISTRY) {
    (grouped[template.category] ??= []).push(template);
  }
  return grouped;
}
