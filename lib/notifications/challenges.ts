import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
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

async function getMarketQuestion(marketId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("markets").select("question").eq("id", marketId).maybeSingle();
  return data?.question ?? "a market";
}

async function getDisplayName(userId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("user_profiles").select("display_name").eq("id", userId).maybeSingle();
  return data?.display_name ?? "Someone";
}

/** §40 "Sent": the recipient learns a specific user called BS on their Pick. */
export async function createChallengeReceivedNotification(challenge: Challenge): Promise<void> {
  const admin = createAdminClient();
  const [challengerName, question] = await Promise.all([getDisplayName(challenge.challengerUserId), getMarketQuestion(challenge.marketId)]);

  await admin.from("notifications").insert({
    user_id: challenge.recipientUserId,
    type: "CALL_BS_RECEIVED",
    title: "Someone called BS",
    body: `${challengerName} called BS on your pick on "${question}".`,
    challenge_id: challenge.id,
  });
}

/** §40 "Accepted": the challenger learns the recipient accepted. */
export async function createChallengeAcceptedNotification(challenge: Challenge): Promise<void> {
  const admin = createAdminClient();
  const [recipientName, question] = await Promise.all([getDisplayName(challenge.recipientUserId), getMarketQuestion(challenge.marketId)]);

  await admin.from("notifications").insert({
    user_id: challenge.challengerUserId,
    type: "CALL_BS_ACCEPTED",
    title: "Call BS accepted",
    body: `${recipientName} accepted your Call BS on "${question}". Both picks are locked in.`,
    challenge_id: challenge.id,
  });
}

/** §40 "Declined": the challenger learns the recipient declined. No penalty, no locking — purely informational. */
export async function createChallengeDeclinedNotification(challenge: Challenge): Promise<void> {
  const admin = createAdminClient();
  const [recipientName, question] = await Promise.all([getDisplayName(challenge.recipientUserId), getMarketQuestion(challenge.marketId)]);

  await admin.from("notifications").insert({
    user_id: challenge.challengerUserId,
    type: "CALL_BS_DECLINED",
    title: "Call BS declined",
    body: `${recipientName} declined your Call BS on "${question}".`,
    challenge_id: challenge.id,
  });
}

/** §40 "Resolved": both participants learn the result. Fires exactly once per newly-resolved Challenge (lib/challenges/resolution.ts's own idempotency guard ensures this is never called twice for the same row — §36). */
export async function createChallengeResolvedNotifications({ challenge }: { challenge: Challenge }): Promise<void> {
  const admin = createAdminClient();
  const [challengerName, recipientName, question] = await Promise.all([
    getDisplayName(challenge.challengerUserId),
    getDisplayName(challenge.recipientUserId),
    getMarketQuestion(challenge.marketId),
  ]);

  if (challenge.result === "VOID") {
    const body = `Your Call BS on "${question}" was void — no result.`;
    await admin.from("notifications").insert([
      { user_id: challenge.challengerUserId, type: "CALL_BS_RESOLVED", title: "Call BS void", body, challenge_id: challenge.id },
      { user_id: challenge.recipientUserId, type: "CALL_BS_RESOLVED", title: "Call BS void", body, challenge_id: challenge.id },
    ]);
    return;
  }

  const challengerWon = challenge.result === "CHALLENGER_WON";
  await admin.from("notifications").insert([
    {
      user_id: challenge.challengerUserId,
      type: "CALL_BS_RESOLVED",
      title: challengerWon ? "You won a Call BS" : "You lost a Call BS",
      body: challengerWon ? `You beat ${recipientName} on "${question}".` : `${recipientName} beat you on "${question}".`,
      challenge_id: challenge.id,
    },
    {
      user_id: challenge.recipientUserId,
      type: "CALL_BS_RESOLVED",
      title: challengerWon ? "You lost a Call BS" : "You won a Call BS",
      body: challengerWon ? `${challengerName} beat you on "${question}".` : `You beat ${challengerName} on "${question}".`,
      challenge_id: challenge.id,
    },
  ]);
}
