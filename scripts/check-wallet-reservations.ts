/**
 * Manual/developer entrypoint for the wallet reservation consistency check
 * (docs/BROHDA_2_0_MILESTONE_MAP.md, Milestone R8, §45). Read-only — never
 * writes anything, so unlike scripts/grade-predictions.ts and
 * scripts/resolve-challenges.ts this does NOT need the production-write
 * guard (there is nothing here for it to protect against). Safe to run
 * against any environment, including production, at any time.
 *
 * Usage: pnpm check-wallet-reservations
 */
import { checkWalletReservationConsistency } from "../lib/wallet/reconciliation";

async function main() {
  console.log("Checking wallet reservation consistency...");

  const report = await checkWalletReservationConsistency();

  console.log(`\nChecked ${report.checkedWallets} user wallets and ${report.checkedReservations} reservations.`);

  if (report.anomalies.length === 0) {
    console.log("No anomalies found.");
    return;
  }

  console.error(`\n${report.anomalies.length} anomalies found:`);
  for (const anomaly of report.anomalies) {
    console.error(`  [${anomaly.kind}] user=${anomaly.userId ?? "?"} — ${anomaly.detail}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("Reservation consistency check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
