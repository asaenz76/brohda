import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeSportConfigs, type SportConfig } from "@/lib/sports-data/sport-registry";
import { errorMessage } from "@/lib/utils/error-message";
import { getMarketPolicy } from "@/lib/prediction-markets/market-policy";
import { listUpcomingFixtures } from "./fixture-window";

// Brohda 2.1 M2 — Market EXISTENCE is driven by the Game, not by a sportsbook price.
//
// For every upcoming Game of an active sport (inside the same window sportsbook ingestion already uses for that sport — data in the sport registry, nothing new hard-coded) that has no
// MONEYLINE Market yet, ask the database to insert THE canonical team-winner Market: same identity sportsbook ingestion uses, no price, never a substituted one. Odds that arrive later
// enrich that very row (upsertMarket, by (provider, provider_market_id)); the proposition unique index and the database function's own "no MONEYLINE exists" check make a second row impossible.
// Gated by platform_settings.fixture_markets_enabled (default false): with it off this reads one setting and does nothing.

export interface FixtureMarketEnsureSummary {
  enabled: boolean;
  /** Upcoming Games examined that had no MONEYLINE Market. */
  missing: number;
  created: number;
  failures: Array<{ sport: string; error: string }>;
}

async function ensureForSport(config: SportConfig, now: Date): Promise<{ missing: number; created: number }> {
  const upcoming = await listUpcomingFixtures(config, now);
  if (upcoming.length === 0) return { missing: 0, created: 0 };
  const admin = createAdminClient();
  // One set-based read: which of these Games already have a MONEYLINE Market, in any state (a retired or closed one still counts — never a second).
  const { data, error } = await admin.from("markets").select("fixture_id").in("fixture_id", upcoming.map((f) => f.id)).eq("market_template", "MONEYLINE");
  if (error) throw error;
  const have = new Set((data ?? []).map((m) => m.fixture_id));
  const missingIds = upcoming.filter((f) => !have.has(f.id)).map((f) => f.id);
  if (missingIds.length === 0) return { missing: 0, created: 0 };
  // One set-based write. The function re-validates each Game (exists, not started) and is the concurrency backstop (ON CONFLICT DO NOTHING).
  const { data: created, error: rpcError } = await admin.rpc("ensure_fixture_moneyline_markets", { p_fixture_ids: missingIds });
  if (rpcError) throw rpcError;
  return { missing: missingIds.length, created: ((created ?? []) as string[]).length };
}

export async function ensureFixtureMarkets(env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<FixtureMarketEnsureSummary> {
  const policy = await getMarketPolicy();
  if (!policy.fixtureMarketsEnabled) return { enabled: false, missing: 0, created: 0, failures: [] };
  const summary: FixtureMarketEnsureSummary = { enabled: true, missing: 0, created: 0, failures: [] };
  for (const config of activeSportConfigs(env)) {
    try {
      const r = await ensureForSport(config, now);
      summary.missing += r.missing;
      summary.created += r.created;
    } catch (error) {
      // One sport's failure never blocks the others.
      summary.failures.push({ sport: config.sport, error: errorMessage(error) });
    }
  }
  return summary;
}
