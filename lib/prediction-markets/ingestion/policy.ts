import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R2 (docs/BROHDA_2_0_MILESTONE_MAP.md, Sports Market Ingestion):
// configurable ingestion policy, read from `platform_settings`
// (20260101000149_market_ingestion_policy.sql). Fail CLOSED, deliberately
// unlike lib/predictions/policy.ts's fail-open convention: that module
// governs ordinary read-side eligibility (should a Prediction be allowed),
// this one gates a write-side action (should ingestion create/update
// canonical Markets at all) — an unreadable settings row must never be
// treated as implicit permission to write.

export interface MarketIngestionPolicy {
  enabled: boolean;
  minBookmakerCount: number;
}

const FAIL_CLOSED_POLICY: MarketIngestionPolicy = { enabled: false, minBookmakerCount: 2 };

export async function getMarketIngestionPolicy(): Promise<MarketIngestionPolicy> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("platform_settings").select("market_ingestion_enabled, market_ingestion_min_bookmaker_count").eq("id", true).single();

  if (!data) return FAIL_CLOSED_POLICY;
  return {
    enabled: data.market_ingestion_enabled ?? false,
    minBookmakerCount: data.market_ingestion_min_bookmaker_count ?? FAIL_CLOSED_POLICY.minBookmakerCount,
  };
}
