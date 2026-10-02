import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketNotificationContext } from "./market-context";
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

// Delivery failures are never silent (final hardening). The create*
// functions below THROW if a notification insert fails — Supabase reports
// insert failures in the result object rather than throwing, so every
// insert result is checked explicitly. Callers choose the policy:
//   - Server actions go through deliverChallengeNotification(), which logs
//     the failure and lets the already-committed Challenge action stand
//     (the same "optional, best-effort notification must never make a
//     successful domain mutation look like a failure" policy as
//     maybeCreatePredictionGradedNotification in ./predictions.ts).
//   - The resolver records the failure on its run summary so job health
//     shows "degraded" instead of a quietly missing CALL_BS_RESOLVED.

async function insertNotifications(label: string, rows: Record<string, unknown> | Record<string, unknown>[]): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("notifications").insert(rows);
  if (error) throw new Error(`${label} notification insert failed: ${error.message}`);
}

export type ChallengeNotificationDelivery = { delivered: true } | { delivered: false; error: string };

/**
 * Runs one Challenge notification without ever throwing. A failure is
 * logged with the Challenge id (enough to diagnose or re-send by hand) and
 * returned to the caller; the Challenge action that triggered it has
 * already been committed and is unaffected.
 */
export async function deliverChallengeNotification(
  label: string,
  challengeId: string,
  send: () => Promise<void>,
): Promise<ChallengeNotificationDelivery> {
  try {
    await send();
    return { delivered: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[call-bs] ${label} notification failed for challenge ${challengeId} — the Challenge action itself is unaffected:`, message);
    return { delivered: false, error: message };
  }
}

async function getDisplayName(userId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("user_profiles").select("display_name").eq("id", userId).maybeSingle();
  return data?.display_name ?? "Someone";
}

/** §40 "Sent": the recipient learns a specific user called BS on their Pick. */
export async function createChallengeReceivedNotification(challenge: Challenge): Promise<void> {
  const [challengerName, { question, postId }] = await Promise.all([getDisplayName(challenge.challengerUserId), getMarketNotificationContext(challenge.marketId)]);

  await insertNotifications("CALL_BS_RECEIVED", {
    user_id: challenge.recipientUserId,
    type: "CALL_BS_RECEIVED",
    title: "Someone called BS",
    body: `${challengerName} called BS on your pick on "${question}".`,
    challenge_id: challenge.id,
    market_id: challenge.marketId,
    post_id: postId,
  });
}

/** §40 "Accepted": the challenger learns the recipient accepted. */
export async function createChallengeAcceptedNotification(challenge: Challenge): Promise<void> {
  const [recipientName, { question, postId }] = await Promise.all([getDisplayName(challenge.recipientUserId), getMarketNotificationContext(challenge.marketId)]);

  await insertNotifications("CALL_BS_ACCEPTED", {
    user_id: challenge.challengerUserId,
    type: "CALL_BS_ACCEPTED",
    title: "Call BS accepted",
    body: `${recipientName} accepted your Call BS on "${question}". Both picks are locked in.`,
    challenge_id: challenge.id,
    market_id: challenge.marketId,
    post_id: postId,
  });
}

/** §40 "Declined": the challenger learns the recipient declined. No penalty, no locking — purely informational. */
export async function createChallengeDeclinedNotification(challenge: Challenge): Promise<void> {
  const [recipientName, { question, postId }] = await Promise.all([getDisplayName(challenge.recipientUserId), getMarketNotificationContext(challenge.marketId)]);

  await insertNotifications("CALL_BS_DECLINED", {
    user_id: challenge.challengerUserId,
    type: "CALL_BS_DECLINED",
    title: "Call BS declined",
    body: `${recipientName} declined your Call BS on "${question}".`,
    challenge_id: challenge.id,
    market_id: challenge.marketId,
    post_id: postId,
  });
}

/** §40 "Resolved": both participants learn the result. Fires exactly once per newly-resolved Challenge (lib/challenges/resolution.ts's own idempotency guard ensures this is never called twice for the same row — §36). */
export async function createChallengeResolvedNotifications({ challenge }: { challenge: Challenge }): Promise<void> {
  const [challengerName, recipientName, { question, postId }] = await Promise.all([
    getDisplayName(challenge.challengerUserId),
    getDisplayName(challenge.recipientUserId),
    getMarketNotificationContext(challenge.marketId),
  ]);

  if (challenge.result === "VOID") {
    const body = `Your Call BS on "${question}" was void — no result.`;
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
      body: challengerWon ? `You beat ${recipientName} on "${question}".` : `${recipientName} beat you on "${question}".`,
      challenge_id: challenge.id,
      market_id: challenge.marketId,
      post_id: postId,
    },
    {
      user_id: challenge.recipientUserId,
      type: "CALL_BS_RESOLVED",
      title: challengerWon ? "You lost a Call BS" : "You won a Call BS",
      body: challengerWon ? `${challengerName} beat you on "${question}".` : `You beat ${challengerName} on "${question}".`,
      challenge_id: challenge.id,
      market_id: challenge.marketId,
      post_id: postId,
    },
  ]);
}
