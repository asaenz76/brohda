import type { MarketRecord } from "./repository";
import type { PredictionOutcome } from "@/lib/predictions/types";

// Stage 4A remediation (Stage 4 audit §5/§13/§15/§16): a Market's binary
// YES/NO representation stays the internal selection/grading vocabulary
// everywhere (set_pick(), grading, the `predictions` schema) — this module
// is the ONLY place that translates it into what a viewer actually reads,
// derived from data already computed once at ingestion
// (lib/prediction-markets/ingestion/nfl.ts's `outcomeLabels`, stored
// verbatim on `markets.price_outcome_labels`) rather than hard-coding any
// team name or line value here. Pure, no I/O — safe to unit test directly.

export interface SelectionLabelSource {
  priceOutcomeLabels: MarketRecord["priceOutcomeLabels"];
}

/**
 * The label a viewer should read for one side of a Market — "Chiefs win",
 * "Over 47.5", etc. Falls back to a plain "Yes"/"No" (still human-cased,
 * never the raw enum) only for the data anomaly of a Market ingested
 * without labels, which no current ingestion path produces.
 */
export function getSelectionLabel(market: SelectionLabelSource, outcome: PredictionOutcome): string {
  const labels = market.priceOutcomeLabels;
  const label = outcome === "YES" ? labels?.yes : labels?.no;
  return label ?? (outcome === "YES" ? "Yes" : "No");
}
