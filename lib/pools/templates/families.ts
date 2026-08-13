import { TEMPLATE_REGISTRY } from "./registry";

/**
 * A Question Family groups templates (and the 3 legacy pool_types) by what
 * prediction they're fundamentally asking about — independent of
 * PoolTemplateCategory ("market" grouping, DB-persisted as
 * pools.analytics_category and not reusable for this purpose). Two pools
 * from the same family on the same fixture compete for the same liquidity
 * even when their exact wording differs ("Will River Plate win?" and "Will
 * Rosario Central win?" are both MATCH_RESULT).
 */
export type QuestionFamily =
  | "MATCH_RESULT"
  | "GOALS"
  | "TEAM_GOALS"
  | "BOTH_TEAMS"
  | "WINNING_MARGIN"
  | "FIRST_GOAL"
  | "FIRST_HALF"
  | "DISCIPLINE"
  | "PLAYER_SCORING"
  | "COMBO";

export const QUESTION_FAMILY_LABELS: Record<QuestionFamily, string> = {
  MATCH_RESULT: "Match result",
  GOALS: "Goals",
  TEAM_GOALS: "Team goals",
  BOTH_TEAMS: "Both teams to score",
  WINNING_MARGIN: "Winning margin",
  FIRST_GOAL: "First goal",
  FIRST_HALF: "First half",
  DISCIPLINE: "Discipline",
  PLAYER_SCORING: "Player scoring",
  COMBO: "Combo",
};

// Every registry template id, plus the 3 non-registry pool_types
// (WHO_WILL_ADVANCE/REGULATION_RESULT/COMBO), classified by family. A few
// of these are genuine judgment calls where the fixed 10-family vocabulary
// doesn't have a perfect bucket — documented inline rather than silently
// picked:
//   - CLEAN_SHEET/WIN_TO_NIL: both a team-specific goal/clean-sheet prop,
//     not a head-to-head result prediction — grouped with TEAM_GOALS
//     (team-scoped goal question) rather than MATCH_RESULT.
//   - PENALTY_AWARDED/OWN_GOAL/GOAL_AFTER_MINUTE: all fundamentally
//     goal-scoring events without a more specific family in the fixed
//     vocabulary (no EVENT/PENALTY family exists) — grouped under GOALS.
//   - WHO_WILL_ADVANCE/REGULATION_RESULT: legacy, but still genuinely
//     MATCH_RESULT-shaped — a WHO_WILL_ADVANCE pool and a HOME_TEAM_TO_WIN
//     pool on the same fixture are exactly the liquidity-splitting problem
//     this feature exists to catch, so they must share a family.
const TEMPLATE_FAMILY: Record<string, QuestionFamily> = {
  HOME_TEAM_TO_WIN: "MATCH_RESULT",
  AWAY_TEAM_TO_WIN: "MATCH_RESULT",
  EITHER_TEAM_TO_WIN: "MATCH_RESULT",
  TEAM_TO_AVOID_DEFEAT: "MATCH_RESULT",
  MATCH_TOTAL_GOALS: "GOALS",
  BOTH_TEAMS_TO_SCORE: "BOTH_TEAMS",
  TEAM_TOTAL_GOALS: "TEAM_GOALS",
  WINNING_MARGIN: "WINNING_MARGIN",
  CLEAN_SHEET: "TEAM_GOALS",
  WIN_TO_NIL: "TEAM_GOALS",
  FIRST_HALF_TOTAL_GOALS: "FIRST_HALF",
  FIRST_TEAM_TO_SCORE: "FIRST_GOAL",
  RED_CARD: "DISCIPLINE",
  PENALTY_AWARDED: "GOALS",
  OWN_GOAL: "GOALS",
  GOAL_AFTER_MINUTE: "GOALS",
  PLAYER_TO_SCORE: "PLAYER_SCORING",
  WHO_WILL_ADVANCE: "MATCH_RESULT",
  REGULATION_RESULT: "MATCH_RESULT",
  COMBO: "COMBO",
  // NFL_SPREAD asks the identical "win by N+" shape as WINNING_MARGIN —
  // shares its family for the same liquidity-splitting-duplicate reasoning.
  NFL_SPREAD: "WINNING_MARGIN",
  // Combined-score threshold question, same shape as MATCH_TOTAL_GOALS.
  NFL_GAME_TOTAL: "GOALS",
  // Single-team-score threshold question, same shape as TEAM_TOTAL_GOALS.
  NFL_TEAM_TOTAL: "TEAM_GOALS",
};

// Fails fast (at import time, like registry.ts's own duplicate-key guard)
// if a template is ever added to the registry without being classified
// here — "no new templates" holds today, but this keeps the invariant
// enforced for whenever that changes.
const unclassified = TEMPLATE_REGISTRY.map((t) => t.id).filter((id) => !(id in TEMPLATE_FAMILY));
if (unclassified.length > 0) {
  throw new Error(`Templates missing a Question Family in families.ts: ${unclassified.join(", ")}`);
}

export function getQuestionFamily(templateOrPoolTypeId: string): QuestionFamily | null {
  return TEMPLATE_FAMILY[templateOrPoolTypeId] ?? null;
}

// Genuinely distinct ids that ask the identical question from the other
// side — not derivable from config, since HOME_TEAM_TO_WIN/AWAY_TEAM_TO_WIN
// are two separate templates (no `team` config field on either).
const EXPLICIT_MIRROR_PAIRS: ReadonlyArray<readonly [string, string]> = [["HOME_TEAM_TO_WIN", "AWAY_TEAM_TO_WIN"]];

// Templates whose config has a `team` field are inherently side-scoped —
// two pools on the SAME template with opposite `team` values and otherwise
// identical config are mirrors by construction ("Home scores 2+" ↔ "Away
// scores 2+", "Home clean sheet" ↔ "Away clean sheet"). Listed explicitly
// rather than inferred from requiredConfigFields at runtime so this stays a
// simple, auditable set.
export const TEAM_SCOPED_TEMPLATE_IDS = new Set([
  "TEAM_TO_AVOID_DEFEAT",
  "TEAM_TOTAL_GOALS",
  "WINNING_MARGIN",
  "CLEAN_SHEET",
  "WIN_TO_NIL",
  "FIRST_TEAM_TO_SCORE",
  "NFL_SPREAD",
  "NFL_TEAM_TOTAL",
]);

export interface QuestionCandidate {
  templateId: string;
  config: Record<string, unknown>;
}

function configEqualExcludingTeam(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).filter((k) => k !== "team");
  const keysB = Object.keys(b).filter((k) => k !== "team");
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

/** Whether `a` and `b` ask the same underlying question from opposite
 * sides — true mirrors compete for the exact same liquidity, not just the
 * same family. */
export function areMirrors(a: QuestionCandidate, b: QuestionCandidate): boolean {
  const isExplicitPair = EXPLICIT_MIRROR_PAIRS.some(
    ([x, y]) => (a.templateId === x && b.templateId === y) || (a.templateId === y && b.templateId === x),
  );
  if (isExplicitPair) return true;

  if (a.templateId === b.templateId && TEAM_SCOPED_TEMPLATE_IDS.has(a.templateId)) {
    const teamA = a.config.team;
    const teamB = b.config.team;
    if (typeof teamA === "string" && typeof teamB === "string" && teamA !== teamB) {
      return configEqualExcludingTeam(a.config, b.config);
    }
  }

  return false;
}

/** Same template, same config, in full — the literal duplicate case
 * ("Existing equivalent pool"), stricter than areMirrors. */
export function isExactDuplicate(a: QuestionCandidate, b: QuestionCandidate): boolean {
  if (a.templateId !== b.templateId) return false;
  const keysA = Object.keys(a.config);
  const keysB = Object.keys(b.config);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a.config[k] === b.config[k]);
}
