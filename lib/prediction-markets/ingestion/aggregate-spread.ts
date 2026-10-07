import { devig2Way } from "./odds-devig";
import type { RawBookmakerOdds } from "@/lib/sports-data/types";

// SPREAD aggregation — the shared (NFL / NBA / NHL puck line / MLB run line) counterpart of aggregateMoneyline / aggregateTotal. A puck line and a
// run line are just SPREAD with a different name; nothing here knows which sport it is.
//
// THE PAIRING CONVENTION, and why it is trusted. API-Sports' "Asian Handicap" bet lists values like `Home -9.5` and `Away -9.5`. Read literally
// that looks like two bets that both give a team a -9.5 handicap. It is not: verified against a real NFL payload (one game, 6 bookmakers), the
// NUMBER is the HOME handicap and the "Away" entry is the OTHER SIDE OF THE SAME LINE (away gets the opposite sign). The evidence:
//   * Betfair: `Home -9.5 @ 1.91` / `Away -9.5 @ 1.91` — a balanced pair, only coherent as the two sides of one line.
//   * Marathon: `Home +2.5 @ 1.16` / `Away +2.5 @ 4.70` while Home is the moneyline favourite at 1.20 — "Away +2.5" priced 4.70 can only be the
//     side that needs the away team to win by 3+, i.e. away -2.5 against the home +2.5 handicap.
//   * Bet365: `Home -1 @ 1.18` / `Away -1 @ 4.36`, against a moneyline of Home 1.18 / Away 5.00 — the same reading.
// The earlier NFL milestone refused to ingest spreads over exactly this ambiguity (a lone `Home -1` priced like the moneyline is not a quote).
// This module resolves it with three guards instead of trusting the labels blindly:
//   1. a line counts only when a bookmaker quotes BOTH the Home and the Away entry for the same number;
//   2. the line used is the one whose consensus is closest to a coin flip, and it must actually be near one (a "main line", not an alternate);
//   3. the line's sign must agree with the moneyline favourite, so an inverted reading can never be ingested silently.
// Failing any guard returns null: no Spread Market is created (we never guess a line or an orientation).

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const HANDICAP_PATTERN = /^(Home|Away)\s+([+-]?\d+(?:\.\d+)?)$/;

/** A main line is priced near even money on both sides; anything further out is an alternate line. */
export const SPREAD_MAIN_LINE_BAND: readonly [number, number] = [0.35, 0.65];
/** A moneyline this lopsided fixes which side must be giving points. Closer than this, the line's sign is not constrained. */
export const SPREAD_FAVOURITE_THRESHOLD = 0.55;

export interface SpreadAggregate {
  /** The HOME team's handicap (e.g. -3.5: home must win by 4+). This is the Market's `line_value` with `yes_side = HOME`. */
  homeLine: number;
  /** Fair probability the HOME team covers `homeLine` — the YES probability for the SPREAD Market. */
  homeCoverProbability: number;
  bookmakerCount: number;
}

/**
 * @param moneylineHomeProbability HOME's fair moneyline win probability (aggregateMoneyline), used only as the orientation cross-check. When it
 *   is unavailable the cross-check cannot run, and the spread is refused — orientation must be verifiable, not assumed.
 */
export function aggregateSpread(bookmakers: RawBookmakerOdds[], minBookmakerCount: number, moneylineHomeProbability: number | null): SpreadAggregate | null {
  if (moneylineHomeProbability === null) return null;

  const byLine = new Map<number, Array<{ homeOdd: number; awayOdd: number }>>();
  for (const bm of bookmakers) {
    const perBook = new Map<number, { homeOdd?: number; awayOdd?: number }>();
    for (const raw of bm.asianHandicap) {
      const match = HANDICAP_PATTERN.exec(raw.value);
      if (!match) continue;
      const line = Number(match[2]);
      const entry = perBook.get(line) ?? {};
      if (match[1] === "Home") entry.homeOdd = raw.odd;
      else entry.awayOdd = raw.odd;
      perBook.set(line, entry);
    }
    for (const [line, { homeOdd, awayOdd }] of perBook) {
      if (homeOdd == null || awayOdd == null) continue;
      const list = byLine.get(line) ?? [];
      list.push({ homeOdd, awayOdd });
      byLine.set(line, list);
    }
  }

  let best: SpreadAggregate | null = null;
  for (const [line, pairs] of byLine) {
    const fair = pairs.map((p) => devig2Way(p.homeOdd, p.awayOdd)).filter((p): p is number => p !== null);
    if (fair.length < minBookmakerCount) continue;
    const probability = median(fair);
    const closer = best === null || Math.abs(probability - 0.5) < Math.abs(best.homeCoverProbability - 0.5) || (Math.abs(probability - 0.5) === Math.abs(best.homeCoverProbability - 0.5) && Math.abs(line) < Math.abs(best.homeLine));
    if (closer) best = { homeLine: line, homeCoverProbability: probability, bookmakerCount: fair.length };
  }
  if (!best) return null;

  if (best.homeCoverProbability < SPREAD_MAIN_LINE_BAND[0] || best.homeCoverProbability > SPREAD_MAIN_LINE_BAND[1]) return null; // only alternate lines were quoted

  // Orientation cross-check against the moneyline: a clear home favourite lays points (negative line), a clear away favourite takes them.
  if (moneylineHomeProbability > SPREAD_FAVOURITE_THRESHOLD && best.homeLine > 0) return null;
  if (moneylineHomeProbability < 1 - SPREAD_FAVOURITE_THRESHOLD && best.homeLine < 0) return null;
  return best;
}
