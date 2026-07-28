import type { OddsExactGoalsBucket, OddsGoalsLine } from "@/lib/sports-data/types";

/**
 * Picks the Over/Under total-goals line closest to a 50/50 split across
 * every bookmaker offering it — the market's best estimate of the "fair"
 * total — and converts it to the MATCH_TOTAL_GOALS/FIRST_HALF_TOTAL_GOALS
 * "X or more" integer threshold (e.g. "Over 2.5" -> 3). A simple,
 * deterministic default the admin can still edit, not a pricing model.
 */
export function suggestMinimumGoalsFromOdds(lines: OddsGoalsLine[]): number | null {
  if (lines.length === 0) return null;

  let best = lines[0];
  let bestDiff = Math.abs(best.overOdd - best.underOdd);
  for (const line of lines.slice(1)) {
    const diff = Math.abs(line.overOdd - line.underOdd);
    if (diff < bestDiff) {
      best = line;
      bestDiff = diff;
    }
  }

  return Math.ceil(best.point);
}

/**
 * Same "closest to a coin flip" philosophy as suggestMinimumGoalsFromOdds,
 * adapted for TEAM_TOTAL_GOALS — there's no Over/Under line market for a
 * single team's full-match total, only an exact-goals-count distribution
 * per bookmaker (e.g. 0/1/2/"3 or more", each with its own price). For
 * each bookmaker: remove the overround (a bookmaker's odds always imply
 * more than 100% probability — that margin is the vig), then find the
 * goal-count threshold whose "scores this many or more" cumulative
 * probability is closest to 50%. The single best (bookmaker, threshold)
 * pair across all of them is the suggestion.
 */
export function suggestMinimumGoalsFromExactDistribution(distributions: OddsExactGoalsBucket[][]): number | null {
  let best: { threshold: number; diff: number } | null = null;

  for (const buckets of distributions) {
    const totalImpliedProb = buckets.reduce((sum, b) => sum + 1 / b.odd, 0);
    if (totalImpliedProb <= 0) continue;

    const maxExactCount = Math.max(0, ...buckets.filter((b) => !b.isTail).map((b) => b.count));
    for (let threshold = 1; threshold <= maxExactCount + 1; threshold++) {
      const atLeastProb = buckets.reduce(
        (sum, b) => (b.count >= threshold ? sum + 1 / b.odd / totalImpliedProb : sum),
        0,
      );
      const diff = Math.abs(atLeastProb - 0.5);
      if (!best || diff < best.diff) {
        best = { threshold, diff };
      }
    }
  }

  return best?.threshold ?? null;
}
