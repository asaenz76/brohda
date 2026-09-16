// Prediction Network transformation, Milestone 1 (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
// Milestone 1 — Read-Only Market Foundation). This file is the provider-neutral
// contract: no application code outside lib/prediction-markets/providers/
// should ever see a raw provider (e.g. Polymarket) response shape — same
// discipline as lib/sports-data/types.ts's own comment for sports providers,
// applied to a deliberately separate domain (see provider-registry.ts for
// why prediction-market providers are not folded into the sports-data
// registry).
//
// Deliberately does NOT define Order/Trade/Position types. Per the roadmap's
// hard scope boundary for this milestone, those are undesigned — adding
// placeholder shapes for them here would misrepresent unfinished design work
// as settled architecture.

export type PredictionMarketStatus = "ACTIVE" | "INACTIVE" | "CLOSED" | "ARCHIVED";

export interface NormalizedMarketPrice {
  /** Independently-read YES price, 0-1 range. Null = not available from the provider at ingestion time — never a substituted zero. */
  yes: number | null;
  /** Independently-read NO price. Never derived as `1 - yes` — see docs/architecture/prediction-market-provider.md. */
  no: number | null;
  /** Which raw provider outcome label was matched to yes/no, for auditability. Null if the mapping itself could not be established. */
  outcomeLabels: { yes: string | null; no: string | null } | null;
}

export interface NormalizedMarket {
  provider: string;
  providerMarketId: string;
  /** Best-effort; null when the ingestion path didn't observe an event grouping for this market. */
  providerEventId: string | null;
  question: string;
  description: string | null;
  status: PredictionMarketStatus;
  price: NormalizedMarketPrice;
  volume24hr: number | null;
  liquidity: number | null;
  /** Raw, provider-specific resolution tracking — diagnostic pass-through only, not a normalized enum. See known limitations in the architecture doc. */
  resolutionStatus: string | null;
  resolvedBy: string | null;
  /** Never populated by Milestone 1's ingestion. Reserved for a later, properly-researched milestone. */
  resolvedOutcome: string | null;
  opensAt: string | null;
  closesAt: string | null;
  closedAt: string | null;
  /** Which eligibility rule caused this market to be selected — e.g. "explicit_market_id:...", "category_tag:...". */
  ingestionSource: string;
  /** Raw diagnostic payload — booleans, raw arrays, CLOB fields if present. Never part of the contract other code should read from directly. */
  providerMetadata: Record<string, unknown>;
}

/**
 * Bounded selection criteria for ingestion (roadmap Milestone 1, STEP 9 —
 * "Brohda must not blindly mirror the entire provider catalog by default").
 * Deliberately simple: explicit allowlists and coarse filters, not a
 * recommendation/ranking engine. Which of these an adapter can actually
 * honor depends on what the provider's API supports — see each adapter's
 * own documentation of which criteria it applies server-side (as a request
 * filter) vs. client-side (post-fetch filtering).
 */
export interface MarketEligibilityCriteria {
  /** If set, ONLY these provider market ids are eligible — takes precedence over every other filter. */
  explicitMarketIds?: string[];
  /** If set, ONLY markets belonging to these provider event ids are eligible. */
  explicitEventIds?: string[];
  /** Provider-specific category/tag filter (e.g. Polymarket's tag_id). */
  categoryTags?: string[];
  /** Only markets the provider reports as currently active. */
  activeOnly?: boolean;
  /** Markets below this liquidity are skipped (post-normalization). */
  minLiquidity?: number;
  /** Hard cap on how many markets a single ingestion run will process — required, not optional, to keep pagination bounded (roadmap STEP 13). */
  maxResults: number;
}

export interface MarketIngestionCounts {
  discovered: number;
  eligible: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface MarketIngestionFailure {
  providerMarketId: string | null;
  reason: string;
}

export interface MarketIngestionResult {
  provider: string;
  counts: MarketIngestionCounts;
  failures: MarketIngestionFailure[];
}

/**
 * A single per-market normalization outcome — used internally by adapters
 * so one malformed market can be reported and skipped without throwing away
 * everything else in the same page (roadmap STEP 12).
 */
export type NormalizeResult =
  | { ok: true; market: NormalizedMarket }
  | { ok: false; providerMarketId: string | null; reason: string };

/**
 * Every raw market an adapter looks at is yielded as exactly one of these —
 * "ineligible" (filtered out by eligibility.ts, never normalized) or
 * "eligible" (normalization was attempted, which may itself succeed or
 * fail). This is what lets ingest.ts report discovered/eligible/skipped/
 * failed as four genuinely distinct counts (roadmap STEP 12) instead of
 * inferring them from a plain list of successes.
 */
export type MarketDiscoveryEvent =
  | { kind: "ineligible"; providerMarketId: string; reason: string }
  | { kind: "eligible"; result: NormalizeResult };

/**
 * The read-only provider contract for this milestone. Deliberately narrow —
 * no order/trade/position methods exist yet (roadmap hard scope boundary).
 * `listMarkets` is an async generator so callers (ingest.ts) can process and
 * persist one page at a time rather than holding an unbounded array in
 * memory, and so `maxResults`/pagination-termination logic lives in exactly
 * one place (the adapter), not duplicated by every caller. `maxResults`
 * bounds the number of ELIGIBLE markets yielded, not the number of raw
 * markets discovered while searching for them.
 */
export interface PredictionMarketProvider {
  readonly name: string;
  isEnabled(): boolean;
  listMarkets(criteria: MarketEligibilityCriteria): AsyncGenerator<MarketDiscoveryEvent, void, void>;
}
