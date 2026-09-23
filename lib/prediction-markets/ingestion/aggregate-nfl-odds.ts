// Milestone R2 (docs/BROHDA_2_0_MILESTONE_MAP.md, Sports Market Ingestion):
// pure multi-bookmaker aggregation for the two NFL Market templates R2
// ingests automatically (MONEYLINE, TOTAL — see the R2 completion report
// for why SPREAD is deliberately excluded). Reuses `devig2Way`
// (lib/pools/templates/odds-devig.ts, already generic/shared) for vig
// removal; does NOT import lib/pools/templates/nfl-odds.ts itself — that
// module is legacy-pool-scoped (backs the pool-creation wizard's
// best-effort prefill, including a half-point-rounding convention specific
// to avoiding pari-mutuel pushes), and R0/R0.5 established the Prediction
// domain must not depend on the legacy pool engine's own template code.
// The underlying methodology (median-of-de-vigged-prices across every
// bookmaker offering a usable price; no curated allowlist, since API-NFL's
// bookmaker catalog has no reputability metadata to curate from) is the
// same, proven approach — reimplemented here as a handful of lines rather
// than cross-importing, since the two modules' outputs mean different
// things (a wizard prefill estimate vs. a canonical, gradeable Market).
//
// No SPREAD/Asian-Handicap parsing exists in this file. Live verification
// against the real API-NFL /odds endpoint (2026-09-21, read-only, no
// Supabase involved — see the R2 completion report) reproduced the exact
// ambiguity nfl-odds.ts's own header already documents: a bookmaker's
// "Home -1" entry priced identically to that same bookmaker's moneyline
// "Home" price, which is not a coherent spread quote. R2 does not attempt
// to resolve that ambiguity — it simply never ingests SPREAD until a
// future milestone does.

import { devig2Way } from "@/lib/pools/templates/odds-devig";
import type { NflBookmakerOdds } from "@/lib/sports-data/types";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface MoneylineAggregate {
  /** HOME's fair win probability, 0-1. Always anchored to HOME — never "the favorite" — so this maps directly onto a MONEYLINE Market's fixed yes_side:"HOME" identity. */
  homeProbability: number;
  bookmakerCount: number;
}

/**
 * Every bookmaker offering both a Home and an Away moneyline price is
 * included (no allowlist), de-vigged individually, aggregated by median —
 * robust to one outlier book without needing curation. Returns null if
 * fewer than `minBookmakerCount` bookmakers have a usable price.
 */
export function aggregateMoneyline(bookmakers: NflBookmakerOdds[], minBookmakerCount: number): MoneylineAggregate | null {
  const fair: number[] = [];
  for (const bm of bookmakers) {
    const home = bm.moneyline.find((v) => v.value === "Home");
    const away = bm.moneyline.find((v) => v.value === "Away");
    if (!home || !away) continue;
    const p = devig2Way(home.odd, away.odd);
    if (p !== null) fair.push(p);
  }
  if (fair.length < minBookmakerCount) return null;
  return { homeProbability: median(fair), bookmakerCount: fair.length };
}

export interface TotalAggregate {
  /** The combined-score line ingestion selected as the current consensus total. */
  line: number;
  /** The fair probability the total lands OVER `line` — this is the YES probability for a TOTAL Market (yes_side is always null/OVER there). */
  overProbability: number;
  bookmakerCount: number;
}

const OVER_UNDER_PATTERN = /^(Over|Under)\s+(-?\d+(?:\.\d+)?)$/;

/**
 * API-NFL exposes many alternate total lines per game (e.g. Over/Under at
 * 37, 37.5, 38, 44.5, ...), not one canonical "the" line. For each distinct
 * point value, every bookmaker quoting BOTH sides at that exact point is
 * de-vigged and aggregated by median (same principle as moneyline above);
 * the point whose consensus fair probability lands closest to a 50/50 coin
 * flip is treated as the market's real current line — a sportsbook prices
 * its true number closest to even money on both sides, with alternate
 * (bought-up/down) lines away from it skewed accordingly. This mirrors the
 * already-proven `estimateBestOverUnderLine` approach in
 * lib/pools/templates/nfl-odds.ts, deliberately without that module's
 * `roundUpToHalfPoint` step: that rounding exists only to guarantee the
 * legacy pool product never lands on an exact push (which it cannot
 * settle); Brohda's Prediction domain already grades an exact push as VOID
 * (R1), so a whole-number line here is fully meaningful, not a defect to
 * round away.
 */
export function aggregateTotal(bookmakers: NflBookmakerOdds[], minBookmakerCount: number): TotalAggregate | null {
  const byPoint = new Map<number, Array<{ overOdd: number; underOdd: number }>>();

  for (const bm of bookmakers) {
    const byPointForBm = new Map<number, { overOdd?: number; underOdd?: number }>();
    for (const raw of bm.gameTotal) {
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
      list.push({ overOdd, underOdd });
      byPoint.set(point, list);
    }
  }

  let best: { point: number; probability: number; bookmakerCount: number } | null = null;
  for (const [point, pairs] of byPoint) {
    const fair = pairs.map((p) => devig2Way(p.overOdd, p.underOdd)).filter((p): p is number => p !== null);
    if (fair.length < minBookmakerCount) continue;
    const probability = median(fair);
    if (!best || Math.abs(probability - 0.5) < Math.abs(best.probability - 0.5)) {
      best = { point, probability, bookmakerCount: fair.length };
    }
  }
  if (!best) return null;
  return { line: best.point, overProbability: best.probability, bookmakerCount: best.bookmakerCount };
}
