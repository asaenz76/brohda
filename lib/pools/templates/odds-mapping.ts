import type { NormalizedFixtureMarkets, OddsMarket, OddsMarketKey } from "@/lib/sports-data/types";
import { buildConsensus, buildMatchWinnerConsensus, type ConsensusResult, type ProbabilityEstimateSource } from "./odds-consensus";

export type { ProbabilityEstimateSource };

export interface OddsEstimate {
  probability: number;
  source: Exclude<ProbabilityEstimateSource, "STATIC_PRIOR">;
  bookmakerCount: number;
  bookmakerIds: number[];
  marketKey: string;
  line: number | null;
  // Config overrides this estimate implies (e.g. { minimumGoals: 3 } for a
  // threshold market) — merged into the candidate's config by the caller so
  // the generated question reflects the market's own chosen line, not an
  // arbitrary default. Null for non-threshold (single-proposition) markets.
  resolvedConfig: Record<string, unknown> | null;
}

/**
 * Every template id this file can estimate from real odds — a deliberate
 * allowlist, not "every template with some plausible market." Excluded,
 * with reasons:
 *  - PLAYER_TO_SCORE: would need fuzzy name/id matching between our roster
 *    data and the provider's odds player list — real mismatch risk.
 *  - RED_CARD: no clean full-match "any red card" market exists (only a
 *    first-half-only market and a player-level "sent off" market).
 *  - GOAL_AFTER_MINUTE: real markets only offer 6 fixed 15-minute buckets,
 *    not an arbitrary minute threshold — doesn't match this template's
 *    config shape.
 *  - FIRST_TEAM_TO_SCORE / PENALTY_AWARDED: plausible by name, but their
 *    push/void behavior (0-0 matches, no penalty awarded at all) couldn't
 *    be confirmed against a real sample before this was built.
 *  - WINNING_MARGIN: the natural real-odds source (Asian Handicap) has a
 *    value-pairing convention that couldn't be confirmed with confidence
 *    from live data — getting it wrong would silently mislabel a wrong
 *    number as "market consensus" on an admin-facing UI element, so it
 *    was left on the static prior instead of guessed at.
 */
export const ODDS_ALLOWLIST_TEMPLATE_IDS = new Set<string>([
  "HOME_TEAM_TO_WIN",
  "AWAY_TEAM_TO_WIN",
  "EITHER_TEAM_TO_WIN",
  "TEAM_TO_AVOID_DEFEAT",
  "BOTH_TEAMS_TO_SCORE",
  "CLEAN_SHEET",
  "WIN_TO_NIL",
  "OWN_GOAL",
  "MATCH_TOTAL_GOALS",
  "FIRST_HALF_TOTAL_GOALS",
  "TEAM_TOTAL_GOALS",
]);

function findMarket(markets: NormalizedFixtureMarkets, key: OddsMarketKey): OddsMarket | null {
  return markets.markets.find((m) => m.key === key) ?? null;
}

function toEstimate(consensus: ConsensusResult, marketKey: string, line: number | null, resolvedConfig: Record<string, unknown> | null): OddsEstimate {
  return {
    probability: consensus.probability,
    source: consensus.source,
    bookmakerCount: consensus.bookmakerCount,
    bookmakerIds: consensus.bookmakerIds,
    marketKey,
    line,
    resolvedConfig,
  };
}

function estimateSingleProposition(markets: NormalizedFixtureMarkets, key: OddsMarketKey): OddsEstimate | null {
  const line = findMarket(markets, key)?.lines[0];
  if (!line) return null;
  const consensus = buildConsensus(line.propositions);
  return consensus ? toEstimate(consensus, key, null, null) : null;
}

// "The sportsbook chooses the threshold": collects every line the market
// offers, builds a consensus probability per line, and picks whichever
// line's consensus sits closest to 50% — the market's own answer to "what
// threshold makes this close to a coin flip," rather than an arbitrary
// hardcoded default (the old behavior this replaces for allowlisted ids).
function estimateBestThresholdLine(markets: NormalizedFixtureMarkets, key: OddsMarketKey, configKey: string): OddsEstimate | null {
  const market = findMarket(markets, key);
  if (!market) return null;

  let best: { point: number; consensus: ConsensusResult } | null = null;
  for (const line of market.lines) {
    const consensus = buildConsensus(line.propositions);
    if (!consensus) continue;
    if (!best || Math.abs(consensus.probability - 0.5) < Math.abs(best.consensus.probability - 0.5)) {
      best = { point: line.point, consensus };
    }
  }
  if (!best) return null;

  // An "Over 2.5" line means "3 or more" for our integer-threshold
  // templates — ceil() converts the market's half-point line into the
  // template's whole-number "X or more" config value.
  return toEstimate(best.consensus, key, best.point, { [configKey]: Math.ceil(best.point) });
}

function estimateFromMatchWinner(
  templateId: string,
  config: Record<string, unknown>,
  markets: NormalizedFixtureMarkets,
): OddsEstimate | null {
  const consensus = buildMatchWinnerConsensus(markets.matchWinner);
  if (!consensus) return null;

  const base: ConsensusResult = {
    probability: 0,
    source: consensus.source,
    bookmakerCount: consensus.bookmakerCount,
    bookmakerIds: consensus.bookmakerIds,
  };
  const withProbability = (probability: number) => toEstimate({ ...base, probability }, "MATCH_WINNER_3WAY", null, null);

  switch (templateId) {
    case "HOME_TEAM_TO_WIN":
      return withProbability(consensus.home);
    case "AWAY_TEAM_TO_WIN":
      return withProbability(consensus.away);
    case "EITHER_TEAM_TO_WIN":
      return withProbability(1 - consensus.draw);
    case "TEAM_TO_AVOID_DEFEAT":
      // Home avoids defeat = home wins or draws = 1 - P(away wins), and
      // symmetrically for away — derived from the 3-way consensus rather
      // than the Double Chance market, which has its own independent vig
      // and worse bookmaker coverage than Match Winner for no real benefit.
      return withProbability(config.team === "AWAY" ? 1 - consensus.home : 1 - consensus.away);
    default:
      return null;
  }
}

/**
 * Real-odds estimate for one template + config, or null when the template
 * isn't allowlisted, no markets were fetched, or the available market data
 * doesn't clear the consensus bar (see odds-consensus.ts) — callers fall
 * back to the static prior in that case, never to a guess.
 */
export function estimateFromMarkets(
  templateId: string,
  config: Record<string, unknown>,
  markets: NormalizedFixtureMarkets,
): OddsEstimate | null {
  if (!ODDS_ALLOWLIST_TEMPLATE_IDS.has(templateId)) return null;

  switch (templateId) {
    case "HOME_TEAM_TO_WIN":
    case "AWAY_TEAM_TO_WIN":
    case "EITHER_TEAM_TO_WIN":
    case "TEAM_TO_AVOID_DEFEAT":
      return estimateFromMatchWinner(templateId, config, markets);
    case "BOTH_TEAMS_TO_SCORE":
      return estimateSingleProposition(markets, "BOTH_TEAMS_SCORE");
    case "CLEAN_SHEET":
      return estimateSingleProposition(markets, config.team === "AWAY" ? "CLEAN_SHEET_AWAY" : "CLEAN_SHEET_HOME");
    case "WIN_TO_NIL":
      return estimateSingleProposition(markets, config.team === "AWAY" ? "WIN_TO_NIL_AWAY" : "WIN_TO_NIL_HOME");
    case "OWN_GOAL":
      return estimateSingleProposition(markets, "OWN_GOAL");
    case "MATCH_TOTAL_GOALS":
      return estimateBestThresholdLine(markets, "MATCH_TOTAL_GOALS", "minimumGoals");
    case "FIRST_HALF_TOTAL_GOALS":
      return estimateBestThresholdLine(markets, "FIRST_HALF_TOTAL_GOALS", "minimumGoals");
    case "TEAM_TOTAL_GOALS":
      return estimateBestThresholdLine(
        markets,
        config.team === "AWAY" ? "TEAM_TOTAL_GOALS_AWAY" : "TEAM_TOTAL_GOALS_HOME",
        "minimumGoals",
      );
    default:
      return null;
  }
}
