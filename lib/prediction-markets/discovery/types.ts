// Milestone 2 — Prediction Market Discovery Experience
// (docs/PRODUCT_TRANSFORMATION_ROADMAP.md). Consumer-facing types only —
// deliberately separate from MarketRecord (Milestone 1's internal
// repository shape), NormalizedMarket (the provider-adapter contract), and
// any raw database row. Nothing here ever carries a provider name, provider
// id, or raw metadata (roadmap STEP 3).

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
  /** Stage 4A remediation (§5/§13): semantic per-side labels ("Chiefs win", "Over 47.5") derived from `markets.price_outcome_labels` — never the raw YES/NO enum. See lib/prediction-markets/selection-labels.ts. */
  yesLabel: string;
  noLabel: string;
}

export interface DiscoveryMarketDetail extends DiscoveryMarketCard {
  description: string | null;
  /** Only ever non-null once Brohda's own normalized data genuinely contains a resolution — never fabricated (roadmap STEP 16). Raw "YES"/"NO" — resolve through yesLabel/noLabel for display, never render this directly. */
  resolvedOutcome: string | null;
}
