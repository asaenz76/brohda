// Sports Prediction Network repivot (Milestone R0,
// docs/architecture/sports-prediction-network.md) — this module is what
// remains of the Milestone 1 Polymarket-provider contract after the
// product's real-money-execution direction was abandoned. The ingestion
// pipeline, provider registry, and Polymarket adapter that used to consume
// the rest of this file's types (`PredictionMarketProvider`,
// `MarketEligibilityCriteria`, `MarketDiscoveryEvent`, etc.) were removed
// as dead abstractions with no remaining caller — see the R0 completion
// report's file audit for the full accounting.
//
// `NormalizedMarket` survives because it is the shape `upsertMarket`
// (./repository.ts) persists into the `markets` table, and that table is
// being repurposed as the candidate schema for a sports PredictionQuestion
// (docs/architecture/sports-prediction-network.md §9) rather than replaced
// outright — the Brohda Prediction domain (lib/predictions/) already
// depends on rows in this exact shape, and rebuilding that dependency is
// out of R0's scope.

export type PredictionMarketStatus = "ACTIVE" | "INACTIVE" | "CLOSED" | "ARCHIVED";

// Milestone R1 (docs/BROHDA_2_0_MILESTONE_MAP.md, Game <-> Market
// Foundation): the approved sports proposition families. A Market
// belongs to exactly one canonical Game (fixture) and represents one
// immutable proposition — see supabase/migrations/20260101000148_*.sql for
// the enforced identity/shape rules this type must satisfy.
export type MarketTemplate = "MONEYLINE" | "SPREAD" | "TOTAL";

/** Which fixture side the YES outcome refers to. Null only for TOTAL, where YES always means OVER (a fixed template convention, not per-row data). */
export type MarketYesSide = "HOME" | "AWAY";

export interface NormalizedMarketPrice {
  /** Independently-read YES price, 0-1 range. Null = not available at ingestion time — never a substituted zero. */
  yes: number | null;
  /** Independently-read NO price. Never derived as `1 - yes`. */
  no: number | null;
  /** Which raw source outcome label was matched to yes/no, for auditability. Null if the mapping itself could not be established. */
  outcomeLabels: { yes: string | null; no: string | null } | null;
}

export interface NormalizedMarket {
  provider: string;
  providerMarketId: string;
  /** Best-effort; null when the ingestion path didn't observe an event grouping for this row. */
  providerEventId: string | null;
  question: string;
  description: string | null;
  status: PredictionMarketStatus;
  /** The canonical Game this proposition is about. Required — Brohda is sports-only; see 20260101000148_market_game_foundation.sql. */
  fixtureId: string;
  marketTemplate: MarketTemplate;
  /** Required for SPREAD/TOTAL, null for MONEYLINE — enforced by the DB shape constraint. */
  lineValue: number | null;
  /** Required for MONEYLINE/SPREAD, null for TOTAL (YES=OVER there) — enforced by the DB shape constraint. */
  yesSide: MarketYesSide | null;
  price: NormalizedMarketPrice;
  volume24hr: number | null;
  liquidity: number | null;
  /** Raw, source-specific resolution tracking — diagnostic pass-through only, not a normalized enum. */
  resolutionStatus: string | null;
  resolvedBy: string | null;
  /** "YES" | "NO" | null. Kept as `string | null` (not narrowed to a literal union) so a future resolution source can express its own vocabulary without widening this interface. */
  resolvedOutcome: string | null;
  opensAt: string | null;
  closesAt: string | null;
  closedAt: string | null;
  /** Which rule caused this row to be created — a free-text diagnostic label, not a foreign key. */
  ingestionSource: string;
  /** Raw diagnostic payload only — never part of the contract other code should read from directly. */
  providerMetadata: Record<string, unknown>;
}
