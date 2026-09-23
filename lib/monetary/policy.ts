import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R9 §60-61: whether direct monetary P2P (proposals + acceptance)
// is enabled at all — off by default, mirroring call_bs_enabled's own
// convention (lib/challenges/policy.ts). The authoritative check lives
// inside propose_money() AND accept_monetary_proposal() themselves (both
// gated, unlike R7's narrower call_bs()-only gate — acceptance itself
// creates a new economic commitment); this is the TypeScript-side read for
// UI/Server-Action-level presentation only.

export async function isMonetaryP2pEnabled(): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("monetary_p2p_enabled").eq("id", true).single();
  return data?.monetary_p2p_enabled ?? false;
}
