"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { parseDollarsToCents } from "@/lib/utils/money";
import { walletRequestSchema, walletRequestReviewSchema } from "@/lib/validations/wallet";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/payment-methods/constants";
import { broadcastPoolEntryAdded } from "@/lib/realtime/pool-updates";
import {
  createFollowerEntryNotifications,
  createQuickTopUpEntrySuccessNotification,
  createQuickTopUpFundsAvailableNotification,
  createWalletRequestApprovedNotification,
  createWalletRequestRejectedNotification,
  createWalletRequestSubmittedNotification,
} from "@/lib/notifications/create";

type ApprovedWalletRequest = {
  id: string;
  user_id: string;
  intended_pool_id: string;
  intended_option_id: string;
};

// Called only for a deposit whose request recorded which entry it was meant
// to unlock (the "quick top-up" flow off EntryConfirmationSheet's
// insufficient-balance branch). The deposit has already been credited and
// the request already marked approved by the time this runs, so any
// failure here — pool locked in the meantime, balance changed by other
// activity, etc. — must never bubble up and undo that: it only decides
// which notification the player gets.
async function completeQuickTopUpEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  request: ApprovedWalletRequest,
) {
  try {
    const { data: pool } = await adminClient
      .from("pools")
      .select("entry_fee, question")
      .eq("id", request.intended_pool_id)
      .single();

    if (!pool) {
      await createQuickTopUpFundsAvailableNotification({
        userId: request.user_id,
        poolId: request.intended_pool_id,
      });
      return;
    }

    const { error } = await adminClient.rpc("create_pool_entry", {
      p_pool_id: request.intended_pool_id,
      p_user_id: request.user_id,
      p_option_id: request.intended_option_id,
      p_amount: pool.entry_fee,
      p_idempotency_key: `quick_topup:${request.id}`,
    });

    if (error) {
      await createQuickTopUpFundsAvailableNotification({
        userId: request.user_id,
        poolId: request.intended_pool_id,
      });
      return;
    }

    const { data: profile } = await adminClient
      .from("user_profiles")
      .select("display_name")
      .eq("id", request.user_id)
      .single();

    await broadcastPoolEntryAdded(request.intended_pool_id);
    await createFollowerEntryNotifications({
      poolId: request.intended_pool_id,
      enteredUserId: request.user_id,
      enteredDisplayName: profile?.display_name ?? "A player",
    });
    await createQuickTopUpEntrySuccessNotification({
      userId: request.user_id,
      poolId: request.intended_pool_id,
      question: pool.question,
    });
  } catch {
    await createQuickTopUpFundsAvailableNotification({
      userId: request.user_id,
      poolId: request.intended_pool_id,
    });
  }
}

export type WalletRequestState = {
  error: string | null;
  success: boolean;
  // Echoes back which submission this result belongs to — useActionState's
  // state otherwise persists across an inline-expand form being closed and
  // reopened for a new request, so a stale `success: true` from a previous
  // submission would incorrectly show as "submitted" again. The UI compares
  // this against its current idempotency key to tell a fresh attempt from
  // a stale result.
  idempotencyKey: string | null;
};

// requireUser() scopes this to the caller's own id server-side — the form
// never gets to say whose wallet the request is for. Written via the
// service role like every other wallet-adjacent table in this codebase,
// not a direct RLS INSERT policy.
export async function submitWalletRequestAction(
  _prevState: WalletRequestState,
  formData: FormData,
): Promise<WalletRequestState> {
  const user = await requireUser();

  const amountCents = parseDollarsToCents(String(formData.get("amount") ?? ""));
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  const parsed = walletRequestSchema.safeParse({
    type: formData.get("type"),
    amountCents,
    note: formData.get("note") || undefined,
    idempotencyKey,
    intendedPoolId: formData.get("intendedPoolId") || undefined,
    intendedOptionId: formData.get("intendedOptionId") || undefined,
    paymentMethod: formData.get("paymentMethod") || undefined,
    otherMethodNote: formData.get("otherMethodNote") || undefined,
    transactionRef: formData.get("transactionRef") || undefined,
  });

  if (!parsed.success) {
    return { error: "Enter a valid amount.", success: false, idempotencyKey };
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient.from("wallet_requests").insert({
    user_id: user.id,
    type: parsed.data.type,
    amount: parsed.data.amountCents,
    note: parsed.data.note ?? null,
    idempotency_key: parsed.data.idempotencyKey,
    intended_pool_id: parsed.data.intendedPoolId ?? null,
    intended_option_id: parsed.data.intendedOptionId ?? null,
    payment_method: parsed.data.paymentMethod ?? null,
    other_method_note: parsed.data.otherMethodNote ?? null,
    transaction_ref: parsed.data.transactionRef ?? null,
  });

  if (error) {
    if (error.code === "23505") {
      // Duplicate idempotency key — a retried submit, not a new request.
      return { error: null, success: true, idempotencyKey };
    }
    return { error: "Could not submit this request.", success: false, idempotencyKey };
  }

  await createWalletRequestSubmittedNotification({
    requesterDisplayName: user.display_name,
    requestType: parsed.data.type,
    amountCents: parsed.data.amountCents,
  });

  revalidatePath("/wallet");
  return { error: null, success: true, idempotencyKey };
}

export type WalletRequestReviewState = { error: string | null };

export async function approveWalletRequestAction(
  _prevState: WalletRequestReviewState,
  formData: FormData,
): Promise<WalletRequestReviewState> {
  const admin = await requireSuperAdmin();

  const parsed = walletRequestReviewSchema.safeParse({
    requestId: formData.get("requestId"),
    adminNote: formData.get("adminNote") || undefined,
  });

  if (!parsed.success) {
    return { error: "Invalid request." };
  }

  const adminClient = createAdminClient();
  const { data: request } = await adminClient
    .from("wallet_requests")
    .select("*")
    .eq("id", parsed.data.requestId)
    .eq("status", "pending")
    .single();

  if (!request) {
    return { error: "This request is no longer pending." };
  }

  const reason = parsed.data.adminNote
    ? `Wallet request approved: ${parsed.data.adminNote}`
    : "Wallet request approved";

  // Withdrawals repurpose the request's `note` as the payout destination
  // (Venmo username, cashtag, wallet address + network, etc.) — prefix it
  // with the chosen currency so the ledger entry reads as e.g. "Venmo:
  // @janedoe" rather than a bare string with no context on which rail it's
  // for. Snapshotted onto the transaction now since wallet_requests isn't
  // shown to players after approval, only the resulting ledger entry is.
  const destination =
    request.type === "withdrawal" && request.note
      ? request.payment_method
        ? `${PAYMENT_METHOD_LABELS[request.payment_method as PaymentMethod]}: ${request.note}`
        : request.note
      : null;

  const { data: transaction, error: rpcError } = await adminClient.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: request.user_id,
    p_type: request.type === "deposit" ? "manual_deposit" : "manual_withdrawal",
    p_direction: request.type === "deposit" ? "credit" : "debit",
    p_amount: request.amount,
    p_admin_id: admin.id,
    p_reason: reason,
    p_idempotency_key: `wallet_request:${request.id}`,
    p_destination: destination,
  });

  if (rpcError) {
    if (rpcError.message.includes("insufficient_balance")) {
      return { error: "This withdrawal would drive the balance below zero." };
    }
    return { error: "Could not complete this transaction." };
  }

  const { error: updateError } = await adminClient
    .from("wallet_requests")
    .update({
      status: "approved",
      admin_id: admin.id,
      admin_note: parsed.data.adminNote ?? null,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", request.id);

  if (updateError) {
    return { error: "Payment applied, but could not update the request status." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "wallet_request.approved",
    entityType: "wallet_request",
    entityId: request.id,
    before: { status: "pending" },
    after: { status: "approved" },
    reason: parsed.data.adminNote,
  });

  if (request.type === "deposit" && request.intended_pool_id && request.intended_option_id) {
    await completeQuickTopUpEntry(adminClient, {
      id: request.id,
      user_id: request.user_id,
      intended_pool_id: request.intended_pool_id,
      intended_option_id: request.intended_option_id,
    });
  } else {
    await createWalletRequestApprovedNotification({
      userId: request.user_id,
      requestType: request.type as "deposit" | "withdrawal",
      amountCents: request.amount,
      transactionId: (transaction as { id: string } | null)?.id ?? null,
    });
  }

  revalidatePath("/admin/wallet-requests");
  revalidatePath("/wallet");
  return { error: null };
}

export async function rejectWalletRequestAction(
  _prevState: WalletRequestReviewState,
  formData: FormData,
): Promise<WalletRequestReviewState> {
  const admin = await requireSuperAdmin();

  const parsed = walletRequestReviewSchema.safeParse({
    requestId: formData.get("requestId"),
    adminNote: formData.get("adminNote") || undefined,
  });

  if (!parsed.success) {
    return { error: "Invalid request." };
  }

  const adminClient = createAdminClient();
  const { data: request, error: updateError } = await adminClient
    .from("wallet_requests")
    .update({
      status: "rejected",
      admin_id: admin.id,
      admin_note: parsed.data.adminNote ?? null,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.requestId)
    .eq("status", "pending")
    .select("id, user_id, type, amount")
    .single();

  if (updateError || !request) {
    return { error: "This request is no longer pending." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "wallet_request.rejected",
    entityType: "wallet_request",
    entityId: request.id,
    before: { status: "pending" },
    after: { status: "rejected" },
    reason: parsed.data.adminNote,
  });

  await createWalletRequestRejectedNotification({
    userId: request.user_id,
    requestType: request.type as "deposit" | "withdrawal",
    amountCents: request.amount,
    adminNote: parsed.data.adminNote ?? null,
  });

  revalidatePath("/admin/wallet-requests");
  revalidatePath("/wallet");
  return { error: null };
}
