/**
 * Manual/developer entrypoint for resolving accepted Call BS Challenges
 * (docs/BROHDA_2_0_MILESTONE_MAP.md, Milestone R7). Mirrors
 * scripts/grade-predictions.ts exactly. As of Milestone R13.5, this same
 * resolveAcceptedChallenges() is also invoked automatically on a
 * schedule via app/api/cron/resolve-challenges (which itself runs after
 * grade-predictions, same ordering this script's own usage note already
 * required) — this script remains as a manual/debug entrypoint, not the
 * only way this job executes anymore.
 *
 * Idempotent: safe to run repeatedly. Only ever touches Challenges still
 * ACCEPTED — see lib/challenges/resolution.ts.
 *
 * Usage: pnpm resolve-challenges [--production]
 *   (requires `pnpm supabase:start` unless --production is passed)
 */
import { resolveAcceptedChallenges } from "../lib/challenges/resolution";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
assertProductionWriteConfirmed(SUPABASE_URL, "resolve-challenges");

async function main() {
  console.log("Resolving accepted Call BS Challenges...");

  const summary = await resolveAcceptedChallenges();

  console.log("\nResolution result:");
  console.log(`  examined:       ${summary.examined}`);
  console.log(`  resolved:       ${summary.resolved}`);
  console.log(`    challenger won: ${summary.challengerWon}`);
  console.log(`    recipient won:  ${summary.recipientWon}`);
  console.log(`    void:           ${summary.voided}`);
  console.log(`  still pending:  ${summary.stillPending}`);
  console.log(`  failures:       ${summary.failures.length}`);
  for (const failure of summary.failures) {
    console.error(`    [error] challenge ${failure.challengeId}: ${failure.error}`);
  }

  if (summary.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Challenge resolution run failed:", error instanceof Error ? error.message : error);
  console.error("Any Challenges already resolved before this failure remain resolved — this run never re-resolves or reverts a decided one.");
  process.exit(1);
});
