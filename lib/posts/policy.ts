import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PostPublicationPolicy } from "./types";

// Milestone R3: fail CLOSED, matching lib/prediction-markets/ingestion/
// policy.ts's own reasoning exactly — this gates a write-side action
// (should the automatic publication job publish anything), so an
// unreadable settings row must never be treated as implicit permission.
const FAIL_CLOSED_POLICY: PostPublicationPolicy = { enabled: false, requiresActiveMarket: true, primaryMarketTemplatePriority: ["MONEYLINE", "TOTAL", "SPREAD"] };

export async function getPostPublicationPolicy(): Promise<PostPublicationPolicy> {
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("post_publication_enabled, post_publication_requires_active_market, post_primary_market_template_priority").eq("id", true).single();

  if (!data) return FAIL_CLOSED_POLICY;
  return {
    enabled: data.post_publication_enabled ?? false,
    requiresActiveMarket: data.post_publication_requires_active_market ?? true,
    primaryMarketTemplatePriority: data.post_primary_market_template_priority ?? FAIL_CLOSED_POLICY.primaryMarketTemplatePriority,
  };
}
