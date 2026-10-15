"use server";

import { revalidatePath } from "next/cache";
import { requireMemberAccount } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfidenceConfig } from "@/lib/confidence/config";
import { formatSignedConfidence, formatWait } from "@/lib/confidence/format";

// The Member's Daily Claim. The server derives WHO is claiming from the authenticated session — a client-supplied Member is never accepted — and the database function does every check atomically
// (capability, eligibility, below the baseline, the rolling interval, the capped amount, the ledger entry). The idempotency key makes a retried request return the first result instead of a second claim.

export interface ClaimResult {
  ok: boolean;
  outcome: string;
  message: string;
  /** The Member's Confidence after a successful claim. */
  total?: number;
  nextClaimAt?: string | null;
}

export async function claimDailyConfidenceAction(idempotencyKey: string): Promise<ClaimResult> {
  const user = await requireMemberAccount();
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 100) return { ok: false, outcome: "error", message: "Something went wrong. Try again." };
  // Fail closed in the action as well as in the database, so a direct call while the capability is OFF is refused outright.
  if (!(await getConfidenceConfig())) return { ok: false, outcome: "disabled", message: "That isn't available right now." };
  const { data, error } = await createAdminClient().rpc("confidence_daily_claim", { p_member_id: user.id, p_idempotency_key: idempotencyKey });
  if (error || !data) return { ok: false, outcome: "error", message: "Something went wrong. Try again." };
  const row = data as { outcome: string; amount?: number; total?: number; nextAvailableAt?: string };
  revalidatePath("/profile");
  switch (row.outcome) {
    case "claimed":
      return { ok: true, outcome: "claimed", message: `Claimed ${formatSignedConfidence(row.amount ?? 0)}`, total: row.total, nextClaimAt: row.nextAvailableAt ?? null };
    case "too_soon":
      return { ok: false, outcome: "too_soon", message: `Your next Daily Claim opens in ${formatWait(new Date(row.nextAvailableAt ?? 0).getTime() - Date.now())}.`, nextClaimAt: row.nextAvailableAt ?? null };
    case "at_or_above_baseline":
      return { ok: false, outcome: "at_or_above_baseline", message: "You're already at full Confidence." };
    default:
      return { ok: false, outcome: row.outcome, message: "That isn't available right now." };
  }
}
