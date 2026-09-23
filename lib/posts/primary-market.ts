// Milestone R3 (docs/BROHDA_2_0_MILESTONE_MAP.md, §13-14): deterministic,
// configurable "which Market is primary" selection. Pure function — no I/O,
// no stored `primary_market_id`. Primary-market presentation is recomputed
// on every read from whichever Markets are currently ACTIVE for the Game,
// which is exactly what makes it safe for the primary Market to change
// (a line moves, a template's Market goes INACTIVE) without ever touching
// Post identity or requiring a migration to a new "primary" pointer.

import type { MarketRecord } from "@/lib/prediction-markets/repository";

/**
 * `priority` is the configurable ordered template preference
 * (platform_settings.post_primary_market_template_priority). The first
 * ACTIVE market whose template appears in that list, in list order, wins.
 * A template not present in `priority` at all is never selectable as
 * primary (but still returned by `activeMarkets` for the "other Markets"
 * presentation) — this is how an operator could deprioritize a template
 * without touching code.
 */
export function selectPrimaryMarket(activeMarkets: MarketRecord[], priority: string[]): MarketRecord | null {
  for (const template of priority) {
    const match = activeMarkets.find((m) => m.marketTemplate === template);
    if (match) return match;
  }
  return null;
}
