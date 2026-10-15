"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/messaging/share";
import { INT4_MAX, isValidStakeLadder, parseStakeLadder } from "@/lib/confidence/format";

export interface ConfidenceAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}

const fail = (error: string): ConfidenceAdminResult => ({ success: false, error });

/** Super Admin: the Confidence policy in one audited call (settings.confidence_updated). Validated as a whole — nothing is partially applied — and changing the baseline never rewrites a balance. */
export async function setConfidenceConfigAction(_prev: ConfidenceAdminResult | null, formData: FormData): Promise<ConfidenceAdminResult> {
  const admin = await requireSuperAdmin();
  const number = (key: string) => (String(formData.get(key) ?? "").trim() === "" ? NaN : Number(formData.get(key)));
  const baseline = number("confidence_baseline");
  const amount = number("confidence_daily_claim_amount");
  const interval = number("confidence_daily_claim_interval_hours");
  const stakes = parseStakeLadder(String(formData.get("confidence_allowed_stakes") ?? ""));
  if (!Number.isInteger(baseline) || baseline < 1 || baseline > INT4_MAX) return fail("Baseline must be a whole number of at least 1.");
  if (!Number.isInteger(amount) || amount < 1 || amount > 5) return fail("Daily Claim must be a whole number from 1 to 5.");
  if (amount > baseline) return fail("Daily Claim can't be larger than the baseline.");
  if (!Number.isInteger(interval) || interval < 1 || interval > INT4_MAX) return fail("The Daily Claim interval must be a whole number of hours, at least 1.");
  if (!stakes || !isValidStakeLadder(stakes)) return fail("The stake ladder must be increasing whole numbers of at least 1, like 1, 2, 3, 4, 5.");
  const enabled = formData.get("confidence_enabled") === "on";
  const { error } = await createAdminClient().rpc("admin_set_confidence_config", {
    p_admin_id: admin.id,
    p_config: { confidence_enabled: enabled, confidence_baseline: baseline, confidence_daily_claim_amount: amount, confidence_daily_claim_interval_hours: interval, confidence_allowed_stakes: stakes },
  });
  if (error) return fail("Couldn't save the Confidence settings.");
  revalidatePath("/admin/settings/brohda");
  revalidatePath("/admin/confidence");
  revalidatePath("/profile");
  return { success: true, error: null, message: enabled ? "Confidence is on." : "Confidence is off." };
}

/** Super Admin: a signed correction to one Member's available Confidence, as a new ledger entry. A reason and a note are required; the result can never be negative; history is never overwritten. */
export async function adjustConfidenceAction(input: { memberId: string; amount: number; reasonCode: string; note: string; idempotencyKey: string }): Promise<ConfidenceAdminResult> {
  const admin = await requireSuperAdmin();
  if (!isUuid(input.memberId) || !Number.isInteger(input.amount) || input.amount === 0) return fail("Enter a whole number other than 0.");
  const { data, error } = await createAdminClient().rpc("admin_confidence_adjust", {
    p_admin_id: admin.id, p_member_id: input.memberId, p_amount: input.amount, p_reason_code: input.reasonCode, p_note: String(input.note ?? "").slice(0, 500), p_idempotency_key: input.idempotencyKey,
  });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || !outcome) return fail("Couldn't record the adjustment.");
  if (outcome === "note_required") return fail("Add a short note saying why.");
  if (outcome === "invalid_amount") return fail("The amount must be a whole number other than 0.");
  if (outcome === "no_account") return fail("That Member has no Confidence account yet.");
  if (outcome === "would_go_negative") return fail("That would take the Member below 0.");
  if (outcome !== "adjusted") return fail("Couldn't record the adjustment.");
  revalidatePath("/admin/confidence");
  return { success: true, error: null, message: "Adjustment recorded." };
}

/** Super Admin: undo one ledger entry with a compensating entry. An entry can be reversed once, a reversal can't be reversed, and the result can never be negative. */
export async function reverseConfidenceEntryAction(entryId: string, note: string, idempotencyKey: string): Promise<ConfidenceAdminResult> {
  const admin = await requireSuperAdmin();
  if (!isUuid(entryId)) return fail("That entry can't be reversed.");
  const { data, error } = await createAdminClient().rpc("admin_confidence_reverse", { p_admin_id: admin.id, p_entry_id: entryId, p_note: String(note ?? "").slice(0, 500), p_idempotency_key: idempotencyKey });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || !outcome || outcome === "not_found") return fail("That entry can't be reversed.");
  if (outcome === "note_required") return fail("Add a short note saying why.");
  if (outcome === "already_reversed") return fail("That entry was already reversed.");
  if (outcome === "cannot_reverse_a_reversal") return fail("A reversal can't be reversed. Record a new adjustment instead.");
  if (outcome === "would_go_negative") return fail("Reversing that would take the Member below 0.");
  if (outcome !== "reversed") return fail("That entry can't be reversed.");
  revalidatePath("/admin/confidence");
  return { success: true, error: null, message: "Entry reversed." };
}
