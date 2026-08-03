/**
 * De-vig (margin removal) — converts raw bookmaker decimal odds into fair
 * probabilities using every side of the market, never `1 - impliedYes`.
 * A bookmaker's raw implied probabilities always sum to slightly more than
 * 1 (the overround/vig); dividing each side's implied probability by that
 * sum distributes the margin proportionally across both sides, which is
 * the standard, principled de-vig method (as opposed to assuming all the
 * margin sits on one side).
 */

/** Fair YES probability from a 2-way market's raw decimal odds, or null if
 * either price is unusable (<= 1, i.e. not a real payable price). */
export function devig2Way(yesOdd: number, noOdd: number): number | null {
  if (!(yesOdd > 1) || !(noOdd > 1)) return null;
  const yesImplied = 1 / yesOdd;
  const noImplied = 1 / noOdd;
  const total = yesImplied + noImplied;
  if (!(total > 0)) return null;
  return yesImplied / total;
}

export interface ThreeWayFairProbabilities {
  home: number;
  draw: number;
  away: number;
}

/** Fair Home/Draw/Away probabilities from a 3-way market's raw decimal
 * odds, or null if any price is unusable. */
export function devig3Way(homeOdd: number, drawOdd: number, awayOdd: number): ThreeWayFairProbabilities | null {
  if (!(homeOdd > 1) || !(drawOdd > 1) || !(awayOdd > 1)) return null;
  const homeImplied = 1 / homeOdd;
  const drawImplied = 1 / drawOdd;
  const awayImplied = 1 / awayOdd;
  const total = homeImplied + drawImplied + awayImplied;
  if (!(total > 0)) return null;
  return { home: homeImplied / total, draw: drawImplied / total, away: awayImplied / total };
}
