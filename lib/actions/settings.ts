"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";

export type SetRegistrationEnabledResult = { success: boolean; error: string | null };

/** Global, super_admin-only switch — flips whether /register creates
 * accounts or just shows a "closed" message. Mirrors the
 * setFixturesHiddenAction pattern: service-role update + audit log, no
 * client-facing write policy on the table itself. */
export async function setRegistrationEnabledAction(
  enabled: boolean,
): Promise<SetRegistrationEnabledResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from("platform_settings")
    .update({
      registration_enabled: enabled,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    })
    .eq("id", true);

  if (error) {
    return { success: false, error: "Could not update this setting." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: enabled ? "settings.registration_enabled" : "settings.registration_disabled",
    entityType: "platform_settings",
    entityId: null,
    after: { registrationEnabled: enabled },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/login");
  revalidatePath("/register");
  return { success: true, error: null };
}
