import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfidenceConfig } from "./config";

// Reads for Confidence. A Member's own account and history are read AS that Member (the RLS client), so the database policies decide what they can see; the public balance is read server-side and exposes
// ONLY the total. Nothing here writes except the idempotent bootstrap. No payment, wallet or monetary code is imported anywhere in this domain.

export interface MyConfidence {
  available: number;
  reserved: number;
  total: number;
  baseline: number;
  /** Is a Daily Claim possible right now? (below baseline AND the rolling interval has passed) */
  canClaim: boolean;
  /** What the next claim would add (capped at the gap to the baseline), or 0 when the Member is at or above the baseline. */
  claimAmount: number;
  /** When the next claim opens, computed from the last successful claim — null when one is not waiting on the clock. */
  nextClaimAt: string | null;
  /** True when at or above the baseline, so there is nothing to claim and no CTA. */
  atOrAboveBaseline: boolean;
}

/** The signed-in Member's own Confidence, or null while the capability is OFF (or they are not eligible). Creates the account on first look (idempotent, race-safe), so nobody waits for the backfill. */
export async function getMyConfidence(memberId: string): Promise<MyConfidence | null> {
  const config = await getConfidenceConfig();
  if (!config) return null;
  const supabase = await createClient();
  let { data: account } = await supabase.from("confidence_accounts").select("available, reserved, total, last_daily_claim_at").eq("member_id", memberId).maybeSingle();
  if (!account) {
    const admin = createAdminClient();
    await admin.rpc("confidence_bootstrap_member", { p_member_id: memberId });
    // Read the new account with a DIFFERENT request than the first look: Next de-duplicates identical GETs within one render, so repeating the same query would return the first (empty) answer. This is the
    // authenticated Member's own account (memberId comes from their session), read once, right after it was created.
    ({ data: account } = await admin.from("confidence_accounts").select("available, reserved, total, last_daily_claim_at").eq("member_id", memberId).maybeSingle());
    if (!account) return null;
  }
  const available = Number(account.available);
  const nextAt = account.last_daily_claim_at ? new Date(new Date(account.last_daily_claim_at).getTime() + config.dailyClaimIntervalHours * 3_600_000) : null;
  const waiting = nextAt !== null && nextAt.getTime() > Date.now();
  const atOrAbove = available >= config.baseline;
  const canClaim = !atOrAbove && !waiting;
  return {
    available,
    reserved: Number(account.reserved),
    total: Number(account.total),
    baseline: config.baseline,
    canClaim,
    claimAmount: atOrAbove ? 0 : Math.min(config.dailyClaimAmount, config.baseline - available),
    nextClaimAt: !atOrAbove && waiting && nextAt ? nextAt.toISOString() : null,
    atOrAboveBaseline: atOrAbove,
  };
}

/** A Member's PUBLIC Confidence: the current total, nothing else. Null while the capability is OFF, for a Member with no account, and for any account that is no longer eligible. */
export async function getPublicConfidence(memberId: string): Promise<number | null> {
  if (!(await getConfidenceConfig())) return null;
  const admin = createAdminClient();
  const { data: eligible } = await admin.rpc("confidence_member_eligible", { p_member_id: memberId });
  if (eligible !== true) return null;
  const { data } = await admin.from("confidence_accounts").select("total").eq("member_id", memberId).maybeSingle();
  return data ? Number(data.total) : null;
}

export interface ConfidenceHistoryRow {
  id: string;
  entryType: string;
  delta: number;
  balanceAfter: number;
  createdAt: string;
}

/** The signed-in Member's own history, newest first, read through RLS with only the non-sensitive columns (no admin note, actor, reason code or metadata is ever granted to a Member). */
export async function getMyConfidenceHistory(limit = 50): Promise<ConfidenceHistoryRow[]> {
  if (!(await getConfidenceConfig())) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("confidence_ledger_entries")
    .select("id, entry_type, available_delta, reserved_delta, available_after, reserved_after, created_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return (data ?? []).map((r) => ({
    id: r.id,
    entryType: r.entry_type,
    delta: Number(r.available_delta) + Number(r.reserved_delta),
    balanceAfter: Number(r.available_after) + Number(r.reserved_after),
    createdAt: r.created_at,
  }));
}
