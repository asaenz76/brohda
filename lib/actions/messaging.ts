"use server";

import { revalidatePath } from "next/cache";
import { requireMemberAccount } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMessagingConfig } from "@/lib/messaging/config";
import { findConversationWith } from "@/lib/messaging/queries";
import { messagingOutcomeCopy, isMessagingSuccess } from "@/lib/messaging/outcomes";
import { normalizeMessageText } from "@/lib/messaging/text";
import { isUuid, parseBrohdaLink, resolveSharedObject, senderMayShare, type ShareTarget, type ShareType } from "@/lib/messaging/share";
import { checkMessagingReportRateLimit, checkMessagingRequestRateLimit, checkMessagingSendRateLimit } from "@/lib/rate-limit/messaging";

// Every Messaging write. Each action: (1) requires a signed-in active MEMBER (a Sponsor session is redirected away and never gets here), (2) is refused outright while the capability is OFF,
// (3) rate-limits on the server, and (4) calls a service-role database function with the authenticated Member's own id — a client-supplied "who am I" is never accepted. The database functions
// then enforce the actual rules (the two-Member invariant, the request limit, blocks, the unsend window), so a direct call that skips this file gets the same answers.

export interface MessagingActionResult {
  ok: boolean;
  outcome: string;
  /** Plain words for the Member. */
  message: string;
  conversationId?: string;
  messageId?: string;
}

function result(outcome: string | undefined, extra: Partial<MessagingActionResult> = {}, maxLength?: number): MessagingActionResult {
  const o = outcome ?? "error";
  return { ok: isMessagingSuccess(o), outcome: o, message: messagingOutcomeCopy(o, maxLength), ...extra };
}

async function gate() {
  const user = await requireMemberAccount();
  const config = await getMessagingConfig();
  return { user, config };
}

/** Is the conversation with this Member established? A new or pending one is what the tighter request limiter protects. */
async function conversationIsActive(viewerId: string, otherId: string): Promise<boolean> {
  const existing = await findConversationWith(viewerId, otherId);
  if (!existing) return false;
  const { data } = await createAdminClient().from("conversations").select("status").eq("id", existing.id).maybeSingle();
  return data?.status === "ACTIVE";
}

/** Is a temporary restriction on opening NEW requests in force for this Member? Applied only by an explicit, switched-on abuse rule; a failed lookup never blocks anyone. */
async function requestsRestricted(userId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("messaging_is_restricted", { p_user_id: userId });
  return !error && data === true;
}

async function sendThroughDatabase(userId: string, recipientId: string, args: { kind: "TEXT" | "SHARE"; body: string | null; share: ShareTarget | null; idempotencyKey: string }, maxLength: number) {
  const { data, error } = await createAdminClient().rpc("messaging_send", {
    p_user_id: userId,
    p_recipient_id: recipientId,
    p_kind: args.kind,
    p_body: args.body,
    p_share_type: args.share?.type ?? null,
    p_share_ref: args.share?.ref ?? null,
    p_idempotency_key: args.idempotencyKey,
  });
  if (error) {
    // `not_a_member` and the like are security refusals, not ordinary outcomes: say nothing specific.
    return result("error");
  }
  const row = data as { outcome: string; conversationId?: string; messageId?: string } | null;
  return result(row?.outcome, { conversationId: row?.conversationId, messageId: row?.messageId }, maxLength);
}

export async function sendMessageAction(input: { recipientId: string; body: string; idempotencyKey: string }): Promise<MessagingActionResult> {
  const { user, config } = await gate();
  if (!config) return result("messaging_disabled");
  if (!isUuid(input.recipientId) || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100) return result("error");
  const body = normalizeMessageText(String(input.body ?? ""));
  if (!body) return result("empty");
  if (body.length > config.maxMessageLength) return result("too_long", {}, config.maxMessageLength);
  if (!(await checkMessagingSendRateLimit(user.id, config))) return result("rate_limited");
  if (!(await conversationIsActive(user.id, input.recipientId))) {
    if (await requestsRestricted(user.id)) return result("restricted");
    if (!(await checkMessagingRequestRateLimit(user.id, config))) return result("rate_limited");
  }
  return sendThroughDatabase(user.id, input.recipientId, { kind: "TEXT", body, share: null, idempotencyKey: input.idempotencyKey }, config.maxMessageLength);
}

/** Share a Brohda object: either one the Member chose from their own list (type + id) or a pasted Brohda Post/Market link. */
export async function shareObjectAction(input: { recipientId: string; type?: ShareType; ref?: string; link?: string; idempotencyKey: string }): Promise<MessagingActionResult> {
  const { user, config } = await gate();
  if (!config) return result("messaging_disabled");
  if (!isUuid(input.recipientId) || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100) return result("error");
  const target: ShareTarget | null = input.link ? parseBrohdaLink(input.link) : input.type && input.ref ? { type: input.type, ref: input.ref } : null;
  if (!target || !["POST", "MARKET", "PICK", "CALL_BS"].includes(target.type)) return result("invalid_share");
  // The sender's own authority over what they share is re-checked here, whatever the client sent.
  if (!(await senderMayShare(user.id, target))) return result("share_unavailable");
  if (!(await checkMessagingSendRateLimit(user.id, config))) return result("rate_limited");
  if (!(await conversationIsActive(user.id, input.recipientId))) {
    if (await requestsRestricted(user.id)) return result("restricted");
    if (!(await checkMessagingRequestRateLimit(user.id, config))) return result("rate_limited");
  }
  return sendThroughDatabase(user.id, input.recipientId, { kind: "SHARE", body: null, share: target, idempotencyKey: input.idempotencyKey }, config.maxMessageLength);
}

export async function respondToRequestAction(conversationId: string, action: "ACCEPT" | "DECLINE"): Promise<MessagingActionResult> {
  const { user, config } = await gate();
  if (!config) return result("messaging_disabled");
  if (!isUuid(conversationId) || (action !== "ACCEPT" && action !== "DECLINE")) return result("error");
  if (!(await checkMessagingSendRateLimit(user.id, config))) return result("rate_limited");
  const { data, error } = await createAdminClient().rpc("messaging_respond_request", { p_user_id: user.id, p_conversation_id: conversationId, p_action: action });
  if (error) return result("error");
  revalidatePath("/messages");
  return result((data as { outcome?: string } | null)?.outcome, { conversationId });
}

export async function setMuteAction(conversationId: string, muted: boolean): Promise<MessagingActionResult> {
  const { user, config } = await gate();
  if (!config) return result("messaging_disabled");
  if (!isUuid(conversationId)) return result("error");
  if (!(await checkMessagingSendRateLimit(user.id, config))) return result("rate_limited");
  const { data, error } = await createAdminClient().rpc("messaging_set_mute", { p_user_id: user.id, p_conversation_id: conversationId, p_muted: Boolean(muted) });
  if (error || data !== true) return result("not_found");
  revalidatePath("/messages");
  return { ok: true, outcome: muted ? "muted" : "unmuted", message: muted ? "Muted. You won't be notified of new messages." : "Unmuted." };
}

export async function setBlockAction(memberId: string, blocked: boolean): Promise<MessagingActionResult> {
  const { user, config } = await gate();
  if (!config) return result("messaging_disabled");
  if (!isUuid(memberId)) return result("error");
  if (!(await checkMessagingSendRateLimit(user.id, config))) return result("rate_limited");
  const { data, error } = await createAdminClient().rpc("messaging_set_block", { p_user_id: user.id, p_blocked_id: memberId, p_blocked: Boolean(blocked) });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || !outcome || outcome === "not_found" || outcome === "self") return result(outcome === "self" ? "self" : "not_found");
  revalidatePath("/messages");
  return { ok: true, outcome, message: blocked ? "Blocked. They can no longer message you." : "Unblocked." };
}

export async function unsendMessageAction(messageId: string): Promise<MessagingActionResult> {
  const { user, config } = await gate();
  if (!config) return result("messaging_disabled");
  if (!isUuid(messageId)) return result("error");
  if (!(await checkMessagingSendRateLimit(user.id, config))) return result("rate_limited");
  const { data, error } = await createAdminClient().rpc("messaging_unsend", { p_user_id: user.id, p_message_id: messageId });
  if (error) return result("error");
  return result((data as { outcome?: string } | null)?.outcome, { messageId });
}

export async function reportAction(input: { conversationId: string; messageId: string | null; reason: string; note: string }): Promise<MessagingActionResult> {
  const { user, config } = await gate();
  if (!config) return result("messaging_disabled");
  if (!isUuid(input.conversationId) || (input.messageId !== null && !isUuid(input.messageId))) return result("error");
  if (!(await checkMessagingReportRateLimit(user.id, config))) return result("rate_limited");
  const { data, error } = await createAdminClient().rpc("messaging_report", {
    p_user_id: user.id, p_conversation_id: input.conversationId, p_message_id: input.messageId, p_reason: input.reason, p_note: normalizeMessageText(String(input.note ?? "")).slice(0, 1000) || null,
  });
  if (error) return result("error");
  return result((data as { outcome?: string } | null)?.outcome);
}

/** Moves the Member's read cursor. One row update per call, only while Messaging is on. */
export async function markConversationReadAction(conversationId: string, seq: number): Promise<void> {
  const { user, config } = await gate();
  if (!config || !isUuid(conversationId) || !Number.isFinite(seq)) return;
  await createAdminClient().rpc("messaging_mark_read", { p_user_id: user.id, p_conversation_id: conversationId, p_seq: Math.max(0, Math.floor(seq)) });
}

export interface ShareChoice {
  type: ShareType;
  ref: string;
  title: string;
  detail: string | null;
}

/** The Member's own recent Picks and Call BS, as share choices (title and detail are resolved the same way a recipient would see them). */
export async function listShareChoicesAction(): Promise<ShareChoice[]> {
  const { user, config } = await gate();
  if (!config) return [];
  const admin = createAdminClient();
  const [{ data: picks }, { data: callBs }] = await Promise.all([
    admin.from("predictions").select("id").eq("user_id", user.id).order("created_at", { ascending: false }).limit(8),
    admin.from("challenges").select("id").or(`challenger_user_id.eq.${user.id},recipient_user_id.eq.${user.id}`).order("created_at", { ascending: false }).limit(8),
  ]);
  const wanted: ShareTarget[] = [...(picks ?? []).map((p) => ({ type: "PICK" as const, ref: p.id })), ...(callBs ?? []).map((c) => ({ type: "CALL_BS" as const, ref: c.id }))];
  const views = await Promise.all(wanted.map((t) => resolveSharedObject(user.id, user.id, t)));
  const out: ShareChoice[] = [];
  views.forEach((v, i) => {
    if (v.state === "ok") out.push({ type: wanted[i].type, ref: wanted[i].ref, title: v.title, detail: v.detail });
  });
  return out;
}
