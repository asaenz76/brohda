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
  const backedPicksEnabled = formData.get("confidence_backed_picks_enabled") === "on";
  const mandatory = formData.get("confidence_mandatory") === "on";
  if (mandatory && (!enabled || !backedPicksEnabled)) return fail("Turn on Confidence and predictions before enforcing Confidence on every Pick.");
  const copy: Record<string, string> = {};
  for (const [key, label] of [["confidence_notify_correct", "correct"], ["confidence_notify_incorrect", "incorrect"], ["confidence_notify_void", "void"]] as const) {
    const text = String(formData.get(key) ?? "").trim();
    if (text.length < 1 || text.length > 200) return fail(`The ${label} result sentence must be 1 to 200 characters.`);
    if (!text.includes("{{amount}}")) return fail(`The ${label} result sentence must include {{amount}} so it says how much.`);
    copy[key] = text;
  }
  const { error } = await createAdminClient().rpc("admin_set_confidence_config", {
    p_admin_id: admin.id,
    p_config: { confidence_enabled: enabled, confidence_backed_picks_enabled: backedPicksEnabled, ...(mandatory ? { confidence_mandatory: true } : {}), ...copy, confidence_baseline: baseline, confidence_daily_claim_amount: amount, confidence_daily_claim_interval_hours: interval, confidence_allowed_stakes: stakes },
  });
  if (error?.message.includes("cutover_is_permanent")) return fail("The rule that no Pick can exist without Confidence is permanent. It can't be turned off from Settings.");
  if (error?.message.includes("mandatory_requires_predictions_on")) return fail("Turn on Confidence and predictions before making the rule permanent.");
  if (error) return fail("Couldn't save the Confidence settings.");
  revalidatePath("/admin/settings/brohda");
  revalidatePath("/admin/confidence");
  revalidatePath("/profile");
  return { success: true, error: null, message: !enabled ? "Confidence is off." : backedPicksEnabled ? "Confidence is on, and Members can make predictions." : "Confidence is on." };
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
  if (outcome === "prediction_entry") return fail("Confidence behind a pick is settled by the pick's result and can't be reversed by hand.");
  if (outcome !== "reversed") return fail("That entry can't be reversed.");
  revalidatePath("/admin/confidence");
  return { success: true, error: null, message: "Entry reversed." };
}

/**
 * Super Admin: Brohda 2.1 optional Picks — a Pick may exist without Confidence (editable until T-10; attaching Confidence locks the team and fixes the amount). Audited, idempotent, and reversible: turning it
 * off makes new Picks need Confidence again and rewrites nothing. The very first activation is stamped once and kept (it separates mandatory-era from optional-era Picks).
 */
export async function setConfidenceOptionalPicksAction(enabled: boolean): Promise<ConfidenceAdminResult> {
  const admin = await requireSuperAdmin();
  const { error } = await createAdminClient().rpc("admin_set_confidence_optional_picks", { p_admin_id: admin.id, p_enabled: enabled });
  if (error?.message.includes("optional_picks_requires_confidence_on")) return fail("Turn on Confidence and predictions before allowing Picks without Confidence.");
  if (error) return fail("Couldn't save that setting.");
  revalidatePath("/admin/confidence");
  revalidatePath("/admin/settings/brohda");
  return { success: true, error: null, message: enabled ? "Members can make a Pick without Confidence." : "Every new Pick needs Confidence again." };
}

/** Super Admin: the two-step composer (choose a team, then optionally Confidence). A display flag only: it changes what Members see, never what the database allows. */
export async function setConfidenceTwoStepComposerAction(enabled: boolean): Promise<ConfidenceAdminResult> {
  const admin = await requireSuperAdmin();
  const { error } = await createAdminClient().rpc("admin_set_confidence_two_step_composer", { p_admin_id: admin.id, p_enabled: enabled });
  if (error) return fail("Couldn't save that setting.");
  revalidatePath("/admin/confidence");
  return { success: true, error: null, message: enabled ? "The two-step composer is on." : "The one-step composer is back." };
}
