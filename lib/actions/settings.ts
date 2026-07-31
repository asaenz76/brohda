"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { parseDollarsToCents, parsePercentToBps } from "@/lib/utils/money";

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

export type SetPoolFeeDefaultsResult = { success: boolean; error: string | null };

/** Org-wide entry fee / platform fee defaults pre-filled into the pool
 * creation form. Same service-role-update + audit-log shape as
 * setRegistrationEnabledAction. */
export async function setPoolFeeDefaultsAction(
  entryFeeDollars: string,
  houseFeePercent: string,
): Promise<SetPoolFeeDefaultsResult> {
  const admin = await requireSuperAdmin();

  const entryFeeCents = parseDollarsToCents(entryFeeDollars);
  const houseFeeBps = parsePercentToBps(houseFeePercent);
  if (entryFeeCents == null || houseFeeBps == null) {
    return { success: false, error: "Enter a valid entry fee and platform fee." };
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from("platform_settings")
    .update({
      default_entry_fee_cents: entryFeeCents,
      default_house_fee_bps: houseFeeBps,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    })
    .eq("id", true);

  if (error) {
    return { success: false, error: "Could not update these defaults." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "settings.pool_fee_defaults_updated",
    entityType: "platform_settings",
    entityId: null,
    after: { entryFeeCents, houseFeeBps },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/admin/pools/new");
  return { success: true, error: null };
}
