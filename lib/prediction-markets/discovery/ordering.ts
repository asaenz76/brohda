import type { DiscoveryMarketCard, Freshness } from "./types";

/**
 * Discovery ordering (roadmap STEP 14; hard-coding remediation Finding 1).
 * The set of SUPPORTED sort primitives is a fixed, hard-coded domain
 * capability — exactly what the remediation instruction permits staying in
 * code ("the supported sorting primitives themselves may remain hard-coded
 * domain/application capabilities"). What is NOT hard-coded is which of
 * them are active, in what priority order, and which direction each runs —
 * that is `discovery_sort_policy` (supabase/migrations/
 * 20260101000139_discovery_sort_policy.sql), a founder-editable table, read
 * via `getSortPolicy()` in repository.ts.
 *
 * This is deliberately NOT a generic rules engine: `SortCriterion` is a
 * closed, three-value union: `extractSortValue` is a plain switch over it,
 * not an expression evaluator, and there is no way to express a criterion
 * this file doesn't already know how to compute. Adding a fourth sortable
 * signal in the future requires a code change here (a real domain
 * capability), same as it would for any fixed enum — only the ORDER,
 * DIRECTION, and ENABLED state of the three that exist today are policy.
 */
export type SortCriterion = "FRESHNESS" | "CLOSE_TIME" | "LIQUIDITY";
export type SortDirection = "ASC" | "DESC";

export interface SortRule {
  criterion: SortCriterion;
  direction: SortDirection;
}

/** Already filtered to enabled rules, already ordered by priority — the repository layer's job, not this file's. */
export type SortPolicy = SortRule[];

/**
 * Reproduces Milestone 2's original code-constant behavior exactly —
 * used ONLY as a fail-open fallback if `discovery_sort_policy` is ever
 * empty or unreadable, matching this codebase's existing fail-open
 * convention for settings reads (lib/settings/pool-capabilities.ts).
 */
export const DEFAULT_SORT_POLICY: SortPolicy = [
  { criterion: "FRESHNESS", direction: "ASC" },
  { criterion: "CLOSE_TIME", direction: "ASC" },
  { criterion: "LIQUIDITY", direction: "DESC" },
];

const FRESHNESS_RANK: Record<Freshness, number> = { FRESH: 0, STALE: 1, UNAVAILABLE: 2 };

export interface OrderableMarket extends DiscoveryMarketCard {
  liquidity: number | null;
}

/**
 * Extracts a numeric sort key for one criterion. `missing: true` means this
 * market has no meaningful value for this criterion at all (no close time;
 * no liquidity figure) — such markets always sort AFTER any market with a
 * real value for that criterion, regardless of direction, on the reasoning
 * that a value you can't rank shouldn't benefit from either ranking
 * direction. This is the one piece of genuinely fixed tie-breaking logic in
 * this file — a domain judgment call about incomparable data, not a
 * tunable business dial.
 */
function extractSortValue(market: OrderableMarket, criterion: SortCriterion): { value: number; missing: boolean } {
  switch (criterion) {
    case "FRESHNESS":
      return { value: FRESHNESS_RANK[market.freshness], missing: false };
    case "CLOSE_TIME":
      return market.closesAt ? { value: new Date(market.closesAt).getTime(), missing: false } : { value: 0, missing: true };
    case "LIQUIDITY":
      return { value: market.liquidity ?? 0, missing: market.liquidity == null };
  }
}

/**
 * Applies the configured, ordered, enabled sort rules in sequence — the
 * first rule with a genuine difference between `a` and `b` decides; ties
 * fall through to the next rule; if every configured rule ties, order is
 * unspecified (stable per `Array.prototype.sort`'s own guarantee).
 */
export function compareDiscoveryMarkets(a: OrderableMarket, b: OrderableMarket, policy: SortPolicy): number {
  for (const rule of policy) {
    const av = extractSortValue(a, rule.criterion);
    const bv = extractSortValue(b, rule.criterion);

    if (av.missing !== bv.missing) return av.missing ? 1 : -1;
    if (av.value !== bv.value) {
      const diff = av.value - bv.value;
      return rule.direction === "ASC" ? diff : -diff;
    }
  }
  return 0;
}
