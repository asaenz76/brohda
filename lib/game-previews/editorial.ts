import { ANGLE_TYPES, FALLBACK_ANGLE_TYPES, type AngleScores, type AngleSelection, type CandidateFact, type EditorialAngle } from "./providers/types";
import type { GamePreviewClaim, GamePreviewConfig } from "./types";

/**
 * The editorial gate. A Game Preview is a story hook — "find the most interesting TRUE tension around this matchup and use only the facts that story needs" — not a miniature game-notes page. Two deterministic layers, both unit-tested
 * and neither replaceable by a model's say-so:
 *   1. Angle selection: the candidate stories are well-formed (3-5, real facts, 1-5 scores) and a records-only fallback never beats a story that is good enough.
 *   2. Draft validation: the Preview tells the CHOSEN story with the facts that story needs and no more — no stat dump, no hook that merely states a record, no generic phrases, no sportsbook language, no stock closing question.
 * Judgement the rules cannot make (does the hook stop the scroll, is it specific to this matchup) is the optional model read in the verifier; these rules stay authoritative.
 */

export const overallScore = (s: AngleScores): number => (s.tension + s.surprise + s.specificity + s.humanInterest + s.conversation + s.recency) / 6;

const SCORE_KEYS: Array<keyof AngleScores> = ["tension", "surprise", "specificity", "humanInterest", "conversation", "recency"];

export function validateAngles(selection: Pick<AngleSelection, "angles" | "selectedId">, facts: CandidateFact[]): string[] {
  const problems: string[] = [];
  const ids = new Set(facts.map((f) => f.id));
  const { angles } = selection;
  if (angles.length < 3 || angles.length > 5) problems.push(`Expected 3 to 5 candidate angles, got ${angles.length}.`);
  const seen = new Set<string>();
  for (const a of angles) {
    if (seen.has(a.id)) problems.push(`Angle id "${a.id}" is repeated.`);
    seen.add(a.id);
    if (!(ANGLE_TYPES as readonly string[]).includes(a.type)) problems.push(`Angle "${a.id}" has an unknown type "${a.type}".`);
    if (!a.summary.trim()) problems.push(`Angle "${a.id}" has no summary.`);
    if (a.factIds.length === 0) problems.push(`Angle "${a.id}" uses no facts.`);
    for (const f of a.factIds) if (!ids.has(f)) problems.push(`Angle "${a.id}" cites "${f}", which is not a researched fact.`);
    for (const k of SCORE_KEYS) {
      const v = a.scores[k];
      if (!Number.isFinite(v) || v < 1 || v > 5) problems.push(`Angle "${a.id}" has an invalid ${k} score (${v}).`);
    }
  }
  if (!angles.some((a) => a.id === selection.selectedId)) problems.push(`The selected angle "${selection.selectedId}" is not one of the candidates.`);
  return problems;
}

export interface ChosenAngle {
  angle: EditorialAngle;
  /** True when the model chose a records-only fallback although a good-enough story existed, and the choice was changed. */
  overridden: boolean;
  reason: string;
}

/** The angle the writer will tell. A season-record fallback is chosen only when no real story reaches the minimum score; otherwise the best real story wins. */
export function chooseAngle(selection: Pick<AngleSelection, "angles" | "selectedId" | "selectionReason">, minStoryScore: number): ChosenAngle {
  const selected = selection.angles.find((a) => a.id === selection.selectedId)!;
  const isFallback = (a: EditorialAngle) => FALLBACK_ANGLE_TYPES.includes(a.type);
  if (isFallback(selected)) {
    const stories = selection.angles.filter((a) => !isFallback(a) && overallScore(a.scores) >= minStoryScore).sort((a, b) => overallScore(b.scores) - overallScore(a.scores));
    if (stories.length > 0) {
      return { angle: stories[0], overridden: true, reason: `The records-only angle was set aside: "${stories[0].summary}" scored ${overallScore(stories[0].scores).toFixed(1)} (minimum ${minStoryScore}).` };
    }
  }
  return { angle: selected, overridden: false, reason: selection.selectionReason };
}

/** Phrases that mark filler: a Preview that could be about any two teams. */
const GENERIC_PHRASES = [
  /looking for a win/i,
  /exciting (matchup|game|contest)/i,
  /(should|promises to) be (a )?(great|exciting|good|thrilling) (game|matchup|one)/i,
  /both teams (are|will|look|hope|need)/i,
  /clash of (the )?titans/i,
  /battle (of|between)/i,
  /(fans|everyone) can('t| cannot) wait/i,
  /in (a|this) (highly )?anticipated/i,
];

/** Sportsbook vocabulary does not belong in a Preview (a Pick is not a bet). */
const BETTING_WORDS = /\b(odds|moneyline|point spread|parlay|wager|bets?|betting|sportsbook|favorites?|underdogs?|over\/under)\b/i;

/** A stock question tacked on the end of every Preview becomes repetitive AI copy. */
const STOCK_QUESTION = /\b(who will win|who wins|who takes it|who comes out on top|can they do it|will they win)\?\s*$/i;

const RECORD_IN_HOOK = /\b\d{1,3}\s?[-–]\s?\d{1,3}(\s?[-–]\s?\d{1,3})?\b/;

export interface EditorialInput {
  hook: string;
  preview: string;
  claims: GamePreviewClaim[];
}

/** Rejects a draft that is not a story: returns the reasons, fed back to the writer for a rewrite. */
export function validateEditorial({ draft, angle, config }: { draft: EditorialInput; angle: EditorialAngle; config: Pick<GamePreviewConfig, "maxCitedFacts"> }): string[] {
  const problems: string[] = [];
  const hook = draft.hook.trim();
  const preview = draft.preview.trim();
  const cited = new Set(draft.claims.flatMap((c) => c.factIds));

  const outside = [...cited].filter((id) => !angle.factIds.includes(id));
  if (outside.length > 0) problems.push(`The draft uses facts outside the chosen story (${outside.join(", ")}). Tell ONE story with the facts it needs.`);
  if (cited.size > config.maxCitedFacts) problems.push(`The draft cites ${cited.size} facts; a Preview tells one story with at most ${config.maxCitedFacts}. Cut the ones that do not strengthen it.`);

  if (RECORD_IN_HOOK.test(hook)) problems.push("The hook just states a record or score. Lead with the tension, not the number.");
  if ((hook.match(/\d+/g) ?? []).length >= 2) problems.push("The hook is made of figures. A hook should read like sports conversation, not metadata.");

  const figures = (preview.match(/\d+(?:[.,]\d+)?/g) ?? []).length;
  if (figures > config.maxCitedFacts * 3) problems.push(`The preview carries ${figures} figures, which reads as a list of statistics. Keep only the numbers the story needs.`);

  for (const re of GENERIC_PHRASES) if (re.test(hook) || re.test(preview)) problems.push(`Generic phrasing ("${(hook + " " + preview).match(re)![0]}") could describe any matchup. Say the specific thing.`);
  if (BETTING_WORDS.test(hook) || BETTING_WORDS.test(preview)) problems.push("Sportsbook language does not belong in a Preview.");
  if (STOCK_QUESTION.test(preview)) problems.push("The closing stock question is filler. Use a question only if it sharpens this story's tension, or end on the implication.");
  if (hook.toLowerCase() === preview.slice(0, hook.length).toLowerCase()) problems.push("The preview just repeats the hook.");
  return problems;
}
