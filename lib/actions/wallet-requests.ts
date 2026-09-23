"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { parseDollarsToCents } from "@/lib/utils/money";
import { walletRequestSchema, walletRequestReviewSchema } from "@/lib/validations/wallet";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/payment-methods/constants";
import { broadcastPoolEntryAdded } from "@/lib/realtime/pool-updates";
import { reserveFunds, releaseReservation, consumeReservation } from "@/lib/wallet/reservations";
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
    // Surface whichever field actually failed (the withdrawal-destination
    // check and the payment-reference checks below both set a specific,
    // actionable message via ctx.addIssue) — falling back to the generic
    // amount copy only covers truly field-less failures (e.g. a malformed
    // request shape), not the common "wrong field" case.
    const message = parsed.error.issues[0]?.message ?? "Enter a valid amount.";
    return { error: message, success: false, idempotencyKey };
  }

  const adminClient = createAdminClient();

  // Milestone R8 (docs/BROHDA_2_0_MILESTONE_MAP.md, Wallet Reservation
  // Layer), §11: a withdrawal request now reserves its funds AT SUBMISSION
  // time, closing the exact gap R0.5/R8's own audit confirmed — before
  // this, a pending withdrawal request reserved nothing, so the same
  // balance could be spent in a paid pool before an admin ever reviewed
  // it. The request id is generated here (not left to the database
  // default) so the reservation can reference it, and the request row
  // itself is only ever inserted once its funds are genuinely held —
  // never the other way around. Deposits are entirely unaffected: they
  // only ever increase owned balance later, on approval (§13), so nothing
  // needs to be reserved for one.
  const requestId = crypto.randomUUID();
  let reservationId: string | null = null;
  if (parsed.data.type === "withdrawal") {
    try {
      const reservation = await reserveFunds({
        userId: user.id,
        amount: parsed.data.amountCents,
        purpose: "withdrawal_request",
        idempotencyKey: `wallet_request:${parsed.data.idempotencyKey}:reserve`,
      });
      reservationId = reservation.id;
    } catch (reserveError) {
      const message = reserveError instanceof Error ? reserveError.message : String(reserveError);
      if (message.includes("insufficient_available_balance")) {
        return { error: "You don't have enough available balance for this withdrawal.", success: false, idempotencyKey };
      }
      return { error: "Could not submit this request.", success: false, idempotencyKey };
    }
  }

  const { error } = await adminClient.from("wallet_requests").insert({
    id: requestId,
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
    reservation_id: reservationId,
  });

  if (error) {
    if (error.code === "23505") {
      // Duplicate idempotency key — a retried submit, not a new request.
      // The reservation call above was equally idempotent (same derived
      // key), so no funds were double-reserved either.
      return { error: null, success: true, idempotencyKey };
    }
    // The wallet_requests insert itself failed after funds were already
    // reserved (a genuine anomaly, not an ordinary rejection) — release
    // the hold rather than leaving it stranded against a request that was
    // never actually recorded.
    if (reservationId) await releaseReservation(reservationId);
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

  // Milestone R8: a withdrawal's funds were already reserved at submission
  // time (submitWalletRequestAction) — approval CONSUMES that exact hold
  // rather than issuing a fresh, unrelated debit, so there is no separate
  // "does the current balance still cover this" question to get wrong; the
  // funds were proven available and set aside the moment the request was
  // made. A deposit never reserved anything, so it still goes straight
  // through apply_wallet_transaction exactly as before this milestone.
  let transaction: { id: string } | null = null;
  if (request.type === "withdrawal") {
    if (!request.reservation_id) {
      return { error: "This withdrawal has no funds on hold — it predates the reservation system and cannot be approved automatically." };
    }
    try {
      const result = await consumeReservation({
        reservationId: request.reservation_id,
        walletTransactionType: "manual_withdrawal",
        adminId: admin.id,
        reason,
        idempotencyKey: `wallet_request:${request.id}`,
        destination,
      });
      if (result.outcome === "already_released") {
        return { error: "This withdrawal's hold was already released and cannot be approved." };
      }
      transaction = result.walletTransactionId ? { id: result.walletTransactionId } : null;
    } catch {
      return { error: "Could not complete this transaction." };
    }
  } else {
    const { data, error: rpcError } = await adminClient.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: request.user_id,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: request.amount,
      p_admin_id: admin.id,
      p_reason: reason,
      p_idempotency_key: `wallet_request:${request.id}`,
      p_destination: destination,
    });
    if (rpcError) {
      return { error: "Could not complete this transaction." };
    }
    transaction = data;
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
      transactionId: transaction?.id ?? null,
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
    .select("id, user_id, type, amount, reservation_id")
    .single();

  if (updateError || !request) {
    return { error: "This request is no longer pending." };
  }

  // Milestone R8: rejecting a withdrawal releases its hold — the funds
  // were never spent, so this restores availability without touching
  // owned balance (§15). No effect on a deposit, which never reserved
  // anything.
  if (request.type === "withdrawal" && request.reservation_id) {
    await releaseReservation(request.reservation_id);
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
