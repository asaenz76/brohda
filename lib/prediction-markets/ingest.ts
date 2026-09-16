import "server-only";
import { getPredictionMarketProvider } from "./provider-registry";
import { upsertMarket } from "./repository";
import type { MarketEligibilityCriteria, MarketIngestionResult } from "./types";

/**
 * Orchestrates one ingestion run for one provider: discover -> filter ->
 * normalize -> persist, tallying every outcome (roadmap STEP 12).
 *
 * Failure isolation is the core safety property here, not an afterthought:
 * - A single malformed market never aborts the run — it's counted as
 *   `failed` and every other market in the same page still gets processed
 *   (the adapter yields per-market results, not an all-or-nothing batch).
 * - A provider-level failure (network error, Gamma outage, exhausted
 *   retries) propagates as a thrown error from the generator, which this
 *   function lets through rather than swallowing — but because every
 *   successful market up to that point was already upserted individually,
 *   whatever was ingested before the failure remains in `markets`
 *   untouched. There is no "clear the table, then repopulate" step
 *   anywhere in this path, so a failure partway through a run can never
 *   wipe previously-valid data (roadmap STEP 14). The caller (the CLI
 *   script) is responsible for surfacing the partial result and the error
 *   together — see scripts/ingest-prediction-markets.ts.
 */
export async function ingestFromProvider(
  providerName: string,
  criteria: MarketEligibilityCriteria,
): Promise<MarketIngestionResult> {
  const provider = getPredictionMarketProvider(providerName);
  if (!provider) {
    throw new Error(`Unknown prediction-market provider: "${providerName}"`);
  }
  if (!provider.isEnabled()) {
    throw new Error(`Prediction-market provider "${providerName}" is not enabled (check its *_ENABLED env var).`);
  }

  const result: MarketIngestionResult = {
    provider: providerName,
    counts: { discovered: 0, eligible: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 },
    failures: [],
  };

  for await (const event of provider.listMarkets(criteria)) {
    result.counts.discovered += 1;

    if (event.kind === "ineligible") {
      result.counts.skipped += 1;
      continue;
    }

    result.counts.eligible += 1;

    if (!event.result.ok) {
      result.counts.failed += 1;
      result.failures.push({ providerMarketId: event.result.providerMarketId, reason: event.result.reason });
      continue;
    }

    try {
      const { outcome } = await upsertMarket(event.result.market);
      result.counts[outcome] += 1;
    } catch (error) {
      // A persistence failure for one market (a constraint violation, a
      // transient DB error) is exactly the same class of problem as a
      // malformed market — isolate it and keep going, per roadmap STEP 12's
      // "one malformed market should not corrupt unrelated market rows."
      result.counts.failed += 1;
      result.failures.push({
        providerMarketId: event.result.market.providerMarketId,
        reason: error instanceof Error ? error.message : "unknown persistence error",
      });
    }
  }

  return result;
}
