import { ANGLE_TYPES, FALLBACK_ANGLE_TYPES, type AngleBasis, type AngleScores, type AngleSelection, type CandidateFact, type EditorialAngle } from "./providers/types";
import type { GamePreviewClaim, GamePreviewConfig } from "./types";
import { claimedFigures, numbersIn } from "./validation";

/**
 * The editorial gate. A Game Preview is a story hook — "find the most interesting TRUE tension around this matchup and use only the facts that story needs" — not a miniature game-notes page. Two deterministic layers, both unit-tested
 * and neither replaceable by a model's say-so:
 *   1. Angle selection: the candidate stories are well-formed (3-5, real facts, 1-5 scores) and a records-only fallback never beats a story that is good enough.
 *   2. Draft validation: the Preview tells the CHOSEN story with the facts that story needs and no more — no stat dump, no hook that merely states a record, no generic phrases, no sportsbook language, no stock closing question.
 * Judgement the rules cannot make (does the hook stop the scroll, is it specific to this matchup) is the optional model read in the verifier; these rules stay authoritative.
 */

export const overallScore = (s: AngleScores): number => (s.tension + s.surprise + s.specificity + s.humanInterest + s.conversation + s.recency) / 6;

const SCORE_KEYS: Array<keyof AngleScores> = ["tension", "surprise", "specificity", "humanInterest", "conversation", "recency"];

/**
 * Structural clean-up of the candidate stories — the only thing deterministic code should decide about them. An unknown story type is kept as a CONTRAST (the type is an internal label, never shown), a score outside 1-5 is clamped, a fact id the research does not
 * contain is dropped from the story, a story left with no facts is dropped, and a selected id that is not a candidate is replaced by the strongest story. There is no required NUMBER of candidates: the contract asks for the strongest ONE story. Returns the cleaned
 * selection, or a reason when nothing usable remains.
 */
export function sanitizeAngles<T extends Pick<AngleSelection, "angles" | "selectedId">>(selection: T, facts: CandidateFact[]): { selection: T; problems: string[] } {
  const ids = new Set(facts.map((f) => f.id));
  const seen = new Set<string>();
  const cleaned: EditorialAngle[] = [];
  for (const a of selection.angles) {
    if (!a.id || seen.has(a.id) || !a.summary.trim()) continue;
    const factIds = a.factIds.filter((id) => ids.has(id));
    if (factIds.length === 0) continue;
    seen.add(a.id);
    const scores = { ...a.scores };
    for (const k of SCORE_KEYS) scores[k] = Number.isFinite(scores[k]) ? Math.min(5, Math.max(1, scores[k])) : 3;
    cleaned.push({ ...a, factIds, scores, type: (ANGLE_TYPES as readonly string[]).includes(a.type) ? a.type : "CONTRAST" });
  }
  if (cleaned.length === 0) return { selection: { ...selection, angles: [] }, problems: ["The story stage returned no usable story: none had a summary and facts the research contains."] };
  const selectedId = cleaned.some((a) => a.id === selection.selectedId) ? selection.selectedId : [...cleaned].sort((x, y) => overallScore(y.scores) - overallScore(x.scores))[0].id;
  return { selection: { ...selection, angles: cleaned, selectedId }, problems: [] };
}

/**
 * The story line the writer is shown must not carry a figure the angle's facts do not contain (a score named in the summary but missing from its facts is a number the writer will use and the provenance gate must then reject).
 * Facts from the researched pool that contain the missing figures are added to the angle; a figure no fact holds is reported so it is visible in the run record.
 */
export function completeAngleFacts(angle: EditorialAngle, facts: CandidateFact[]): { angle: EditorialAngle; added: string[]; unresolved: string[] } {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const have = new Set<string>();
  for (const id of angle.factIds) {
    const f = byId.get(id);
    if (f) for (const n of numbersIn(`${f.claim} ${f.excerpt ?? ""}`)) have.add(n);
  }
  const missing = [...claimedFigures(angle.summary)].filter((n) => !have.has(n));
  const added: string[] = [];
  const unresolved: string[] = [];
  for (const n of missing) {
    if ([...have].includes(n)) continue; // an added fact already covered it
    const holder = facts.find((f) => !angle.factIds.includes(f.id) && !added.includes(f.id) && numbersIn(`${f.claim} ${f.excerpt ?? ""}`).has(n));
    if (!holder) {
      unresolved.push(n);
      continue;
    }
    added.push(holder.id);
    for (const m of numbersIn(`${holder.claim} ${holder.excerpt ?? ""}`)) have.add(m);
  }
  return { angle: added.length ? { ...angle, factIds: [...angle.factIds, ...added] } : angle, added, unresolved };
}

/**
 * The credited primary source of a story is chosen among ITS OWN facts, not by the order the model happened to list them. The primary must be eligible (trusted, not a betting page); and when the story rests on this season at all, the primary must be a CURRENT-SEASON
 * fact — the Preview credits current reporting, not a last-season article that happens to be listed first. The story's facts are reordered with the primary first; a story with no such fact has no eligible primary and is not publishable (returns null).
 */
export function orderAnglePrimary(angle: EditorialAngle, facts: CandidateFact[], eligible: (fact: CandidateFact) => boolean): EditorialAngle | null {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const own = angle.factIds.map((id) => byId.get(id)).filter((f): f is CandidateFact => Boolean(f));
  const hasCurrent = own.some((f) => f.seasonScope === "CURRENT_SEASON");
  const primary = own.find((f) => eligible(f) && (!hasCurrent || f.seasonScope === "CURRENT_SEASON"));
  if (!primary) return null;
  return primary.id === angle.factIds[0] ? angle : { ...angle, factIds: [primary.id, ...angle.factIds.filter((id) => id !== primary.id)] };
}

/** What an angle rests on: this season only, this season with history behind it, or history alone. */
export function angleBasis(angle: Pick<EditorialAngle, "factIds">, facts: CandidateFact[]): AngleBasis {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const scopes = angle.factIds.map((id) => byId.get(id)?.seasonScope).filter((s): s is NonNullable<typeof s> => Boolean(s));
  const current = scopes.filter((s) => s === "CURRENT_SEASON").length;
  if (current === 0) return "HISTORY_ONLY";
  return current === scopes.length ? "CURRENT_SEASON" : "CURRENT_WITH_HISTORY";
}

/**
 * Genuinely different angles: three phrasings of "Team A has won six straight" are one angle. Different stories rest on different facts and are different kinds of story. A model that proposes two of the same kind (two injury stories for a Game whose news is mostly
 * injuries) has not made the Game unwritable: the stronger of the two is kept and the weaker set aside (recorded), instead of rejecting the run. If the selected angle was the one set aside, its kept twin takes its place.
 */
export function dedupeAngles<T extends Pick<AngleSelection, "angles" | "selectedId">>(selection: T): { selection: T; dropped: Array<{ id: string; keptId: string; reason: string }> } {
  const ranked = [...selection.angles].sort((a, b) => overallScore(b.scores) - overallScore(a.scores));
  const kept: EditorialAngle[] = [];
  const dropped: Array<{ id: string; keptId: string; reason: string }> = [];
  for (const a of ranked) {
    const sameFacts = kept.find((k) => a.factIds.length > 0 && [...a.factIds].sort().join(",") === [...k.factIds].sort().join(","));
    const sameType = kept.find((k) => k.type === a.type);
    const twin = sameFacts ?? sameType;
    if (twin) dropped.push({ id: a.id, keptId: twin.id, reason: sameFacts ? "rests on the same facts as a stronger angle" : `is another ${a.type} story; the stronger one was kept` });
    else kept.push(a);
  }
  const keptIds = new Set(kept.map((k) => k.id));
  const angles = selection.angles.filter((a) => keptIds.has(a.id));
  const selectedId = keptIds.has(selection.selectedId) ? selection.selectedId : (dropped.find((d) => d.id === selection.selectedId)?.keptId ?? selection.selectedId);
  return { selection: { ...selection, angles, selectedId }, dropped };
}

export interface ChosenAngle {
  angle: EditorialAngle;
  /** True when the model chose a records-only fallback although a good-enough story existed, and the choice was changed. */
  overridden: boolean;
  reason: string;
}

/**
 * The angle the writer will tell. Editorial priority: 1) a story on this season's material, 2) this season's story with historical support, 3) a records or history-only fallback. So a records-only angle, or one resting on history alone,
 * is chosen only when no real story with a current-season core reaches the minimum score; otherwise the best such story wins. (History still has its place: it supports and sharpens a current-season story, and carries the Game when the season offers nothing.)
 */
export function chooseAngle(selection: Pick<AngleSelection, "angles" | "selectedId" | "selectionReason">, minStoryScore: number, facts: CandidateFact[]): ChosenAngle {
  const selected = selection.angles.find((a) => a.id === selection.selectedId)!;
  const isFallback = (a: EditorialAngle) => FALLBACK_ANGLE_TYPES.includes(a.type);
  const historyOnly = (a: EditorialAngle) => angleBasis(a, facts) === "HISTORY_ONLY";
  if (isFallback(selected) || historyOnly(selected)) {
    const stories = selection.angles.filter((a) => !isFallback(a) && !historyOnly(a) && overallScore(a.scores) >= minStoryScore).sort((a, b) => overallScore(b.scores) - overallScore(a.scores));
    if (stories.length > 0) {
      const set = isFallback(selected) ? "The records-only angle" : "The history-only angle";
      return { angle: stories[0], overridden: true, reason: `${set} was set aside: "${stories[0].summary}" is built on this season and scored ${overallScore(stories[0].scores).toFixed(1)} (minimum ${minStoryScore}).` };
    }
  }
  return { angle: selected, overridden: false, reason: selection.selectionReason };
}

export interface EditorialInput {
  hook: string;
  preview: string;
  claims: GamePreviewClaim[];
}

export interface EditorialFindings {
  /** The Preview does not rest on the source it credits. */
  blocking: string[];
  /** Guidance only: more facts than one story needs. */
  advisory: string[];
}

/**
 * The few editorial facts code can decide. Taste is the reader's ADVISORY findings, not a regex; meaning (logic, causation, currency) is the reader's BLOCKING findings. Here: the draft must cite the story's primary fact (the Preview credits that source), and citing more facts than the
 * configured guidance is advisory ("the smallest verified set that tells the story").
 */
export function validateEditorial({ draft, angle, config }: { draft: EditorialInput; angle: EditorialAngle; config: Pick<GamePreviewConfig, "maxCitedFacts">; facts?: CandidateFact[]; kickoffUtc?: string }): EditorialFindings {
  const blocking: string[] = [];
  const advisory: string[] = [];
  const cited = new Set(draft.claims.flatMap((c) => c.factIds));
  if (angle.factIds[0] && !cited.has(angle.factIds[0])) blocking.push(`The draft must rest on the story's primary fact (${angle.factIds[0]}) and cite it: the Preview credits that source.`);
  if (cited.size > config.maxCitedFacts) advisory.push(`The draft cites ${cited.size} facts; a Preview tells one story with the smallest set that tells it (guidance: at most ${config.maxCitedFacts}).`);
  return { blocking, advisory };
}
