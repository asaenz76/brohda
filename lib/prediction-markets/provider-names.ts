/**
 * Single source of truth for prediction-market provider identity strings
 * stored in `markets.provider` — same discipline as
 * lib/sports-data/provider-names.ts, kept as a genuinely separate module
 * (not a shared constant) because prediction-market providers and
 * sports-data providers are different domains that happen to coexist in
 * this codebase during the transformation (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
 * §2 — a fixture provider answers "what happened in a game"; a prediction-
 * market provider answers "what does the market currently believe" — these
 * are not the same question and should never share a registry).
 */
export const POLYMARKET_PROVIDER = "polymarket" as const;

export type PredictionMarketProviderName = typeof POLYMARKET_PROVIDER;
