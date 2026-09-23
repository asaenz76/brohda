/**
 * Manual/developer entrypoint for the monetary proposal/Position
 * consistency check (docs/BROHDA_2_0_MILESTONE_MAP.md, Milestone R9, §72).
 * Read-only — never writes anything, mirroring
 * scripts/check-wallet-reservations.ts exactly. Safe to run against any
 * environment, including production, at any time.
 *
 * Usage: pnpm check-monetary-consistency
 */
import { checkMonetaryConsistency } from "../lib/monetary/reconciliation";

async function main() {
  console.log("Checking monetary proposal/Position consistency...");

  const report = await checkMonetaryConsistency();

  console.log(`\nChecked ${report.checkedProposals} proposals and ${report.checkedPositions} positions.`);

  if (report.anomalies.length === 0) {
    console.log("No anomalies found.");
    return;
  }

  console.error(`\n${report.anomalies.length} anomalies found:`);
  for (const anomaly of report.anomalies) {
    console.error(`  [${anomaly.kind}] proposal=${anomaly.proposalId ?? "?"} position=${anomaly.positionId ?? "?"} — ${anomaly.detail}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("Monetary consistency check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
