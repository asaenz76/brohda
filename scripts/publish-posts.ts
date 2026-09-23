/**
 * Manual/developer entrypoint for Milestone R3's Post publication
 * (docs/BROHDA_2_0_MILESTONE_MAP.md). Deliberately NOT wired to any
 * scheduler by this milestone — matching scripts/ingest-nfl-markets.ts and
 * scripts/grade-predictions.ts's own precedent. The cron-compatible route
 * (app/api/cron/publish-posts/route.ts) exists and calls this exact same
 * runPostPublication() function; wiring an actual external scheduler is an
 * operational decision outside this repository's scope.
 *
 * Idempotent: safe to run repeatedly. Does nothing unless
 * platform_settings.post_publication_enabled is true (fail-closed default).
 *
 * Usage: pnpm publish-posts [--production]
 *   (requires `pnpm supabase:start` unless --production is passed)
 */
import { runPostPublication } from "../lib/posts/publication";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
assertProductionWriteConfirmed(SUPABASE_URL, "publish-posts");

async function main() {
  console.log("Publishing Posts...");

  const summary = await runPostPublication();

  if (!summary.policyEnabled) {
    console.log("post_publication_enabled is false — nothing done. Enable it in platform_settings to run publication.");
    return;
  }

  console.log(`\nExamined ${summary.fixturesExamined} eligible fixture(s):`);
  for (const outcome of summary.outcomes) {
    console.log(`  fixture ${outcome.fixtureId} -> post ${outcome.postId}: ${outcome.outcome}`);
  }
  if (summary.failures.length > 0) {
    console.log(`\n${summary.failures.length} fixture(s) failed (canonical state for every other fixture is unaffected):`);
    for (const failure of summary.failures) console.log(`  fixture ${failure.fixtureId}: ${failure.error}`);
  }
}

main().catch((error) => {
  console.error("Publication run failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
