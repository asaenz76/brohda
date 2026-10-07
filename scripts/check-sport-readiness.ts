/**
 * Repeatable readiness check for one sport on the shared architecture — one of PASS / FAIL / DISABLED / PROVIDER_INVENTORY_UNAVAILABLE / PROOF_PENDING per item and one overall verdict. Exit code 1 ONLY when the platform is BROKEN (a provider that has not published odds, or proof that cannot exist yet, is reported plainly but is not a failure). Read-only (database
 * reads only: no provider calls, no writes), so it is safe against any environment, including production, at any time.
 *
 * Usage:  pnpm check-sport-readiness nhl      (or: nba | nfl)
 *         pnpm check-sport-readiness nba --json
 *
 * Before a season opens, run it and fix whatever FAILs; PROVIDER_INVENTORY_UNAVAILABLE / PROOF_PENDING resolve themselves once the provider publishes and the first Games complete. The checks are the same for every
 * sport — the expectations (league, franchise count, odds window) come from lib/sports-data/sport-registry.ts.
 */
import { evaluateReadiness, formatReadiness, overallVerdict } from "../lib/sports-data/readiness";
import { loadReadinessSnapshot } from "../lib/sports-data/readiness-loader";
import { SPORT_CONFIGS } from "../lib/sports-data/sport-registry";

async function main() {
  const args = process.argv.slice(2);
  const token = args.find((a) => !a.startsWith("--"))?.toLowerCase();
  const config = SPORT_CONFIGS.find((c) => c.label.toLowerCase() === token || c.sport === token);
  if (!config) {
    console.error(`Usage: pnpm check-sport-readiness <${SPORT_CONFIGS.map((c) => c.label.toLowerCase()).join("|")}> [--json]`);
    process.exit(2);
  }
  const items = evaluateReadiness(await loadReadinessSnapshot(config));
  const verdict = overallVerdict(items);
  if (args.includes("--json")) console.log(JSON.stringify({ sport: config.sport, label: config.label, verdict, ready: verdict === "HEALTHY", items }, null, 2));
  else console.log(formatReadiness(config, items));
  if (verdict === "BROKEN") process.exitCode = 1;
}

main().catch((error) => {
  console.error("Readiness check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
