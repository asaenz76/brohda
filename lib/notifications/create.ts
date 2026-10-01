import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCents } from "@/lib/utils/money";

/**
 * Notifies every admin/super_admin that a player submitted a new wallet
 * request (deposit or withdrawal) — so staff know to review it in
 * /admin/wallet-requests without having to poll that page. No pool_id (a
 * wallet request isn't about any particular pool); resolveNotificationHref
 * gives this type a fixed href straight to that queue instead.
 */
export async function createWalletRequestSubmittedNotification({
  requesterDisplayName,
  requestType,
  amountCents,
}: {
  requesterDisplayName: string;
  requestType: "deposit" | "withdrawal";
  amountCents: number;
}) {
  const admin = createAdminClient();

  const { data: staff } = await admin
    .from("user_profiles")
    .select("id")
    .in("role", ["admin", "super_admin"])
    .eq("is_active", true);

  if (!staff || staff.length === 0) return;

  const rows = staff.map((s) => ({
    user_id: s.id,
    type: "WALLET_REQUEST_SUBMITTED",
    title: requestType === "deposit" ? "New deposit request" : "New withdrawal request",
    body: `${requesterDisplayName} requested a ${requestType} of ${formatCents(amountCents)}.`,
  }));

  await admin.from("notifications").insert(rows);
}

/** Notifies a player that their deposit/withdrawal request was approved. */
export async function createWalletRequestApprovedNotification({
  userId,
  requestType,
  amountCents,
  transactionId,
}: {
  userId: string;
  requestType: "deposit" | "withdrawal";
  amountCents: number;
  transactionId: string | null;
}) {
  const admin = createAdminClient();

  await admin.from("notifications").insert({
    user_id: userId,
    type: requestType === "deposit" ? "DEPOSIT_APPROVED" : "WITHDRAWAL_APPROVED",
    title: requestType === "deposit" ? "Deposit approved" : "Withdrawal approved",
    body:
      requestType === "deposit"
        ? `Your deposit of ${formatCents(amountCents)} was approved and added to your wallet.`
        : `Your withdrawal of ${formatCents(amountCents)} was approved.`,
    transaction_id: transactionId,
  });
}

/**
 * Notifies a player that their deposit/withdrawal request was denied — no
 * money moved, so no transaction_id/pool_id to attach; resolveNotificationHref
 * falls back to a non-clickable notification, same as any other type with
 * neither set.
 */
export async function createWalletRequestRejectedNotification({
  userId,
  requestType,
  amountCents,
  adminNote,
}: {
  userId: string;
  requestType: "deposit" | "withdrawal";
  amountCents: number;
  adminNote: string | null;
}) {
  const admin = createAdminClient();

  const base =
    requestType === "deposit"
      ? `Your deposit request of ${formatCents(amountCents)} was denied.`
      : `Your withdrawal request of ${formatCents(amountCents)} was denied.`;

  await admin.from("notifications").insert({
    user_id: userId,
    type: requestType === "deposit" ? "DEPOSIT_REJECTED" : "WITHDRAWAL_REJECTED",
    title: requestType === "deposit" ? "Deposit request denied" : "Withdrawal request denied",
    body: adminNote ? `${base} Reason: ${adminNote}` : base,
  });
}
