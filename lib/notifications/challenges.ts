import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketNotificationContext } from "./market-context";
import { deliverNotification, insertNotificationRows, type NotificationDelivery } from "./deliver";
import type { Challenge } from "@/lib/challenges/types";

// Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges),
// §40-41. Mirrors lib/notifications/post-comments.ts's own simplicity —
// plain TS-constructed copy, not platform_settings-driven templates like
// lib/notifications/predictions.ts: R7's own instruction is "do not
// hard-code mutable wording into SQL/domain logic," which plain TypeScript
// string construction already satisfies without needing a second
// config-driven copy-template system just for this milestone. Every
// recipient here is always derived from Challenge state (challenger_user_id
// /recipient_user_id, both immutable, both set only by call_bs() itself) —
// never accepted from a client (§41).
//
// Exclusivity addendum: every notification here also stamps market_id
// (always) and post_id (when the Market's Game already has a published
// Post) directly at creation time — reusing the exact columns
// prediction_graded's own notifications already populate, and the exact
// resolveNotificationHref (lib/notifications/links.ts) read path that
// already handles them, rather than resolving a Post lookup per
// notification row at read time.

// Delivery is never silent: inserts go through ./deliver.ts, which checks
// every insert result, and deliverChallengeNotification() is the
// non-throwing wrapper the server actions and the resolver use.

const insertNotifications = insertNotificationRows;

export type ChallengeNotificationDelivery = NotificationDelivery;

/** Runs one Challenge notification without ever throwing; see ./deliver.ts. */
export function deliverChallengeNotification(label: string, challengeId: string, send: () => Promise<void>): Promise<ChallengeNotificationDelivery> {
  return deliverNotification("call-bs", label, `challenge ${challengeId}`, send);
}

async function getDisplayName(userId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("user_profiles").select("display_name").eq("id", userId).maybeSingle();
  return data?.display_name ?? "Someone";
}

/** §40 "Sent": the recipient learns a specific user called BS on their Pick. */
export async function createChallengeReceivedNotification(challenge: Challenge): Promise<void> {
  const [challengerName, { subject, postId }] = await Promise.all([getDisplayName(challenge.challengerUserId), getMarketNotificationContext(challenge.marketId)]);

  await insertNotifications("CALL_BS_RECEIVED", {
    user_id: challenge.recipientUserId,
    type: "CALL_BS_RECEIVED",
    title: "Someone called BS",
    body: `${challengerName} called BS on your pick on "${subject}".`,
    challenge_id: challenge.id,
    market_id: challenge.marketId,
    post_id: postId,
  });
}

/** §40 "Accepted": the challenger learns the recipient accepted. */
export async function createChallengeAcceptedNotification(challenge: Challenge): Promise<void> {
  const [recipientName, { subject, postId }] = await Promise.all([getDisplayName(challenge.recipientUserId), getMarketNotificationContext(challenge.marketId)]);

  await insertNotifications("CALL_BS_ACCEPTED", {
    user_id: challenge.challengerUserId,
    type: "CALL_BS_ACCEPTED",
    title: "Call BS accepted",
    body: `${recipientName} accepted your Call BS on "${subject}". Both picks are locked in.`,
    challenge_id: challenge.id,
    market_id: challenge.marketId,
    post_id: postId,
  });
}

/** §40 "Declined": the challenger learns the recipient declined. No penalty, no locking — purely informational. */
export async function createChallengeDeclinedNotification(challenge: Challenge): Promise<void> {
  const [recipientName, { subject, postId }] = await Promise.all([getDisplayName(challenge.recipientUserId), getMarketNotificationContext(challenge.marketId)]);

  await insertNotifications("CALL_BS_DECLINED", {
    user_id: challenge.challengerUserId,
    type: "CALL_BS_DECLINED",
    title: "Call BS declined",
    body: `${recipientName} declined your Call BS on "${subject}".`,
    challenge_id: challenge.id,
    market_id: challenge.marketId,
    post_id: postId,
  });
}

/** §40 "Resolved": both participants learn the result. Fires exactly once per newly-resolved Challenge (lib/challenges/resolution.ts's own idempotency guard ensures this is never called twice for the same row — §36). */
export async function createChallengeResolvedNotifications({ challenge }: { challenge: Challenge }): Promise<void> {
  const [challengerName, recipientName, { subject, postId }] = await Promise.all([
    getDisplayName(challenge.challengerUserId),
    getDisplayName(challenge.recipientUserId),
    getMarketNotificationContext(challenge.marketId),
  ]);

  if (challenge.result === "VOID") {
    const body = `Your Call BS on "${subject}" was void — no result.`;
    await insertNotifications("CALL_BS_RESOLVED", [
      { user_id: challenge.challengerUserId, type: "CALL_BS_RESOLVED", title: "Call BS void", body, challenge_id: challenge.id, market_id: challenge.marketId, post_id: postId },
      { user_id: challenge.recipientUserId, type: "CALL_BS_RESOLVED", title: "Call BS void", body, challenge_id: challenge.id, market_id: challenge.marketId, post_id: postId },
    ]);
    return;
  }

  const challengerWon = challenge.result === "CHALLENGER_WON";
  await insertNotifications("CALL_BS_RESOLVED", [
    {
      user_id: challenge.challengerUserId,
      type: "CALL_BS_RESOLVED",
      title: challengerWon ? "You won a Call BS" : "You lost a Call BS",
      body: challengerWon ? `You beat ${recipientName} on "${subject}".` : `${recipientName} beat you on "${subject}".`,
      challenge_id: challenge.id,
      market_id: challenge.marketId,
      post_id: postId,
    },
    {
      user_id: challenge.recipientUserId,
      type: "CALL_BS_RESOLVED",
      title: challengerWon ? "You lost a Call BS" : "You won a Call BS",
      body: challengerWon ? `${challengerName} beat you on "${subject}".` : `You beat ${challengerName} on "${subject}".`,
      challenge_id: challenge.id,
      market_id: challenge.marketId,
      post_id: postId,
    },
  ]);
}

/**
 * Brohda 2.1 (M1): a Call BS ended because one of the two Members changed their (editable) Pick. ONLY the other participant is told (never the Member who changed it). At most one per
 * recipient and challenge — the database's unique index (notifications_call_bs_cancelled_once) makes a retry or the reconciliation sweep a no-op, so a duplicate attempt is treated as delivered.
 */
export async function createChallengeCancelledNotification({ challengeId, notifyUserId, marketId }: { challengeId: string; notifyUserId: string; marketId: string }): Promise<void> {
  const { subject, postId } = await getMarketNotificationContext(marketId);
  const admin = createAdminClient();
  const { error } = await admin.from("notifications").insert({
    user_id: notifyUserId,
    type: "CALL_BS_CANCELLED",
    title: "Call BS cancelled",
    body: `Challenge cancelled because the Pick changed on "${subject}".`,
    challenge_id: challengeId,
    market_id: marketId,
    post_id: postId,
  });
  if (error && error.code !== "23505") throw new Error(`CALL_BS_CANCELLED notification insert failed: ${error.message}`);
}

/**
 * After a Pick edit commits: notify the other participant of every challenge it cancelled. Best-effort and never throws (the edit already stands). The ids come from the database's own answer to
 * the edit (set_pick's cancelled_challenge_ids), and the recipient is derived from the challenge itself — the editor is never notified.
 */
export async function notifyPickChangedCancellations(challengeIds: string[], editorUserId: string): Promise<void> {
  if (challengeIds.length === 0) return;
  const admin = createAdminClient();
  const { data, error } = await admin.from("challenges").select("id, challenger_user_id, recipient_user_id, market_id").in("id", challengeIds);
  if (error || !data) {
    console.error("[call-bs] cancellation notification lookup failed — the reconciliation sweep will deliver them:", error?.message);
    return;
  }
  for (const row of data) {
    const notifyUserId = row.challenger_user_id === editorUserId ? row.recipient_user_id : row.challenger_user_id;
    await deliverChallengeNotification("CALL_BS_CANCELLED", row.id, () => createChallengeCancelledNotification({ challengeId: row.id, notifyUserId, marketId: row.market_id }));
  }
}

/** Delivers the cancellation notifications still owed (a delivery that failed after its edit committed). Idempotent; returns how many it delivered and how many failed. */
export async function reconcileChallengeCancellationNotifications(limit = 100): Promise<{ delivered: number; failed: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("call_bs_cancellations_awaiting_notification", { p_limit: limit });
  if (error) throw new Error(`cancellation notification reconciliation failed: ${error.message}`);
  let delivered = 0;
  let failed = 0;
  for (const row of (data ?? []) as { challenge_id: string; notify_user_id: string; market_id: string }[]) {
    const result = await deliverChallengeNotification("CALL_BS_CANCELLED", row.challenge_id, () =>
      createChallengeCancelledNotification({ challengeId: row.challenge_id, notifyUserId: row.notify_user_id, marketId: row.market_id }),
    );
    if (result.delivered) delivered += 1;
    else failed += 1;
  }
  return { delivered, failed };
}
