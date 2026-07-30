import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildNoticeCopy } from "@/lib/pools/notices";
import { formatCents } from "@/lib/utils/money";
import type { PoolVoidReason } from "@/lib/pools/anomaly";
import type { PoolStatus } from "@/lib/pools/card-state";

/**
 * Builds notification copy from the same lib/pools/notices.ts source of
 * truth the pool card itself uses, then inserts one row per affected entry.
 * Called after a void/refund RPC succeeds — never from inside the SQL
 * function, so presentation text lives in exactly one place.
 */
export async function createRefundNotifications(
  poolId: string,
  poolStatus: Extract<PoolStatus, "VOIDED" | "CANCELLED">,
  voidReason: PoolVoidReason,
) {
  const admin = createAdminClient();

  const [{ data: entries }, { data: pool }, { data: transactions }] = await Promise.all([
    admin.from("entries").select("user_id, amount").eq("pool_id", poolId).eq("status", "REFUNDED"),
    admin.from("pools").select("house_fee_bps").eq("id", poolId).single(),
    // Correlated by transaction_id, not pool_id, so this notification stays
    // clickable even if this pool is later hard-deleted — deleting a pool
    // nulls notifications.pool_id (to satisfy the FK) but wallet_transactions
    // rows are never deleted (wallet_transactions_no_delete trigger).
    admin
      .from("wallet_transactions")
      .select("id, user_id")
      .eq("pool_id", poolId)
      .eq("type", "pool_refund_credit"),
  ]);

  if (!entries || entries.length === 0) return;

  const transactionIdByUser = new Map((transactions ?? []).map((t) => [t.user_id, t.id]));

  const title =
    voidReason === "MINIMUM_ENTRIES_NOT_REACHED" || voidReason === "ADMIN_MANUAL_CANCEL"
      ? "Pool cancelled"
      : "Pool voided";

  const rows = entries.map((entry) => {
    const notice = buildNoticeCopy({
      poolStatus,
      fixtureInternalStatus: "UNKNOWN", // unused by the VOIDED/CANCELLED branch
      voidReason,
      entryStatus: "REFUNDED",
      entryAmount: entry.amount,
      finalPayout: null,
      // Only NO_WINNING_ENTRIES_FEE_RETAINED's copy ever reads this —
      // every other reason refunds entry.amount in full.
      houseFeeBasisPoints: pool?.house_fee_bps ?? 0,
    });

    return {
      user_id: entry.user_id,
      type: notice?.type ?? voidReason,
      title,
      body: notice?.message ?? "This pool has been voided.",
      pool_id: poolId,
      transaction_id: transactionIdByUser.get(entry.user_id) ?? null,
    };
  });

  await admin.from("notifications").insert(rows);
}

/**
 * Notifies a comment's author when someone replies to it. Skips
 * self-replies — no need to tell someone about their own reply. Unlike the
 * settlement/refund notifications above, this is triggered by a single
 * user action rather than a batch job, so it inserts one row directly
 * instead of mapping over a query result.
 */
export async function createCommentReplyNotification({
  poolId,
  parentCommentUserId,
  replierUserId,
  replierDisplayName,
  replyBody,
}: {
  poolId: string;
  parentCommentUserId: string;
  replierUserId: string;
  replierDisplayName: string;
  replyBody: string;
}) {
  if (parentCommentUserId === replierUserId) return;

  const admin = createAdminClient();
  const preview = replyBody.length > 140 ? `${replyBody.slice(0, 140)}…` : replyBody;

  await admin.from("notifications").insert({
    user_id: parentCommentUserId,
    type: "COMMENT_REPLY",
    title: "New reply",
    body: `${replierDisplayName} replied: "${preview}"`,
    pool_id: poolId,
  });
}

/**
 * Notifies every user @mentioned in a comment. A distinct event from
 * createCommentReplyNotification — a reply's parent-comment author who is
 * also @mentioned in that same reply gets both notifications, matching how
 * Instagram/Twitter treat "replied to you" and "mentioned you" as separate
 * things rather than deduping them.
 */
export async function createMentionNotifications({
  poolId,
  mentionedUserIds,
  mentionerDisplayName,
  commentBody,
}: {
  poolId: string;
  mentionedUserIds: string[];
  mentionerDisplayName: string;
  commentBody: string;
}) {
  if (mentionedUserIds.length === 0) return;

  const admin = createAdminClient();
  const preview = commentBody.length > 140 ? `${commentBody.slice(0, 140)}…` : commentBody;

  const rows = mentionedUserIds.map((userId) => ({
    user_id: userId,
    type: "COMMENT_MENTION",
    title: "You were mentioned",
    body: `${mentionerDisplayName} mentioned you: "${preview}"`,
    pool_id: poolId,
  }));

  await admin.from("notifications").insert(rows);
}

/**
 * Notifies everyone who follows `enteredUserId` that they just entered a
 * pool — the "more engagement" hook: seeing a followed player's pick
 * prompts you to open the same pool and weigh in yourself. Fire-and-forget
 * batch insert, same shape as the notifications above; no dedup/throttle,
 * matching this codebase's existing "one notification per real event"
 * precedent (createCommentReplyNotification).
 */
export async function createFollowerEntryNotifications({
  poolId,
  enteredUserId,
  enteredDisplayName,
}: {
  poolId: string;
  enteredUserId: string;
  enteredDisplayName: string;
}) {
  const admin = createAdminClient();

  const { data: followers } = await admin
    .from("follows")
    .select("follower_id")
    .eq("followee_id", enteredUserId);

  if (!followers || followers.length === 0) return;

  const rows = followers.map((f) => ({
    user_id: f.follower_id,
    type: "FOLLOWED_USER_ENTERED_POOL",
    title: "New pick",
    body: `${enteredDisplayName} entered a pool`,
    pool_id: poolId,
  }));

  await admin.from("notifications").insert(rows);
}

/**
 * Notifies everyone who follows a published pool's home team, away team,
 * or league — one row per recipient, unconditional (in-app fires for every
 * follower regardless of their per-item email preference; that toggle only
 * gates the email half of this fan-out, handled separately in
 * lib/email/notify-followed-pool-published.ts). `recipientUserIds` is
 * expected to already be deduped by lib/pools/follow-recipients.ts, so a
 * user following via more than one path (e.g. both the home team and the
 * league) still gets exactly one notification, not one per match.
 */
export async function createPoolPublishedFollowNotifications({
  poolId,
  question,
  recipientUserIds,
}: {
  poolId: string;
  question: string;
  recipientUserIds: string[];
}) {
  if (recipientUserIds.length === 0) return;

  const admin = createAdminClient();

  const rows = recipientUserIds.map((userId) => ({
    user_id: userId,
    type: "POOL_PUBLISHED_FOLLOWED",
    title: "New pool for a team you follow",
    body: `New pool: ${question}`,
    pool_id: poolId,
  }));

  await admin.from("notifications").insert(rows);
}

/**
 * Notifies a player that their quick top-up (a deposit requested to cover a
 * shortfall on a specific pool entry, see TopUpAndJoinModal) was approved
 * and their entry was placed automatically.
 */
export async function createQuickTopUpEntrySuccessNotification({
  userId,
  poolId,
  question,
}: {
  userId: string;
  poolId: string;
  question: string;
}) {
  const admin = createAdminClient();

  await admin.from("notifications").insert({
    user_id: userId,
    type: "QUICK_TOPUP_ENTERED",
    title: "You're in!",
    body: `Your top-up was approved and you were entered: "${question}"`,
    pool_id: poolId,
  });
}

/**
 * Notifies a player that their quick top-up was approved but the entry
 * couldn't be placed automatically (pool locked/closed in the meantime,
 * balance no longer sufficient, etc.) — the deposit still landed, just
 * without the intended entry.
 */
export async function createQuickTopUpFundsAvailableNotification({
  userId,
  poolId,
}: {
  userId: string;
  poolId: string;
}) {
  const admin = createAdminClient();

  await admin.from("notifications").insert({
    user_id: userId,
    type: "QUICK_TOPUP_FUNDS_AVAILABLE",
    title: "Top-up approved",
    body: "Your top-up was approved, but this pool is no longer open for entries. The funds are in your wallet.",
    pool_id: poolId,
  });
}

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

/**
 * Notifies a player that their deposit/withdrawal request was approved.
 * Skipped for a deposit that completed a quick top-up (intended_pool_id +
 * intended_option_id set) — completeQuickTopUpEntry already sends a more
 * specific notification for that case (entered the pool, or funds
 * available if the pool locked in the meantime), so this would just be a
 * redundant second one about the same event.
 */
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

/** Same idea as above, for a normal WON/LOST settlement. */
export async function createSettlementNotifications(poolId: string) {
  const admin = createAdminClient();

  const { data: settlement } = await admin
    .from("settlements")
    .select("id, winning_option_id")
    .eq("pool_id", poolId)
    .order("grading_version", { ascending: false })
    .limit(1)
    .single();

  if (!settlement) return;

  const { data: options } = await admin
    .from("pool_options")
    .select("id, label")
    .eq("pool_id", poolId);
  const labelById = new Map((options ?? []).map((o) => [o.id, o.label]));
  const winningOptionLabel = settlement.winning_option_id
    ? (labelById.get(settlement.winning_option_id) ?? null)
    : null;

  const { data: entries } = await admin
    .from("entries")
    .select("id, user_id, option_id, status")
    .eq("pool_id", poolId)
    .in("status", ["WON", "LOST"]);

  if (!entries || entries.length === 0) return;

  const { data: payouts } = await admin
    .from("settlement_payouts")
    .select("entry_id, amount")
    .eq("settlement_id", settlement.id);
  const payoutByEntry = new Map((payouts ?? []).map((p) => [p.entry_id, p.amount]));

  // Correlated by transaction_id, not pool_id, so a "You won!" notification
  // stays clickable even if this pool is later hard-deleted — deleting a
  // pool nulls notifications.pool_id (to satisfy the FK) but
  // wallet_transactions rows are never deleted. A LOST entry never moved
  // money, so it has no transaction to attach — falls back to the pool
  // link, same as before.
  const { data: transactions } = await admin
    .from("wallet_transactions")
    .select("id, user_id")
    .eq("pool_id", poolId)
    .eq("type", "pool_payout_credit");
  const transactionIdByUser = new Map((transactions ?? []).map((t) => [t.user_id, t.id]));

  const rows = entries.map((entry) => {
    const isWon = entry.status === "WON";
    const selectedOptionLabel = labelById.get(entry.option_id) ?? null;

    const notice = buildNoticeCopy({
      poolStatus: "SETTLED",
      fixtureInternalStatus: "COMPLETED",
      voidReason: null,
      entryStatus: entry.status as "WON" | "LOST",
      entryAmount: 0,
      finalPayout: isWon ? (payoutByEntry.get(entry.id) ?? null) : null,
      winningOptionLabel,
      selectedOptionLabel,
    });

    return {
      user_id: entry.user_id,
      type: notice?.type ?? (isWon ? "SETTLED_WON" : "SETTLED_LOST"),
      title: isWon ? "You won!" : "Pool settled",
      body: notice?.message ?? (isWon ? "You won this pool." : "This pool has been settled."),
      pool_id: poolId,
      transaction_id: isWon ? (transactionIdByUser.get(entry.user_id) ?? null) : null,
    };
  });

  await admin.from("notifications").insert(rows);
}
