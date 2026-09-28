// Phase C (Brohda 2.0 redesign, "do not fake sentiment" — spec §13-14).
// The real Brohda social-sentiment calculation, replacing the
// provider/bookmaker-price-derived percentages that used to be shown on
// Home's feed cards and on MarketPredictionCard (see the guardrail
// comments on MarketRecord.yesPrice/noPrice and NormalizedMarketPrice,
// lib/prediction-markets/{repository,types}.ts).
//
// INCLUSION RULE (documented per spec §14's explicit "do not guess, write
// down the rule" instruction) — derived from inspecting the Prediction
// lifecycle (lib/predictions/types.ts, lib/predictions/grading.ts):
//
//   Every `predictions` row for the Market counts, regardless of:
//     - lifecycle_state (PENDING or GRADED) — a Pick is a real, deliberate
//       choice the instant it's made; it doesn't retroactively stop having
//       been picked once the game finishes and it gets graded.
//     - result (CORRECT / INCORRECT / VOID / null) — VOID means the
//       *Market's* resolution was inconclusive (e.g. an archived Market),
//       not that the picker's choice wasn't real. Reputation math
//       (lib/reputation/*) already established this same principle for a
//       different question ("how many did you predict") — VOID counts
//       there too, just never toward accuracy. Sentiment asks "who picked
//       what," not "who was right," so there's no reason to exclude VOID.
//     - PENDING vs already-locked — `predictions_one_per_user_market`
//       guarantees at most one row per (user, market) at any time
//       (edits update the row in place; prediction_revisions is the
//       separate append-only history table), so there is no double-
//       counting to guard against and no "latest of several" ambiguity.
//   There is no soft-delete on `predictions` (no `deleted_at` column, and
//   `forbid_graded_prediction_mutation` prevents mutating a graded row) —
//   so there is no deleted/invalid state to exclude either.
//
// NEVER derived from markets.yes_price/no_price (provider odds) — see
// getPickAggregatesForMarkets (lib/predictions/repository.ts), the only
// function that reads real data for this calculation.

export interface MarketPickAggregate {
  marketId: string;
  totalPickCount: number;
  yesCount: number;
  noCount: number;
}

export interface PickSentiment {
  totalPickCount: number;
  /** Null exactly when totalPickCount === 0 — never a fabricated 0%/0% split, matching the reputation math's own "never a fabricated 0%" convention. */
  yesPercent: number | null;
  noPercent: number | null;
}

/** Pure — no I/O, unit-testable with an explicit aggregate value (or none, for the zero-Picks case). */
export function computePickSentiment(aggregate: MarketPickAggregate | undefined): PickSentiment {
  const total = aggregate?.totalPickCount ?? 0;
  if (total === 0) return { totalPickCount: 0, yesPercent: null, noPercent: null };
  return {
    totalPickCount: total,
    yesPercent: Math.round((aggregate!.yesCount / total) * 100),
    noPercent: Math.round((aggregate!.noCount / total) * 100),
  };
}
