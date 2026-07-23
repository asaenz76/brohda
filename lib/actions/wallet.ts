"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSuperAdmin } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/log";
import { walletAdjustmentSchema } from "@/lib/validations/wallet";
import { parseDollarsToCents } from "@/lib/utils/money";

export type WalletAdjustmentState = { error: string | null };

async function applyAdjustment(
  formData: FormData,
  direction: "credit" | "debit",
  type: "manual_deposit" | "manual_withdrawal",
): Promise<WalletAdjustmentState> {
  const admin = await requireSuperAdmin();

  const amountCents = parseDollarsToCents(String(formData.get("amount") ?? ""));
  const parsed = walletAdjustmentSchema.safeParse({
    userId: formData.get("userId"),
    amountCents,
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) {
    return { error: "Enter a valid amount and reason." };
  }

  const adminClient = createAdminClient();
  const { data: before } = await adminClient
    .from("wallet_balances")
    .select("balance")
    .eq("user_id", parsed.data.userId)
    .single();

  const { data: transaction, error } = await adminClient.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: parsed.data.userId,
    p_type: type,
    p_direction: direction,
    p_amount: parsed.data.amountCents,
    p_admin_id: admin.id,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error) {
    if (error.message.includes("insufficient_balance")) {
      return { error: "This withdrawal would drive the balance below zero." };
    }
    return { error: "Could not complete this transaction." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: direction === "credit" ? "wallet.deposit" : "wallet.withdrawal",
    entityType: "wallet_balance",
    entityId: parsed.data.userId,
    before,
    after: { balance: transaction?.balance_after },
    reason: parsed.data.reason,
  });

  revalidatePath("/admin/users");
  return { error: null };
}

export async function depositAction(
  _prevState: WalletAdjustmentState,
  formData: FormData,
): Promise<WalletAdjustmentState> {
  return applyAdjustment(formData, "credit", "manual_deposit");
}

export async function withdrawAction(
  _prevState: WalletAdjustmentState,
  formData: FormData,
): Promise<WalletAdjustmentState> {
  return applyAdjustment(formData, "debit", "manual_withdrawal");
}
