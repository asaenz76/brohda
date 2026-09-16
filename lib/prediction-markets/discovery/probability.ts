/**
 * The single, centralized place a 0-1 provider price becomes a consumer
 * percentage (roadmap STEP 11: "centralize probability-formatting
 * behavior... do not make precision a per-component choice").
 *
 * Rounding rule: standard round-half-up to the nearest whole percent
 * (`Math.round`), matching this codebase's existing convention for
 * consumer-facing percentages (components/pools/CommunitySplit.tsx renders
 * pre-computed whole-number percentages the same way). Never fabricates a
 * value — null in, null out; the two sides are never forced to sum to 100
 * if the underlying provider prices don't (see
 * lib/prediction-markets/providers/polymarket/normalize.ts's own price
 * independence guarantee).
 */
export function formatProbabilityPercent(price: number | null): number | null {
  if (price == null) return null;
  return Math.round(price * 100);
}
