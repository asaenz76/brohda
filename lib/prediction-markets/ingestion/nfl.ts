import "server-only";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import {
  ingestMarketsForFixture,
  runSportMarketIngestion,
  type EligibleFixture,
  type FixtureIngestionOutcome,
  type MarketIngestionSummary,
} from "./sports";

// The NFL's Market ingestion entry points. The pipeline itself is shared by every sport (./sports.ts, driven by lib/sports-data/sport-registry.ts);
// the NFL is one row of that registry and its behaviour is unchanged. This module keeps the original names for the callers and tests that use them.
export type { EligibleFixture, FixtureIngestionOutcome, MarketIngestionSummary };

function nflConfig() {
  const config = getSportConfig("american_football");
  if (!config) throw new Error("NFL sport config missing from the sport registry");
  return config;
}

export function ingestNflMarketsForFixture(fixture: EligibleFixture, minBookmakerCount: number): Promise<FixtureIngestionOutcome> {
  return ingestMarketsForFixture(nflConfig(), fixture, minBookmakerCount);
}

export function runNflMarketIngestion(): Promise<MarketIngestionSummary> {
  return runSportMarketIngestion(nflConfig());
}
