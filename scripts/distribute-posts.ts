/**
 * Manual/developer entrypoint for Milestone R4's Post distribution
 * (docs/BROHDA_2_0_MILESTONE_MAP.md). Deliberately NOT wired to any
 * scheduler by this milestone — matching scripts/publish-posts.ts and
 * scripts/ingest-nfl-markets.ts's own precedent exactly.
 *
 * Idempotent and a genuine backfill/reconciliation mechanism: examines
 * every published Post (not just new ones), so it safely catches up
 * Posts that were published before a relevant Community existed or
 * before this job ever ran. Does nothing unless
 * platform_settings.community_distribution_enabled is true (fail-closed
 * default).
 *
 * Usage: pnpm distribute-posts [--production]
 *   (requires `pnpm supabase:start` unless --production is passed)
 */
import { runCommunityDistribution } from "../lib/communities/distribution";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
assertProductionWriteConfirmed(SUPABASE_URL, "distribute-posts");

async function main() {
  console.log("Distributing Posts to Communities...");

  const summary = await runCommunityDistribution();

  if (!summary.policyEnabled) {
    console.log("community_distribution_enabled is false — nothing done. Enable it in platform_settings to run distribution.");
    return;
  }

  console.log(`\nExamined ${summary.postsExamined} published Post(s):`);
  for (const outcome of summary.outcomes) {
    console.log(`  post ${outcome.postId}: distributed to [${outcome.distributedCommunityIds.join(", ")}]${outcome.skippedReasons.length > 0 ? `, skipped: [${outcome.skippedReasons.join(", ")}]` : ""}`);
  }
  if (summary.failures.length > 0) {
    console.log(`\n${summary.failures.length} post(s) failed (distribution for every other post is unaffected):`);
    for (const failure of summary.failures) console.log(`  post ${failure.postId}: ${failure.error}`);
  }
}

main().catch((error) => {
  console.error("Distribution run failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
