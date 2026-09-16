/**
 * Manual/service-level entrypoint for ingesting prediction markets
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 1, STEP 17). This is
 * intentionally NOT wired to any scheduler — no Vercel Cron entry, no
 * cron-job.org job, nothing invokes this automatically. Production
 * auto-sync is OFF; running this file is the only way it executes, exactly
 * once per invocation.
 *
 * A future milestone MAY choose to point a cron-compatible route at the
 * same `ingestFromProvider` function this script calls — that decision, and
 * any actual scheduling, belongs to that milestone's own implementation
 * spec, not to this one.
 *
 * Usage: pnpm ingest-prediction-markets [--production] [--max=N]
 *   (requires `pnpm supabase:start` unless --production is passed)
 */
import { ingestFromProvider } from "../lib/prediction-markets/ingest";
import { POLYMARKET_PROVIDER } from "../lib/prediction-markets/provider-names";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
assertProductionWriteConfirmed(SUPABASE_URL, "ingest-prediction-markets");

const maxArg = process.argv.find((a) => a.startsWith("--max="));
const maxResults = maxArg ? Number.parseInt(maxArg.split("=")[1], 10) : 25;

async function main() {
  console.log(`Ingesting from ${POLYMARKET_PROVIDER} (maxResults=${maxResults})...`);

  const result = await ingestFromProvider(POLYMARKET_PROVIDER, {
    activeOnly: true,
    maxResults,
  });

  console.log("\nIngestion result:");
  console.log(`  discovered: ${result.counts.discovered}`);
  console.log(`  eligible:   ${result.counts.eligible}`);
  console.log(`  inserted:   ${result.counts.inserted}`);
  console.log(`  updated:    ${result.counts.updated}`);
  console.log(`  skipped:    ${result.counts.skipped}`);
  console.log(`  failed:     ${result.counts.failed}`);

  if (result.failures.length > 0) {
    console.log("\nFailures:");
    for (const failure of result.failures) {
      console.log(`  - ${failure.providerMarketId ?? "(unknown id)"}: ${failure.reason}`);
    }
  }
}

main().catch((error) => {
  console.error("Ingestion run failed:", error instanceof Error ? error.message : error);
  console.error(
    "Any markets already persisted before this failure remain in the database unchanged " +
      "— this run does not clear or reset existing rows.",
  );
  process.exit(1);
});
