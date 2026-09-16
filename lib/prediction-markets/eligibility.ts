// Selective ingestion boundary (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
// Milestone 1, STEP 9): Brohda must not blindly mirror the entire provider
// catalog. This module is the one place that decides "is this raw provider
// market eligible to become a Brohda row" — deliberately simple (allowlists
// and coarse filters), not a recommendation or ranking engine. Which
// consumer-facing category/topic strategy Brohda eventually wants is an
// explicit OPEN decision left to Milestone 2
// (docs/PRODUCT_TRANSFORMATION_ROADMAP.md §9 OPEN #9) — this module only
// needs to prove selective ingestion is architecturally possible.

import type { MarketEligibilityCriteria } from "./types";

export interface EligibilityCheckInput {
  providerMarketId: string;
  providerEventId: string | null;
  /** Provider-reported category/tag identifiers for this market, if any (adapter-specific shape, passed through as strings). */
  categoryTags: string[];
  isActive: boolean;
  liquidity: number | null;
}

export interface EligibilityDecision {
  eligible: boolean;
  /** Human-readable reason, stored verbatim as `markets.ingestion_source` when eligible, or used for the "skipped" log line when not. */
  reason: string;
}

/**
 * Evaluates one already-normalized-enough market against the given
 * criteria. Every branch is checked explicitly and in a fixed order so the
 * eligibility decision is always attributable to one specific rule — never
 * a combined/ambiguous "it passed some filters" outcome.
 */
export function evaluateEligibility(
  input: EligibilityCheckInput,
  criteria: MarketEligibilityCriteria,
): EligibilityDecision {
  if (criteria.explicitMarketIds && criteria.explicitMarketIds.length > 0) {
    return criteria.explicitMarketIds.includes(input.providerMarketId)
      ? { eligible: true, reason: `explicit_market_id:${input.providerMarketId}` }
      : { eligible: false, reason: "not_in_explicit_market_id_allowlist" };
  }

  if (criteria.explicitEventIds && criteria.explicitEventIds.length > 0) {
    if (!input.providerEventId || !criteria.explicitEventIds.includes(input.providerEventId)) {
      return { eligible: false, reason: "not_in_explicit_event_id_allowlist" };
    }
  }

  if (criteria.categoryTags && criteria.categoryTags.length > 0) {
    const matchedTag = criteria.categoryTags.find((tag) => input.categoryTags.includes(tag));
    if (!matchedTag) {
      return { eligible: false, reason: "no_matching_category_tag" };
    }
  }

  if (criteria.activeOnly && !input.isActive) {
    return { eligible: false, reason: "not_active" };
  }

  if (criteria.minLiquidity != null) {
    if (input.liquidity == null || input.liquidity < criteria.minLiquidity) {
      return { eligible: false, reason: "below_min_liquidity" };
    }
  }

  const appliedFilters: string[] = [];
  if (criteria.explicitEventIds?.length) appliedFilters.push(`event_id:${input.providerEventId}`);
  if (criteria.categoryTags?.length) appliedFilters.push("category_tag");
  if (criteria.activeOnly) appliedFilters.push("active_only");
  if (criteria.minLiquidity != null) appliedFilters.push("min_liquidity");

  return {
    eligible: true,
    reason: appliedFilters.length > 0 ? appliedFilters.join("+") : "no_filters_configured",
  };
}
