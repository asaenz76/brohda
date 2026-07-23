import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { NotificationRow } from "./fetch";

export type NotificationWithHref = NotificationRow & { href: string | null };

// The only two wallet_transaction types a notification could ever be "about"
// — a pool_id contributes at most one of these per user, so a plain
// pool_id -> transaction id map is unambiguous.
const LEDGER_TRANSACTION_TYPES = ["pool_payout_credit", "pool_refund_credit"] as const;

// Types that are never about the recipient's own money, so they should
// always point straight at the pool — never at the ledger. Without this,
// a "someone you follow entered a pool" notification could accidentally
// resolve to the *recipient's own* unrelated payout/refund on that same
// pool_id, if they happened to have one, which would point at the wrong
// thing entirely.
const POOL_LINK_ONLY_TYPES = new Set([
  "COMMENT_REPLY",
  "COMMENT_MENTION",
  "FOLLOWED_USER_ENTERED_POOL",
  "QUICK_TOPUP_ENTERED",
  "QUICK_TOPUP_FUNDS_AVAILABLE",
]);

export function resolveNotificationHref(
  n: NotificationRow,
  transactionIdByPoolId: Map<string, string>,
): string | null {
  // Not about any pool or the recipient's own money — always the admin
  // wallet-requests queue, regardless of pool_id/transaction_id (both null
  // for this type).
  if (n.type === "WALLET_REQUEST_SUBMITTED") return "/admin/wallet-requests";

  if (POOL_LINK_ONLY_TYPES.has(n.type)) {
    return n.pool_id ? `/pool/${n.pool_id}` : null;
  }

  // Prefer the transaction_id stamped on the notification itself at
  // creation time — it survives the pool being hard-deleted later, unlike
  // pool_id (delete_terminal_pool nulls that out to satisfy the FK, since
  // even a SETTLED pool is deletable). Only notifications created before
  // that column existed fall through to the pool_id-keyed lookup below.
  if (n.transaction_id) return `/activity#tx-${n.transaction_id}`;

  // Everything else (SETTLED_WON, SETTLED_LOST, and every void/cancel
  // reason string) is about a pool's outcome. If that outcome moved money
  // (a payout or a refund), link straight to that ledger row; SETTLED_LOST
  // has no wallet movement at all, so it falls back to the pool page.
  const transactionId = n.pool_id ? transactionIdByPoolId.get(n.pool_id) : undefined;
  if (transactionId) return `/activity#tx-${transactionId}`;
  return n.pool_id ? `/pool/${n.pool_id}` : null;
}

/** Annotates each notification with where clicking it should navigate. */
export async function attachNotificationHrefs(
  userId: string,
  notifications: NotificationRow[],
): Promise<NotificationWithHref[]> {
  const poolIds = [
    ...new Set(
      notifications
        .filter((n) => !POOL_LINK_ONLY_TYPES.has(n.type) && n.pool_id != null)
        .map((n) => n.pool_id as string),
    ),
  ];

  const transactionIdByPoolId = new Map<string, string>();
  if (poolIds.length > 0) {
    const supabase = await createClient();
    const { data: transactions } = await supabase
      .from("wallet_transactions")
      .select("id, pool_id, type")
      .eq("user_id", userId)
      .in("pool_id", poolIds)
      .in("type", LEDGER_TRANSACTION_TYPES);

    for (const t of transactions ?? []) {
      if (t.pool_id) transactionIdByPoolId.set(t.pool_id, t.id);
    }
  }

  return notifications.map((n) => ({ ...n, href: resolveNotificationHref(n, transactionIdByPoolId) }));
}
