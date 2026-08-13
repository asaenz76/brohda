import type { NflBookmakerOdds, NormalizedNflFixtureOdds } from "@/lib/sports-data/types";
import { devig2Way } from "./odds-devig";
import type { TeamSide } from "./match-result";

/**
 * Backs the pool-creation wizard's real-line prefill for NFL_SPREAD/
 * NFL_GAME_TOTAL/NFL_TEAM_TOTAL (lib/actions/odds.ts's
 * getNflFixtureLinesAction). Two different confidence tiers on purpose:
 *
 *  - favorite/gameTotal/homeTeamTotal/awayTeamTotal are derived from
 *    unambiguous markets (moneyline; plain Over/Under) — safe to present
 *    as a confident prefill.
 *  - spread is NOT: API-NFL's Asian Handicap value-pairing convention
 *    could not be confirmed with confidence from live data (see
 *    estimateSpreadMagnitude below for the full analysis) — the exact
 *    same risk class the codebase already flagged and deliberately
 *    avoided for football's WINNING_MARGIN (see odds-mapping.ts's
 *    ODDS_ALLOWLIST_TEMPLATE_IDS comment). Callers MUST present this
 *    value as a best-effort estimate needing manual verification, never
 *    with the same confidence as the other three fields.
 *
 * Deliberately does NOT reuse odds-consensus.ts's buildConsensus: that
 * helper's REPUTABLE_BOOKMAKER_IDS is a hand-curated allowlist of
 * API-FOOTBALL bookmaker ids/names (id 4 = Pinnacle, id 7 = William
 * Hill, ...). API-NFL is a separate API-Sports product with its own,
 * independently-numbered bookmaker catalog (confirmed live: id 7 there
 * is Pinnacle, id 4 is Bet365 — nothing like football's numbering).
 * Reusing that allowlist as-is would silently filter NFL bookmakers
 * under the wrong identity assumptions. No equivalent curated "reputable
 * NFL bookmakers" list has been researched, so every bookmaker the
 * provider returns is treated as eligible here — median aggregation
 * (same robustness principle as buildConsensus) guards against any one
 * outlier book, without requiring a football-specific allowlist.
 */

const MIN_BOOKS_FOR_ESTIMATE = 2;

export interface NflFavoriteEstimate {
  team: TeamSide;
  probability: number; // the favorite's own win probability, always >= 0.5
  bookmakerCount: number;
}

export interface NflLineEstimate {
  line: number; // half-point, already rounded per the spec's "round up to the next half-point" rule
  bookmakerCount: number;
}

export interface NflFixtureLineEstimates {
  favorite: NflFavoriteEstimate | null;
  spread: NflLineEstimate | null; // UNCONFIRMED — see file header
  gameTotal: NflLineEstimate | null;
  homeTeamTotal: NflLineEstimate | null;
  awayTeamTotal: NflLineEstimate | null;
}

// A half-point line can never be a whole number (see nfl.ts's
// halfPointLineSchema) — raw market data sometimes offers whole-number
// points ("Over 37", "-1"), so every estimate here is rounded UP to the
// nearest valid half-point before being handed to a caller, matching the
// product spec's explicit example ("39ov-107, 39un-103 -> 39.5"). Handles
// non-half-point fractional inputs too (e.g. a median landing on 2.25),
// not just whole numbers.
function roundUpToHalfPoint(n: number): number {
  const nextHalf = Math.ceil(n * 2) / 2;
  return Number.isInteger(nextHalf) ? nextHalf + 0.5 : nextHalf;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface LocalConsensus {
  probability: number;
  bookmakerCount: number;
}

// Local stand-in for odds-consensus.ts's buildConsensus, minus the
// football-specific bookmaker allowlist (see the file header for why) —
// every bookmaker offering a usable price is included, de-vigged
// individually, then aggregated by median for robustness to outliers.
function localConsensus(pairs: Array<{ yesOdd: number; noOdd: number }>): LocalConsensus | null {
  const fair = pairs.map((p) => devig2Way(p.yesOdd, p.noOdd)).filter((p): p is number => p !== null);
  if (fair.length < MIN_BOOKS_FOR_ESTIMATE) return null;
  return { probability: median(fair), bookmakerCount: fair.length };
}

/**
 * Favorite team via the moneyline market — completely unambiguous (lower
 * odds = more likely to win, standard 2-way pricing).
 */
function estimateFavorite(bookmakers: NflBookmakerOdds[]): NflFavoriteEstimate | null {
  const pairs: Array<{ yesOdd: number; noOdd: number }> = [];
  for (const bm of bookmakers) {
    const home = bm.moneyline.find((v) => v.value === "Home");
    const away = bm.moneyline.find((v) => v.value === "Away");
    if (!home || !away) continue;
    pairs.push({ yesOdd: home.odd, noOdd: away.odd });
  }
  const consensus = localConsensus(pairs);
  if (!consensus) return null;

  const team: TeamSide = consensus.probability >= 0.5 ? "HOME" : "AWAY";
  const probability = team === "HOME" ? consensus.probability : 1 - consensus.probability;
  return { team, probability, bookmakerCount: consensus.bookmakerCount };
}

const OVER_UNDER_PATTERN = /^(Over|Under)\s+(-?\d+(?:\.\d+)?)$/;

/**
 * Consensus-picked Over/Under line for a plain two-way threshold market
 * (game total, or one team's total) — same "closest to a 50/50 coin flip"
 * heuristic as football's estimateBestThresholdLine in odds-mapping.ts,
 * reimplemented locally since NFL's raw value shape ("Over 37.5") isn't
 * the pre-normalized OddsMarketLine[] that helper expects.
 */
function estimateBestOverUnderLine(bookmakers: NflBookmakerOdds[], pick: (bm: NflBookmakerOdds) => NflBookmakerOdds["gameTotal"]): NflLineEstimate | null {
  const byPoint = new Map<number, Array<{ yesOdd: number; noOdd: number }>>();
  for (const bm of bookmakers) {
    const byPointForBm = new Map<number, { overOdd?: number; underOdd?: number }>();
    for (const raw of pick(bm)) {
      const match = OVER_UNDER_PATTERN.exec(raw.value);
      if (!match) continue;
      const point = Number(match[2]);
      const entry = byPointForBm.get(point) ?? {};
      if (match[1] === "Over") entry.overOdd = raw.odd;
      else entry.underOdd = raw.odd;
      byPointForBm.set(point, entry);
    }
    for (const [point, { overOdd, underOdd }] of byPointForBm) {
      if (overOdd == null || underOdd == null) continue;
      const list = byPoint.get(point) ?? [];
      list.push({ yesOdd: overOdd, noOdd: underOdd });
      byPoint.set(point, list);
    }
  }

  let best: { point: number; probability: number; bookmakerCount: number } | null = null;
  for (const [point, pairs] of byPoint) {
    const consensus = localConsensus(pairs);
    if (!consensus) continue;
    if (!best || Math.abs(consensus.probability - 0.5) < Math.abs(best.probability - 0.5)) {
      best = { point, probability: consensus.probability, bookmakerCount: consensus.bookmakerCount };
    }
  }
  if (!best) return null;
  return { line: roundUpToHalfPoint(best.point), bookmakerCount: best.bookmakerCount };
}

const ASIAN_HANDICAP_PATTERN = /^(Home|Away)\s+(-?\d+(?:\.\d+)?)$/;

/**
 * Best-effort spread magnitude — UNCONFIRMED, see this file's header.
 *
 * Previously took each bookmaker's SMALLEST offered "-X" magnitude for the
 * favorite, on the theory that an alt-lines menu builds outward from the
 * true closing number, so the smallest is the closest proxy for it. A real
 * production case (NFL, Jets @ Buccaneers, 8/14/2026) disproved that: the
 * smallest-magnitude estimate came back 1.5 while the real sportsbook line
 * was 6 — the offered alt-lines menu didn't start anywhere near the true
 * number for that game.
 *
 * Now mirrors estimateBestOverUnderLine's approach instead: at each
 * magnitude the favorite is offered a "-X" line at, pair it with the
 * underdog's own "-X" entry at the same magnitude (the pairing convention
 * established below — both sides listed with the same sign, disambiguated
 * only by which one is unambiguously the moneyline favorite), de-vig both
 * sides, and pick the magnitude whose fair probability lands closest to a
 * 50/50 split, same principle totals already uses: a sportsbook prices its
 * true closing number closest to even money on both sides, and alternate
 * (bought-up/bought-down) lines away from it get correspondingly skewed
 * odds. Requires at least MIN_BOOKS_FOR_ESTIMATE bookmakers quoting a given
 * magnitude before it's eligible at all (same guard every other estimate
 * here uses), so a single stale/outlier quote can't win outright.
 *
 * What IS safe on its own: the moneyline-determined favorite label
 * ("Home"/"Away") — this function only ever reads the favorite's own "-X"
 * entries paired against the underdog's "-X" at the same magnitude,
 * ignoring "+X" entries entirely, exactly as before.
 *
 * Still a heuristic, still unconfirmed — callers must flag it as such. A
 * thinly-quoted-but-fair-looking magnitude can still outrank a heavily-
 * quoted-but-slightly-skewed one; that's the same tradeoff totals
 * estimation already accepts, not a new risk this introduces.
 */
function estimateSpreadMagnitude(bookmakers: NflBookmakerOdds[], favoriteTeam: TeamSide): NflLineEstimate | null {
  const favoriteLabel = favoriteTeam === "HOME" ? "Home" : "Away";
  const underdogLabel = favoriteTeam === "HOME" ? "Away" : "Home";
  const byMagnitude = new Map<number, Array<{ yesOdd: number; noOdd: number }>>();

  for (const bm of bookmakers) {
    const byMagnitudeForBm = new Map<number, { favoriteOdd?: number; underdogOdd?: number }>();
    for (const raw of bm.asianHandicap) {
      const match = ASIAN_HANDICAP_PATTERN.exec(raw.value);
      if (!match) continue;
      // The capture group includes the sign (e.g. "-3.5"), so a real "-X"
      // entry parses as a NEGATIVE number here — only those count as "this
      // team is favored by X" lines. "+0"/"+1.5" entries parse as
      // non-negative (or fail to match at all, since the regex has no "+"
      // branch) and are excluded either way.
      const signed = Number(match[2]);
      if (!(signed < 0)) continue;
      const magnitude = -signed;
      const entry = byMagnitudeForBm.get(magnitude) ?? {};
      if (match[1] === favoriteLabel) entry.favoriteOdd = raw.odd;
      else if (match[1] === underdogLabel) entry.underdogOdd = raw.odd;
      byMagnitudeForBm.set(magnitude, entry);
    }
    for (const [magnitude, { favoriteOdd, underdogOdd }] of byMagnitudeForBm) {
      if (favoriteOdd == null || underdogOdd == null) continue;
      const list = byMagnitude.get(magnitude) ?? [];
      list.push({ yesOdd: favoriteOdd, noOdd: underdogOdd });
      byMagnitude.set(magnitude, list);
    }
  }

  let best: { magnitude: number; probability: number; bookmakerCount: number } | null = null;
  for (const [magnitude, pairs] of byMagnitude) {
    const consensus = localConsensus(pairs);
    if (!consensus) continue;
    if (!best || Math.abs(consensus.probability - 0.5) < Math.abs(best.probability - 0.5)) {
      best = { magnitude, probability: consensus.probability, bookmakerCount: consensus.bookmakerCount };
    }
  }
  if (!best) return null;
  return { line: roundUpToHalfPoint(best.magnitude), bookmakerCount: best.bookmakerCount };
}

export function estimateNflFixtureLines(odds: NormalizedNflFixtureOdds): NflFixtureLineEstimates {
  const favorite = estimateFavorite(odds.bookmakers);
  return {
    favorite,
    spread: favorite ? estimateSpreadMagnitude(odds.bookmakers, favorite.team) : null,
    gameTotal: estimateBestOverUnderLine(odds.bookmakers, (bm) => bm.gameTotal),
    homeTeamTotal: estimateBestOverUnderLine(odds.bookmakers, (bm) => bm.homeTeamTotal),
    awayTeamTotal: estimateBestOverUnderLine(odds.bookmakers, (bm) => bm.awayTeamTotal),
  };
}
