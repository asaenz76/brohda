import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { UNKNOWN_RULES_POLICY, type RulesPolicy } from "./format";

/**
 * The live, user-facing policy values the Rules page quotes, read from
 * platform_settings in ONE query so the page never carries a copy of a
 * number that can change (the Pick cutoff, the platform fee, the stake
 * limits) or of an on/off switch.
 *
 * Why not the existing per-value helpers (getPickLockPolicy, getP2pFeeBps,
 * isMonetaryP2pEnabled)? Those are built for enforcement and presentation
 * in context and each fails in its own way — one returns a built-in default,
 * one returns 0, one returns false — which is right for them but would
 * make this page state "0%" or "10 minutes" it never read. Here an
 * unreadable or implausible value becomes null, and the page uses generic
 * wording instead. The columns are the same ones those helpers read, and
 * the database functions remain the authority on every rule.
 */
const asNonNegativeInt = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};
const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

export async function getRulesPolicy(): Promise<RulesPolicy> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("platform_settings")
      .select("pick_lock_minutes_before_kickoff, p2p_fee_bps, monetary_p2p_min_stake_cents, monetary_p2p_max_stake_cents, monetary_p2p_enabled, call_bs_enabled")
      .eq("id", true)
      .single();
    if (error || !data) return UNKNOWN_RULES_POLICY;

    const min = asNonNegativeInt(data.monetary_p2p_min_stake_cents);
    const max = asNonNegativeInt(data.monetary_p2p_max_stake_cents);
    const limitsUsable = min !== null && max !== null && max >= min;
    return {
      lockMinutesBeforeKickoff: asNonNegativeInt(data.pick_lock_minutes_before_kickoff),
      feeBps: asNonNegativeInt(data.p2p_fee_bps),
      minStakeCents: limitsUsable ? min : null,
      maxStakeCents: limitsUsable ? max : null,
      monetaryEnabled: asBoolean(data.monetary_p2p_enabled),
      callBsEnabled: asBoolean(data.call_bs_enabled),
    };
  } catch {
    return UNKNOWN_RULES_POLICY;
  }
}
