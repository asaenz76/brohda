import "server-only";
import { runSportFixtureSync, type SportSyncResult } from "./sync-fixtures";
import { getSportConfig } from "./sport-registry";

// The NFL's fixture sync is now one row of the shared sport registry run through the shared sync (./sync-fixtures.ts) — nothing about its
// behaviour changed. This module keeps the original entry point and result type for the callers and tests that already use them.
export type NflSyncResult = SportSyncResult;

export async function runNflFixtureSync(): Promise<NflSyncResult> {
  const config = getSportConfig("american_football");
  if (!config) throw new Error("NFL sport config missing from the sport registry");
  return runSportFixtureSync(config);
}
