import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R7 §59: whether Call BS is enabled at all — a genuine kill
// switch for a brand-new mechanic, matching post_publication_enabled/
// community_distribution_enabled/market_ingestion_enabled's own
// off-by-default-until-turned-on convention. The authoritative check lives
// inside call_bs() itself (re-read fresh on every call); this is a
// TypeScript-side read for the same reason getPickLockPolicy() exists —
// UI/Server-Action-level presentation, never the actual enforcement.

export async function isCallBsEnabled(): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("call_bs_enabled").eq("id", true).single();
  return data?.call_bs_enabled ?? false;
}
