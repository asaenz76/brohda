import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface PoolFeeDefaults {
  entryFeeCents: number;
  houseFeeBps: number;
}

const FALLBACK: PoolFeeDefaults = { entryFeeCents: 500, houseFeeBps: 500 };

/** Org-wide default entry fee / platform fee, pre-filled into the pool
 * creation form so a super admin isn't retyping "5.00"/"5" on every single
 * pool. Editable from /admin/settings; falls back to the same values the
 * column defaults to if the row is somehow missing. */
export async function getPoolFeeDefaults(): Promise<PoolFeeDefaults> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("platform_settings")
    .select("default_entry_fee_cents, default_house_fee_bps")
    .eq("id", true)
    .single();

  if (!data) return FALLBACK;
  return {
    entryFeeCents: data.default_entry_fee_cents as number,
    houseFeeBps: data.default_house_fee_bps as number,
  };
}
