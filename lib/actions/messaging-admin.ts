"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { MESSAGING_BOOLEAN_FIELDS, MESSAGING_SETTING_FIELDS } from "@/lib/messaging/settings-fields";
import { isUuid } from "@/lib/messaging/share";

export interface MessagingAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}

/** Super Admin: the whole Messaging policy in one audited call (settings.messaging_updated). Policy only — no deploy. Turning the capability OFF hides Messaging at once and keeps every record. */
export async function setMessagingConfigAction(_prev: MessagingAdminResult | null, formData: FormData): Promise<MessagingAdminResult> {
  const admin = await requireSuperAdmin();
  const config: Record<string, number | boolean | null> = { messaging_enabled: formData.get("messaging_enabled") === "on" };
  for (const field of MESSAGING_BOOLEAN_FIELDS) config[field.key] = formData.get(field.key) === "on";
  for (const field of MESSAGING_SETTING_FIELDS) {
    const raw = String(formData.get(field.key) ?? "").trim();
    if (raw === "") {
      if (field.nullable) {
        config[field.key] = null;
        continue;
      }
      return { success: false, error: `${field.label} needs a value.` };
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < field.min || value > field.max) return { success: false, error: `${field.label} must be a whole number from ${field.min} to ${field.max}.` };
    config[field.key] = value;
  }
  const { error } = await createAdminClient().rpc("admin_set_messaging_config", { p_admin_id: admin.id, p_config: config });
  if (error) return { success: false, error: "Couldn't save the Messaging settings." };
  revalidatePath("/admin/settings/brohda");
  revalidatePath("/messages");
  return { success: true, error: null, message: config.messaging_enabled ? "Messaging is on." : "Messaging is off." };
}

/** Super Admin: close a message report. Hiding a message leaves a tombstone for the participants and keeps the evidence on the report. */
export async function resolveMessageReportAction(reportId: string, action: "DISMISS" | "HIDE_MESSAGE" | "ACTION", note: string): Promise<MessagingAdminResult> {
  const admin = await requireSuperAdmin();
  if (!isUuid(reportId) || !["DISMISS", "HIDE_MESSAGE", "ACTION"].includes(action)) return { success: false, error: "That report can't be updated." };
  const { data, error } = await createAdminClient().rpc("admin_messaging_resolve_report", { p_admin_id: admin.id, p_report_id: reportId, p_action: action, p_note: note.slice(0, 1000) });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || outcome === "not_found") return { success: false, error: "That report can't be updated." };
  if (outcome === "already_resolved") return { success: false, error: "That report was already resolved." };
  if (outcome === "no_message") return { success: false, error: "This report is about the whole conversation, so there is no single message to hide." };
  revalidatePath("/admin/moderation");
  return { success: true, error: null, message: "Report updated." };
}

const HOLD_REASONS = ["ABUSE_INVESTIGATION", "MODERATION_CASE", "LEGAL_OBLIGATION"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

function adminError(error: string): MessagingAdminResult {
  return { success: false, error };
}

/**
 * Super Admin: place a narrowly scoped retention hold. The scope is ONE message, ONE report (its record, evidence and reported message) or a bounded run of messages in one conversation — there is no
 * Member-wide or conversation-wide hold, so unrelated history is never frozen. A note is required and the placement is audited.
 */
export async function placeRetentionHoldAction(input: {
  reason: HoldReason;
  scope: "MESSAGE" | "REPORT" | "CONVERSATION_RANGE";
  messageId?: string | null;
  reportId?: string | null;
  conversationId?: string | null;
  seqFrom?: number | null;
  seqTo?: number | null;
  note: string;
}): Promise<MessagingAdminResult> {
  const admin = await requireSuperAdmin();
  if (!HOLD_REASONS.includes(input.reason) || !["MESSAGE", "REPORT", "CONVERSATION_RANGE"].includes(input.scope)) return adminError("That hold isn't valid.");
  for (const id of [input.messageId, input.reportId, input.conversationId]) if (id && !isUuid(id)) return adminError("That hold isn't valid.");
  const { data, error } = await createAdminClient().rpc("admin_messaging_place_hold", {
    p_admin_id: admin.id,
    p_reason: input.reason,
    p_scope: input.scope,
    p_message_id: input.messageId ?? null,
    p_report_id: input.reportId ?? null,
    p_conversation_id: input.conversationId ?? null,
    p_seq_from: input.seqFrom ?? null,
    p_seq_to: input.seqTo ?? null,
    p_note: String(input.note ?? "").slice(0, 1000),
  });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || !outcome) return adminError("Couldn't place the hold.");
  if (outcome === "note_required") return adminError("Add a short note saying why.");
  if (outcome === "not_found") return adminError("That item couldn't be found.");
  if (outcome === "already_held") return adminError("That is already on hold.");
  if (outcome === "invalid_range" || outcome === "range_too_wide") return adminError("Choose a range of at most 200 messages inside the conversation.");
  if (outcome !== "held") return adminError("Couldn't place the hold.");
  revalidatePath("/admin/moderation");
  return { success: true, error: null, message: "Hold placed." };
}

export async function releaseRetentionHoldAction(holdId: string, note: string): Promise<MessagingAdminResult> {
  const admin = await requireSuperAdmin();
  if (!isUuid(holdId)) return adminError("That hold can't be released.");
  const { data, error } = await createAdminClient().rpc("admin_messaging_release_hold", { p_admin_id: admin.id, p_hold_id: holdId, p_note: String(note ?? "").slice(0, 1000) });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || outcome === "not_found") return adminError("That hold can't be released.");
  if (outcome === "already_released") return adminError("That hold was already released.");
  revalidatePath("/admin/moderation");
  return { success: true, error: null, message: "Hold released." };
}

/** Super Admin: close an abuse signal (reviewed / dismissed / actioned). */
export async function resolveAbuseSignalAction(signalId: string, action: "REVIEW" | "DISMISS" | "ACTION", note: string): Promise<MessagingAdminResult> {
  const admin = await requireSuperAdmin();
  if (!isUuid(signalId) || !["REVIEW", "DISMISS", "ACTION"].includes(action)) return adminError("That signal can't be updated.");
  const { data, error } = await createAdminClient().rpc("admin_messaging_resolve_signal", { p_admin_id: admin.id, p_signal_id: signalId, p_action: action, p_note: String(note ?? "").slice(0, 1000) });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || outcome === "not_found") return adminError("That signal can't be updated.");
  if (outcome === "already_resolved") return adminError("That signal was already resolved.");
  revalidatePath("/admin/moderation");
  return { success: true, error: null, message: "Signal updated." };
}

/** Super Admin: lift an automatic temporary restriction early. */
export async function liftRestrictionAction(restrictionId: string, note: string): Promise<MessagingAdminResult> {
  const admin = await requireSuperAdmin();
  if (!isUuid(restrictionId)) return adminError("That restriction can't be lifted.");
  const { data, error } = await createAdminClient().rpc("admin_messaging_lift_restriction", { p_admin_id: admin.id, p_restriction_id: restrictionId, p_note: String(note ?? "").slice(0, 1000) });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || outcome === "not_found") return adminError("That restriction can't be lifted.");
  if (outcome === "already_lifted") return adminError("That restriction was already lifted.");
  revalidatePath("/admin/moderation");
  return { success: true, error: null, message: "Restriction lifted." };
}
