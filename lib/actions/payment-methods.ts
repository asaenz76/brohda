"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { paymentMethodSettingsSchema } from "@/lib/validations/wallet";
import type { PaymentMethod } from "@/lib/payment-methods/constants";

export type SetPaymentMethodEnabledResult = { success: boolean; error: string | null };

// Mirrors setRegistrationEnabledAction exactly: plain-boolean argument,
// service-role update, no client write policy on the table itself.
export async function setPaymentMethodEnabledAction(
  method: PaymentMethod,
  enabled: boolean,
): Promise<SetPaymentMethodEnabledResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from("payment_methods")
    .update({ enabled, updated_at: new Date().toISOString(), updated_by: admin.id })
    .eq("method", method);

  if (error) {
    return { success: false, error: "Could not update this setting." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: enabled ? "payment_method.enabled" : "payment_method.disabled",
    entityType: "payment_method",
    entityId: method,
    after: { method, enabled },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/wallet");
  return { success: true, error: null };
}

export type PaymentMethodSettingsState = { error: string | null };

export async function updatePaymentMethodDestinationAction(
  _prevState: PaymentMethodSettingsState,
  formData: FormData,
): Promise<PaymentMethodSettingsState> {
  const admin = await requireSuperAdmin();

  const parsed = paymentMethodSettingsSchema.safeParse({
    method: formData.get("method"),
    destination: formData.get("destination") || undefined,
    instructions: formData.get("instructions") || undefined,
  });

  if (!parsed.success) {
    return { error: "Invalid input." };
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from("payment_methods")
    .update({
      destination: parsed.data.destination ?? null,
      instructions: parsed.data.instructions ?? null,
      updated_at: new Date().toISOString(),
      updated_by: admin.id,
    })
    .eq("method", parsed.data.method);

  if (error) {
    return { error: "Could not save these details." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "payment_method.updated",
    entityType: "payment_method",
    entityId: parsed.data.method,
    after: { destination: parsed.data.destination ?? null, instructions: parsed.data.instructions ?? null },
  });

  revalidatePath("/admin/settings");
  revalidatePath("/wallet");
  return { error: null };
}
