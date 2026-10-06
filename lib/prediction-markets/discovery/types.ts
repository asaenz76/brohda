// Milestone 2 — Prediction Market Discovery Experience
// (docs/PRODUCT_TRANSFORMATION_ROADMAP.md). Consumer-facing types only —
// deliberately separate from MarketRecord (Milestone 1's internal
// repository shape), NormalizedMarket (the provider-adapter contract), and
// any raw database row. Nothing here ever carries a provider name, provider
// id, or raw metadata (roadmap STEP 3).

import type { Choice } from "../selection-labels";

export type ConsumerMarketStatus = "ACTIVE" | "CLOSED" | "RESOLVED";

export type Freshness = "FRESH" | "STALE" | "UNAVAILABLE";

export interface DiscoveryCategory {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  displayOrder: number;
  enabled: boolean;
  iconKey: string | null;
}

/** The minimal category reference a market card/detail needs — never the full admin record. */
export interface DiscoveryCategoryRef {
  id: string;
  slug: string;
  displayName: string;
}

export interface DiscoveryMarketCard {
  id: string;
  question: string;
  categories: DiscoveryCategoryRef[];
  yesPercent: number | null;
  noPercent: number | null;
  status: ConsumerMarketStatus;
  closesAt: string | null;
  freshness: Freshness;
  /** What a viewer reads for each canonical side ("Indianapolis Colts", "Patriots +3.5", "Over 47.5") — never the raw YES/NO enum. Derived once, in lib/prediction-markets/selection-labels.ts. */
  yesLabel: string;
  noLabel: string;
  /** Both choices in DISPLAY order (matchup order for team Markets), each carrying the canonical outcome it stands for and its accessible name. Render from this, not from yesLabel/noLabel positions. */
  choices: [Choice, Choice];
  /** "Moneyline" | "Spread" | "Total 47.5", or null when the template-aware label isn't available (the old question is then the context). */
  marketLabel: string | null;
}

export interface DiscoveryMarketDetail extends DiscoveryMarketCard {
  description: string | null;
  /** Only ever non-null once Brohda's own normalized data genuinely contains a resolution — never fabricated (roadmap STEP 16). Raw "YES"/"NO" — resolve through yesLabel/noLabel for display, never render this directly. */
  resolvedOutcome: string | null;
  /**
   * Phase C (Brohda 2.0 redesign) — real Brohda Pick count, and (inherited
   * from DiscoveryMarketCard) `yesPercent`/`noPercent` are, for this type
   * ONLY, overridden by getMarketDetail() to be real Pick-share sentiment
   * (see lib/predictions/sentiment.ts) rather than DiscoveryMarketCard's
   * own provider-price-derived values — see that function's own comment.
   */
  totalPickCount: number;
}
