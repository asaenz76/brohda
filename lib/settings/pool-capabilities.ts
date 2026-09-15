import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Global entry-time kill switches (FREE_MODE_ARCHITECTURE_PROPOSAL.md §5) —
 * the read-side counterpart to setPlatformPoolCapabilityAction. This is a
 * UX-layer read only: the authoritative, fail-closed check lives inside
 * create_pool_entry itself (re-read fresh on every entry, §7), not here —
 * a caller of this function is never the security boundary for the
 * capability it reports. Defaults to `true` for both if the singleton row
 * can't be read at all, matching this page's own display purpose (an admin
 * settings page failing to load its state shouldn't itself look like an
 * outage); the RPC's own fail-closed behavior is unaffected by this
 * default either way. */
export async function getPlatformPoolCapabilities(): Promise<{
  paidPoolsEnabled: boolean;
  freePoolsEnabled: boolean;
}> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("platform_settings")
    .select("paid_pools_enabled, free_pools_enabled")
    .eq("id", true)
    .single();

  return {
    paidPoolsEnabled: data?.paid_pools_enabled ?? true,
    freePoolsEnabled: data?.free_pools_enabled ?? true,
  };
}
