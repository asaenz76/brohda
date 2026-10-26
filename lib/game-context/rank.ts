import { FACT_PRIORITY, isLosingFact, isWinningFact } from "./facts";
import type { GameContextConfig, GameContextFact } from "./types";

// Brohda 2.1 M3 — deterministic choice between candidate facts. No randomness, no clock, no input order dependence: the comparator is a total order.
//
// Tie-break order (documented, tested): 1) score, higher first; 2) fact priority (FACT_PRIORITY), earlier first; 3) side: HOME, then AWAY, then BOTH;
// 4) the id of the most recent supporting Game, ascending — so two facts that tie on everything still resolve identically on every run.

const SIDE_ORDER = { HOME: 0, AWAY: 1, BOTH: 2 } as const;

export function compareFacts(a: GameContextFact, b: GameContextFact): number {
  if (a.score !== b.score) return b.score - a.score;
  const pa = FACT_PRIORITY.indexOf(a.type);
  const pb = FACT_PRIORITY.indexOf(b.type);
  if (pa !== pb) return pa - pb;
  if (a.side !== b.side) return SIDE_ORDER[a.side] - SIDE_ORDER[b.side];
  const ia = a.supportingFixtureIds[0] ?? "";
  const ib = b.supportingFixtureIds[0] ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** What makes two sides' facts worth saying together: opposites ("won 7 straight / lost 5 straight") most, two winning runs meeting second. */
export function contrastBonus(a: GameContextFact, b: GameContextFact): number {
  if ((isWinningFact(a.type) && isLosingFact(b.type)) || (isLosingFact(a.type) && isWinningFact(b.type))) return 10;
  if (isWinningFact(a.type) && isWinningFact(b.type)) return 5;
  return 0;
}

export interface Selection {
  primary: GameContextFact;
  /** The best qualifying fact about the OTHER team, when pairing is on. */
  secondary: GameContextFact | null;
  rank: number;
  qualifying: number;
}

export function selectFacts(candidates: readonly GameContextFact[], config: GameContextConfig): Selection | null {
  const qualifying = candidates.filter((f) => f.score >= config.minScore).sort(compareFacts);
  if (qualifying.length === 0) return null;
  const primary = qualifying[0];
  const secondary = config.pairsEnabled && primary.side !== "BOTH" ? (qualifying.find((f) => f.side !== "BOTH" && f.side !== primary.side) ?? null) : null;
  return { primary, secondary, rank: primary.score + (secondary ? secondary.score + contrastBonus(primary, secondary) : 0), qualifying: qualifying.length };
}
