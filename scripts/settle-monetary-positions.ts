/**
 * Manual/developer entrypoint for settling eligible Monetary Positions
 * (docs/BROHDA_2_0_MILESTONE_MAP.md, Milestone R10, §35, §69-71). Mirrors
 * scripts/grade-predictions.ts's own shape. As of Milestone R13.5, the
 * batch loop itself lives in lib/monetary/settlement-runner.ts's
 * runSettlementJob() — shared with app/api/cron/settle-monetary-positions
 * so the cron route never reimplements settlement discovery/dispatch —
 * this script is now a thin wrapper around that shared runner, kept as a
 * manual/debug entrypoint for local runs and ad hoc production reruns.
 *
 * Idempotent: safe to run repeatedly. Each Position settles independently
 * (§47, §69) — one Position's failure never aborts the batch, and never
 * partially mutates that Position (settleMonetaryPosition() is one atomic
 * transaction per call).
 *
 * Usage: pnpm settle-monetary-positions [--production]
 *   (requires `pnpm supabase:start` unless --production is passed)
 */
import { runSettlementJob } from "../lib/monetary/settlement-runner";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
assertProductionWriteConfirmed(SUPABASE_URL, "settle-monetary-positions");

async function main() {
  console.log("Finding settlement-eligible Positions...");
  const summary = await runSettlementJob();
  console.log(`Found ${summary.candidates} candidate(s).\n`);

  console.log("Settlement run result:");
  console.log(`  settled (win):        ${summary.settledWin}`);
  console.log(`  settled (void):       ${summary.settledVoid}`);
  console.log(`  not yet eligible:     ${summary.notEligible}`);
  console.log(`  already settled:      ${summary.alreadySettled}`);
  console.log(`  invariant violations: ${summary.invariantViolations}`);
  console.log(`  failures:             ${summary.failures.length}`);
  for (const failure of summary.failures) {
    console.error(`    [error] position ${failure.positionId}: ${failure.error}`);
  }
  if (summary.invariantViolations > 0) {
    console.error("  invariant violations were left COMMITTED, needs manual review (see pnpm check-monetary-consistency)");
  }

  if (summary.invariantViolations > 0 || summary.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Settlement run failed:", error instanceof Error ? error.message : error);
  console.error("Any Positions already settled before this failure remain settled — this run never re-settles or reverts a decided Position.");
  process.exit(1);
});
