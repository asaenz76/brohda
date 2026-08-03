import type { MatchWinnerLine, OddsProposition } from "@/lib/sports-data/types";
import { devig2Way, devig3Way } from "./odds-devig";

/**
 * Bookmaker consensus — estimates the *market's* opinion, not one
 * bookmaker's. Every qualifying bookmaker's price is de-vigged
 * independently, then aggregated by median (robust to one outlier price;
 * preferred over mean per the product decision behind this file). Only
 * falls back to a single bookmaker when too few qualify for a real
 * consensus.
 *
 * Bookmaker ids below are real, confirmed live against /odds/bookmakers —
 * a hand-picked allowlist of large, liquid books (not every id API-
 * Football returns; smaller/regional books are excluded rather than
 * silently diluting the consensus with thin, unreliable pricing).
 */
const REPUTABLE_BOOKMAKER_IDS = new Set<number>([
  4, // Pinnacle
  8, // Bet365
  7, // William Hill
  1, // 10Bet
  3, // Betfair
  16, // Unibet
  2, // Marathonbet
  11, // 1xBet
  32, // Betano
  24, // Betway
  36, // BetVictor
  10, // Ladbrokes
]);

// Order to prefer among available books when there aren't enough for a
// real median consensus — sharper/more liquid books first.
const TRUSTED_FALLBACK_ORDER: readonly number[] = [4, 8, 7, 1, 3, 16, 2, 11, 32, 24, 36, 10];

const MIN_BOOKS_FOR_CONSENSUS = 3;

export type ProbabilityEstimateSource = "MARKET_CONSENSUS" | "SINGLE_BOOKMAKER" | "STATIC_PRIOR";

export interface ConsensusResult {
  probability: number;
  source: Extract<ProbabilityEstimateSource, "MARKET_CONSENSUS" | "SINGLE_BOOKMAKER">;
  bookmakerCount: number;
  bookmakerIds: number[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Consensus fair YES probability for a single 2-way proposition (one
 * line of one market), across every reputable bookmaker offering it. */
export function buildConsensus(propositions: OddsProposition[]): ConsensusResult | null {
  const fair = propositions
    .filter((p) => REPUTABLE_BOOKMAKER_IDS.has(p.bookmakerId))
    .map((p) => ({ bookmakerId: p.bookmakerId, fair: devig2Way(p.yesOdd, p.noOdd) }))
    .filter((p): p is { bookmakerId: number; fair: number } => p.fair !== null);

  if (fair.length >= MIN_BOOKS_FOR_CONSENSUS) {
    return {
      probability: median(fair.map((f) => f.fair)),
      source: "MARKET_CONSENSUS",
      bookmakerCount: fair.length,
      bookmakerIds: fair.map((f) => f.bookmakerId),
    };
  }

  if (fair.length >= 1) {
    const best =
      TRUSTED_FALLBACK_ORDER.map((id) => fair.find((f) => f.bookmakerId === id)).find((f) => f != null) ?? fair[0];
    return { probability: best.fair, source: "SINGLE_BOOKMAKER", bookmakerCount: 1, bookmakerIds: [best.bookmakerId] };
  }

  return null;
}

export interface MatchWinnerConsensus {
  home: number;
  draw: number;
  away: number;
  source: Extract<ProbabilityEstimateSource, "MARKET_CONSENSUS" | "SINGLE_BOOKMAKER">;
  bookmakerCount: number;
  bookmakerIds: number[];
}

/** Same consensus philosophy as buildConsensus, applied to the 3-way match
 * winner market: each qualifying bookmaker's 3-way price is de-vigged
 * independently, then home/draw/away are each medianed across bookmakers
 * separately and renormalized to sum to exactly 1 (medianing each outcome
 * independently can drift slightly off 1; renormalizing keeps the result a
 * valid probability distribution without changing the relative shape). */
export function buildMatchWinnerConsensus(lines: MatchWinnerLine[]): MatchWinnerConsensus | null {
  const fair = lines
    .filter((l) => REPUTABLE_BOOKMAKER_IDS.has(l.bookmakerId))
    .map((l) => ({ bookmakerId: l.bookmakerId, fair: devig3Way(l.homeOdd, l.drawOdd, l.awayOdd) }))
    .filter((l): l is { bookmakerId: number; fair: NonNullable<ReturnType<typeof devig3Way>> } => l.fair !== null);

  if (fair.length === 0) return null;

  const build = (
    home: number,
    draw: number,
    away: number,
    source: ConsensusResult["source"],
    bookmakerIds: number[],
  ): MatchWinnerConsensus => {
    const total = home + draw + away;
    return { home: home / total, draw: draw / total, away: away / total, source, bookmakerCount: bookmakerIds.length, bookmakerIds };
  };

  if (fair.length >= MIN_BOOKS_FOR_CONSENSUS) {
    return build(
      median(fair.map((f) => f.fair.home)),
      median(fair.map((f) => f.fair.draw)),
      median(fair.map((f) => f.fair.away)),
      "MARKET_CONSENSUS",
      fair.map((f) => f.bookmakerId),
    );
  }

  const best = TRUSTED_FALLBACK_ORDER.map((id) => fair.find((f) => f.bookmakerId === id)).find((f) => f != null) ?? fair[0];
  return build(best.fair.home, best.fair.draw, best.fair.away, "SINGLE_BOOKMAKER", [best.bookmakerId]);
}
