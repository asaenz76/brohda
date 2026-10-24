import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARKET_TEMPLATES, parseMarketPolicy, type MarketPolicy } from "./market-policy-parse";

// Brohda 2.1 M2: the four configurable Market/Pick policy settings, read from `platform_settings` (migration 214). The pure parsing — and with it every fail-closed rule —
// lives in ./market-policy-parse.ts so it is unit-testable without a database; this file is only the read.
export { MARKET_TEMPLATES };
export type { MarketPolicy };

export async function getMarketPolicy(): Promise<MarketPolicy> {
  const { data } = await createAdminClient()
    .from("platform_settings")
    .select("fixture_markets_enabled, prediction_require_price, prediction_allowed_templates, market_ingestion_templates")
    .eq("id", true)
    .single();
  return parseMarketPolicy(data);
}
