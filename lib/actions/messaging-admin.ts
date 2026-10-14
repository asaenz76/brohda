"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { MESSAGING_SETTING_FIELDS } from "@/lib/messaging/settings-fields";
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
