"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { parseDollarsToCents, parsePercentToBps } from "@/lib/utils/money";

const TIER_DEFAULTS_COUNT = 5;

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

export type SetPlatformPoolCapabilityResult = { success: boolean; error: string | null };

/** Global entry-time kill switches (FREE_MODE_ARCHITECTURE_PROPOSAL.md §5) —
 * paid_pools_enabled/free_pools_enabled, each independently toggleable.
 * Same service-role-update + audit-log shape as setRegistrationEnabledAction,
 * but improves on that precedent by recording `before` as well as `after`
 * (§5.5). Turning a capability off blocks NEW entries of that mode from
 * this moment forward — create_pool_entry re-checks the flag itself, fail-
 * closed, on every call (§7); it does not touch any existing pool or entry.
 */
export async function setPlatformPoolCapabilityAction(
  capability: "paid" | "free",
  enabled: boolean,
): Promise<SetPlatformPoolCapabilityResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();
  const column = capability === "paid" ? "paid_pools_enabled" : "free_pools_enabled";

  const { data: current } = await adminClient.from("platform_settings").select(column).eq("id", true).single();
  const previousValue = (current as Record<string, boolean> | null)?.[column] ?? null;

  const { error } = await adminClient
    .from("platform_settings")
    .update({
      [column]: enabled,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    })
    .eq("id", true);

  if (error) {
    return { success: false, error: "Could not update this setting." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: `settings.${column}_changed`,
    entityType: "platform_settings",
    entityId: null,
    before: { [column]: previousValue },
    after: { [column]: enabled },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/admin/pools/new");
  return { success: true, error: null };
}

export type SetPoolFeeDefaultsResult = { success: boolean; error: string | null };

/** Org-wide entry fee / platform fee defaults pre-filled into the pool
 * creation form, plus the five default amounts pre-filled into TierFeeInputs
 * when an admin picks "Tiered" (see 20260101000123). Same service-role-update
 * + audit-log shape as setRegistrationEnabledAction. */
export async function setPoolFeeDefaultsAction(
  entryFeeDollars: string,
  houseFeePercent: string,
  tierEntryFeesDollars: string[],
): Promise<SetPoolFeeDefaultsResult> {
  const admin = await requireSuperAdmin();

  const entryFeeCents = parseDollarsToCents(entryFeeDollars);
  const houseFeeBps = parsePercentToBps(houseFeePercent);
  if (entryFeeCents == null || houseFeeBps == null) {
    return { success: false, error: "Enter a valid entry fee and platform fee." };
  }

  if (tierEntryFeesDollars.length !== TIER_DEFAULTS_COUNT) {
    return { success: false, error: `Enter exactly ${TIER_DEFAULTS_COUNT} default tier amounts.` };
  }
  const tierEntryFeesCents = tierEntryFeesDollars.map(parseDollarsToCents);
  if (tierEntryFeesCents.some((cents) => cents == null)) {
    return { success: false, error: "Enter a valid amount for every default tier." };
  }
  if (new Set(tierEntryFeesCents).size !== tierEntryFeesCents.length) {
    return { success: false, error: "Default tier amounts must be unique." };
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from("platform_settings")
    .update({
      default_entry_fee_cents: entryFeeCents,
      default_house_fee_bps: houseFeeBps,
      default_tier_entry_fees_cents: tierEntryFeesCents,
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
    after: { entryFeeCents, houseFeeBps, tierEntryFeesCents },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/admin/pools/new");
  return { success: true, error: null };
}
