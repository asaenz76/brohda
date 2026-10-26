import { isWinningFact } from "./facts";
import type { FactType, GameContext, GameContextConfig, GameContextFact } from "./types";

// Brohda 2.1 M3 — ALL Game Context wording lives here: fixed templates, no generation. Two rules the templates enforce by construction:
//   * facts only — every number in a sentence comes from a fact's `values`; there is no template for a prediction, a recommendation, a motive, or anything about prices or lines;
//   * the only non-factual words are two connective sentences that restate the structure of the scheduled Game ("<opponent> are trying to stop the streak", "Something has to give").
// Team names are used exactly as stored. Sports team names are plural nouns ("Kansas City Chiefs"), so verbs agree with that: "have", "are", "their".

const dash = "–";

type FactTemplate = (f: GameContextFact) => string;

export const FACT_TEMPLATES: Readonly<Record<FactType, FactTemplate>> = {
  WIN_STREAK: (f) => `${f.subjectTeamName} have won ${f.values.streak} straight.`,
  LOSS_STREAK: (f) => `${f.subjectTeamName} have lost ${f.values.streak} straight.`,
  SEASON_UNBEATEN: (f) => `${f.subjectTeamName} are ${f.values.streak}${dash}0 this season.`,
  SEASON_WINLESS: (f) => `${f.subjectTeamName} are 0${dash}${f.values.streak} this season.`,
  HOME_WIN_STREAK: (f) => `${f.subjectTeamName} have won ${f.values.streak} straight at home.`,
  HOME_LOSS_STREAK: (f) => `${f.subjectTeamName} have lost ${f.values.streak} straight at home.`,
  AWAY_WIN_STREAK: (f) => `${f.subjectTeamName} have won ${f.values.streak} straight on the road.`,
  AWAY_LOSS_STREAK: (f) => `${f.subjectTeamName} have lost ${f.values.streak} straight on the road.`,
  LAST_N: (f) => `${f.subjectTeamName} are ${f.values.wins}${dash}${f.values.losses} in their last ${f.values.sample}.`,
  SERIES_SWEEP: (f) => (f.values.meetings === 2 ? `${f.subjectTeamName} have won both meetings this season.` : `${f.subjectTeamName} have won all ${f.values.meetings} meetings this season.`),
  SERIES_SPLIT: () => "These teams split their first two meetings.",
  SERIES_SINGLE: (f) => `${f.subjectTeamName} beat ${f.opponentTeamName} ${f.values.winnerScore}${dash}${f.values.loserScore} in their first meeting this season.`,
};

export const renderFact = (f: GameContextFact): string => FACT_TEMPLATES[f.type](f);

/** The connective sentence for a line, or null. Only ever a restatement of the Game's structure — never an intent, a feeling or a forecast. */
export function connectiveFor(primary: GameContextFact, secondary: GameContextFact | null): string | null {
  if (secondary) return isWinningFact(primary.type) && isWinningFact(secondary.type) ? "Something has to give." : null;
  if (primary.side === "BOTH" || !isWinningFact(primary.type)) return null;
  return `${primary.opponentTeamName} are trying to stop the streak.`;
}

type Shape = GameContext["metadata"]["shape"];

/**
 * The longest wording that fits `maxChars`, tried in this order: pair + connective, pair, single + connective, single. A sentence is never cut: when the fuller wording is too long
 * the next shorter one is used, and when even the single fact is too long the answer is null (no line).
 */
export function assemble(primary: GameContextFact, secondary: GameContextFact | null, config: Pick<GameContextConfig, "maxChars" | "connectiveEnabled">): { text: string; shape: Shape } | null {
  const connective = config.connectiveEnabled ? connectiveFor(primary, secondary) : null;
  const options: Array<{ parts: string[]; shape: Shape }> = [];
  if (secondary) {
    if (connective) options.push({ parts: [renderFact(primary), renderFact(secondary), connective], shape: "pair+connective" });
    options.push({ parts: [renderFact(primary), renderFact(secondary)], shape: "pair" });
  }
  const singleConnective = config.connectiveEnabled ? connectiveFor(primary, null) : null;
  if (singleConnective) options.push({ parts: [renderFact(primary), singleConnective], shape: "single+connective" });
  options.push({ parts: [renderFact(primary)], shape: "single" });
  for (const o of options) {
    const text = o.parts.join(" ");
    if (text.length <= config.maxChars) return { text, shape: o.shape };
  }
  return null;
}
