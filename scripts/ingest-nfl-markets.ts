/**
 * Manual/developer entrypoint for Milestone R2's sports Market ingestion
 * (docs/BROHDA_2_0_MILESTONE_MAP.md). Deliberately NOT wired to any
 * scheduler by this milestone — no Vercel Cron entry, no cron-job.org job —
 * matching scripts/grade-predictions.ts's own precedent. The
 * cron-compatible route (app/api/cron/ingest-nfl-markets/route.ts) exists
 * and calls this exact same runNflMarketIngestion() function; wiring an
 * actual external scheduler to that route is an operational decision
 * outside this repository's scope.
 *
 * Idempotent: safe to run repeatedly. Does nothing unless
 * platform_settings.market_ingestion_enabled is true (fail-closed default).
 *
 * Usage: pnpm ingest-nfl-markets [--production]
 *   (requires `pnpm supabase:start` unless --production is passed)
 */
import { runNflMarketIngestion } from "../lib/prediction-markets/ingestion/nfl";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
assertProductionWriteConfirmed(SUPABASE_URL, "ingest-nfl-markets");

async function main() {
  console.log("Ingesting NFL Markets...");

  const summary = await runNflMarketIngestion();

  if (!summary.policyEnabled) {
    console.log("market_ingestion_enabled is false — nothing done. Enable it in platform_settings to run ingestion.");
    return;
  }

  console.log(`\nExamined ${summary.fixturesExamined} eligible fixture(s):`);
  for (const outcome of summary.outcomes) {
    console.log(`  fixture ${outcome.fixtureId}: moneyline=${outcome.moneyline}, total=${outcome.total}`);
  }
  if (summary.failures.length > 0) {
    console.log(`\n${summary.failures.length} fixture(s) failed (canonical state for every other fixture is unaffected):`);
    for (const failure of summary.failures) console.log(`  fixture ${failure.fixtureId}: ${failure.error}`);
  }
}

main().catch((error) => {
  console.error("Ingestion run failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
