/**
 * Manual/developer entrypoint for grading Predictions
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 3, roadmap STEP 20).
 * As of Milestone R13.5, this same runGradingJob() is also invoked
 * automatically on a schedule via app/api/cron/grade-predictions — this
 * script remains as a manual/debug entrypoint for local runs and ad hoc
 * production reruns, not the only way this job executes anymore.
 *
 * Idempotent: safe to run repeatedly. Only ever touches Predictions still
 * in PENDING state — see lib/predictions/grading.ts.
 *
 * Usage: pnpm grade-predictions [--production]
 *   (requires `pnpm supabase:start` unless --production is passed)
 */
import { runGradingJob } from "../lib/predictions/grading";
import { recordGradedPredictionResult } from "../lib/predictions/streak";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
assertProductionWriteConfirmed(SUPABASE_URL, "grade-predictions");

async function main() {
  console.log("Grading pending predictions...");

  const summary = await runGradingJob(recordGradedPredictionResult);

  console.log("\nGrading result:");
  console.log(`  examined:      ${summary.examined}`);
  console.log(`  graded:        ${summary.graded}`);
  console.log(`    correct:     ${summary.correct}`);
  console.log(`    incorrect:   ${summary.incorrect}`);
  console.log(`    void:        ${summary.voided}`);
  console.log(`  still pending: ${summary.stillPending}`);
  console.log(`  failures:      ${summary.failures.length}`);
  for (const failure of summary.failures) {
    console.error(`    [error] prediction ${failure.predictionId}: ${failure.error}`);
  }

  if (summary.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Grading run failed:", error instanceof Error ? error.message : error);
  console.error("Any predictions already graded before this failure remain graded — this run never re-grades or reverts a decided row.");
  process.exit(1);
});
