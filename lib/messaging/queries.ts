import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Reads for the signed-in Member's own Messaging. They run as THAT Member (the RLS client, not the service role), so the database policies are what limit them: a Member can only ever read
// their own conversations and the messages in them, and nothing here can be pointed at someone else's. A conversation id that is not theirs is indistinguishable from one that does not exist.

export interface Counterpart {
  id: string | null;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  /** The account is gone, closed or inactive: the conversation is read-only and shows a neutral name. */
  unavailable: boolean;
}

export interface InboxRow {
  conversationId: string;
  /** `request` = someone asked to message YOU; `sent_request` = you asked and are waiting; `conversation` = established. */
  kind: "conversation" | "request" | "sent_request";
  counterpart: Counterpart;
  lastMessageAt: string;
  preview: string | null;
  previewRemoved: boolean;
  fromMe: boolean;
  unread: boolean;
  muted: boolean;
}

export interface Inbox {
  conversations: InboxRow[];
  requests: InboxRow[];
}

const SHARE_PREVIEW: Record<string, string> = { POST: "Shared a Game", MARKET: "Shared a Market", PICK: "Shared a Pick", CALL_BS: "Shared a Call BS" };
const PREVIEW_LENGTH = 90;
const INBOX_PAGE = 100;

const DELETED: Counterpart = { id: null, displayName: "Deleted Member", username: null, avatarUrl: null, unavailable: true };

// A Member's session can read only their own user_profiles row (RLS), and public profile data is served by a server-side loader — so a counterpart's card is read the same way, with ONLY the fields a
// public profile already shows (name, username, avatar) plus whether the account is active. It is called only for ids that come out of the Member's own conversations (already filtered by RLS) or for
// the one Member they explicitly chose to message; it is never a way to look up arbitrary people.
async function loadCounterparts(ids: string[]): Promise<Map<string, Counterpart>> {
  const map = new Map<string, Counterpart>();
  if (ids.length === 0) return map;
  const { data } = await createAdminClient().from("user_profiles").select("id, display_name, username, avatar_url, is_active").in("id", ids);
  for (const p of data ?? []) {
    map.set(p.id, { id: p.id, displayName: p.display_name, username: p.username, avatarUrl: p.avatar_url, unavailable: p.is_active !== true });
  }
  return map;
}

/** The card for ONE Member the viewer chose to message (the profile "Message" entry). */
export async function getMemberCard(memberId: string): Promise<Counterpart | null> {
  return (await loadCounterparts([memberId])).get(memberId) ?? null;
}

export async function getInbox(viewerId: string): Promise<Inbox> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("messaging_inbox", { p_limit: INBOX_PAGE });
  const rows = (data ?? []) as Array<{
    conversation_id: string; status: string; opened_by: string | null; counterpart_id: string | null; last_message_at: string; last_sender_id: string | null; message_count: number;
    last_read_seq: number; muted: boolean; preview_kind: string | null; preview_body: string | null; preview_share_type: string | null; preview_removed: boolean;
  }>;
  const counterparts = await loadCounterparts([...new Set(rows.map((r) => r.counterpart_id).filter((id): id is string => Boolean(id)))]);

  const inbox: Inbox = { conversations: [], requests: [] };
  for (const r of rows) {
    const iOpened = r.opened_by === viewerId;
    // A declined request is invisible to the person who declined it, and to the sender it simply still reads as a request they sent (a decline is never announced).
    if (r.status === "DECLINED" && !iOpened) continue;
    const kind: InboxRow["kind"] = r.status === "ACTIVE" ? "conversation" : iOpened ? "sent_request" : "request";
    const preview = r.preview_removed ? null : r.preview_kind === "SHARE" ? (SHARE_PREVIEW[r.preview_share_type ?? ""] ?? "Shared something") : (r.preview_body ?? "").slice(0, PREVIEW_LENGTH) || null;
    const row: InboxRow = {
      conversationId: r.conversation_id,
      kind,
      counterpart: (r.counterpart_id && counterparts.get(r.counterpart_id)) || DELETED,
      lastMessageAt: r.last_message_at,
      preview,
      previewRemoved: r.preview_removed,
      fromMe: r.last_sender_id === viewerId,
      unread: r.status === "ACTIVE" && r.last_sender_id !== viewerId && r.message_count > r.last_read_seq,
      muted: r.muted,
    };
    (kind === "request" ? inbox.requests : inbox.conversations).push(row);
  }
  return inbox;
}

export interface UnreadSummary {
  unreadConversations: number;
  pendingRequests: number;
}

/** The nav badge: one indexed query for the signed-in Member. Zero for anyone who is not a participant of anything (including a Sponsor session). */
export async function getUnreadSummary(): Promise<UnreadSummary> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("messaging_unread_summary");
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return { unreadConversations: 0, pendingRequests: 0 };
  return { unreadConversations: Number(row.unread_conversations ?? 0), pendingRequests: Number(row.pending_requests ?? 0) };
}

export interface MessageView {
  id: string;
  seq: number;
  /** Who wrote it (always a participant of this conversation); a shared Pick is attributed to THIS, never to anything the client supplies. */
  senderId: string | null;
  fromMe: boolean;
  kind: "TEXT" | "SHARE";
  body: string | null;
  shareType: string | null;
  shareRef: string | null;
  createdAt: string;
  /** Unsent by its sender or removed by moderation: shown as a tombstone, never as content. */
  removed: "UNSENT" | "MODERATED" | null;
  isRequest: boolean;
}

export interface ConversationView {
  id: string;
  status: "PENDING" | "ACTIVE" | "DECLINED";
  counterpart: Counterpart;
  /** I opened it and am waiting (a declined request still reads as waiting to me). */
  iAmRequester: boolean;
  /** Someone asked to message me and I have not answered. */
  incomingRequest: boolean;
  muted: boolean;
  blockedByMe: boolean;
  messageCount: number;
  messages: MessageView[];
}

interface RawMessage {
  id: string; seq: number; sender_id: string | null; kind: "TEXT" | "SHARE"; body: string | null; share_type: string | null; share_ref: string | null; created_at: string;
  unsent_at: string | null; moderation_removed_at: string | null; is_request: boolean;
}

export const MESSAGE_COLUMNS = "id, seq, sender_id, kind, body, share_type, share_ref, created_at, unsent_at, moderation_removed_at, is_request";
const THREAD_PAGE = 60;

export function toMessageView(m: RawMessage, viewerId: string): MessageView {
  return {
    id: m.id,
    seq: m.seq,
    senderId: m.sender_id,
    fromMe: m.sender_id === viewerId,
    kind: m.kind,
    body: m.unsent_at || m.moderation_removed_at ? null : m.body,
    shareType: m.unsent_at || m.moderation_removed_at ? null : m.share_type,
    shareRef: m.unsent_at || m.moderation_removed_at ? null : m.share_ref,
    createdAt: m.created_at,
    removed: m.unsent_at ? "UNSENT" : m.moderation_removed_at ? "MODERATED" : null,
    isRequest: m.is_request,
  };
}

/** One conversation for its participant, or null (same answer for "not yours" and "does not exist"). */
export async function getConversation(viewerId: string, conversationId: string): Promise<ConversationView | null> {
  const supabase = await createClient();
  const { data: c } = await supabase.from("conversations").select("id, status, opened_by, member_low, member_high, message_count").eq("id", conversationId).maybeSingle();
  if (!c) return null;
  const otherId = c.member_low === viewerId ? c.member_high : c.member_low;
  const [{ data: mine }, { data: blocks }, { data: rows }, counterparts] = await Promise.all([
    supabase.from("conversation_participants").select("muted_at").eq("conversation_id", c.id).eq("member_id", viewerId).maybeSingle(),
    otherId ? supabase.from("member_blocks").select("blocked_id").eq("blocked_id", otherId) : Promise.resolve({ data: [] as Array<{ blocked_id: string }> }),
    supabase.from("messages").select(MESSAGE_COLUMNS).eq("conversation_id", c.id).order("seq", { ascending: false }).limit(THREAD_PAGE),
    loadCounterparts(otherId ? [otherId] : []),
  ]);
  const messages = ((rows ?? []) as RawMessage[]).map((m) => toMessageView(m, viewerId)).reverse();
  const iOpened = c.opened_by === viewerId;
  return {
    id: c.id,
    status: c.status,
    counterpart: (otherId && counterparts.get(otherId)) || DELETED,
    iAmRequester: c.status !== "ACTIVE" && iOpened,
    incomingRequest: c.status === "PENDING" && !iOpened,
    muted: Boolean(mine?.muted_at),
    blockedByMe: (blocks ?? []).length > 0,
    messageCount: c.message_count,
    messages,
  };
}

/** The existing conversation with one specific Member, if any (for the profile "Message" entry). */
export async function findConversationWith(viewerId: string, otherId: string): Promise<{ id: string } | null> {
  const [low, high] = viewerId < otherId ? [viewerId, otherId] : [otherId, viewerId];
  const supabase = await createClient();
  const { data } = await supabase.from("conversations").select("id").eq("member_low", low).eq("member_high", high).maybeSingle();
  return data ?? null;
}

export interface Delta {
  messages: MessageView[];
  serverTime: string;
}

/**
 * What changed since the caller last looked: new messages (by sequence) and any message unsent or removed since `sinceIso`. ONE cursor-based, indexed read of the caller's own conversation through RLS —
 * never a re-read of the history. A conversation that is not the caller's simply returns nothing (the same as "no news"), so this cannot be used to probe for other people's conversations.
 */
export async function getConversationDelta(viewerId: string, conversationId: string, afterSeq: number, sinceIso: string): Promise<Delta> {
  const supabase = await createClient();
  const serverTime = new Date().toISOString();
  const { data } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .or(`seq.gt.${afterSeq},unsent_at.gt.${sinceIso},moderation_removed_at.gt.${sinceIso}`)
    .order("seq", { ascending: true })
    .limit(100);
  return { messages: ((data ?? []) as RawMessage[]).map((m) => toMessageView(m, viewerId)), serverTime };
}
