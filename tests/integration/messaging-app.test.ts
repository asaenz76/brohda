/**
 * Member Messaging, application layer against the real database: the inbox and unread functions under RLS, the sharing rules (who may share what, and what each viewer may see), the permanent
 * exclusions as schema guards (no group, no media), the incremental poll query, the fail-closed capability and settings parity.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedPick, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { getMessagingConfig } from "@/lib/messaging/config";
import { resolveSharedObject, senderMayShare } from "@/lib/messaging/share";
import { MESSAGING_BOOLEAN_FIELDS, MESSAGING_SETTING_FIELDS } from "@/lib/messaging/settings-fields";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rpc = async (name: string, args: Record<string, unknown>) => (await admin.rpc(name, args)) as { data: Row | null; error: { message: string } | null };
let n = 0;
const text = () => `m${++n} ${randomUUID().slice(0, 6)}`;
const sendText = async (from: string, to: string) => {
  const r = await rpc("messaging_send", { p_user_id: from, p_recipient_id: to, p_kind: "TEXT", p_body: text(), p_share_type: null, p_share_ref: null, p_idempotency_key: randomUUID() });
  expect(r.error, r.error?.message).toBeNull();
  expect(r.data?.outcome).toBe("sent");
  return r.data!;
};
async function clientFor(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const c = getTestAnonClient();
  expect((await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD })).error).toBeNull();
  return c;
}
async function activePair() {
  const a = await seedUser("app-a");
  const b = await seedUser("app-b");
  const first = await sendText(a, b);
  await rpc("messaging_respond_request", { p_user_id: b, p_conversation_id: first.conversationId, p_action: "ACCEPT" });
  return { a, b, conversationId: first.conversationId as string };
}

let saved: Row | null = null;
beforeEach(async () => {
  const { data } = await admin.from("platform_settings").select("messaging_enabled").eq("id", true).single();
  saved = data;
  await admin.from("platform_settings").update({ messaging_enabled: true }).eq("id", true);
});
afterEach(async () => {
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});

describe("the inbox and the unread badge run as the signed-in Member (RLS), one query each", () => {
  it("the inbox lists the Member's own conversations newest first, with a preview, the counterpart and the read state", async () => {
    const a = await seedUser("inbox-a");
    const b = await seedUser("inbox-b");
    const c = await seedUser("inbox-c");
    const f1 = await sendText(a, b);
    await rpc("messaging_respond_request", { p_user_id: b, p_conversation_id: f1.conversationId, p_action: "ACCEPT" });
    await sendText(b, a);
    const f2 = await sendText(c, a); // a request from C to A
    const asA = await clientFor(a);
    const { data, error } = await asA.rpc("messaging_inbox", { p_limit: 20 });
    expect(error).toBeNull();
    const rows = data as Row[];
    expect(rows.map((r) => r.conversation_id)).toEqual([f2.conversationId, f1.conversationId]); // newest activity first
    expect(rows[0]).toMatchObject({ status: "PENDING", counterpart_id: c, opened_by: c });
    expect(rows[1]).toMatchObject({ status: "ACTIVE", counterpart_id: b, last_sender_id: b });
    expect(typeof rows[1].preview_body).toBe("string");
    expect(rows[1].muted).toBe(false);
  });

  it("another Member, a Sponsor and an anonymous client get an EMPTY inbox, and nobody sees someone else's conversation", async () => {
    const { a, b } = await activePair();
    const stranger = await seedUser("inbox-stranger");
    const sponsor = await seedSponsorAccount("InboxSponsor");
    const asSponsor = getTestAnonClient();
    expect((await asSponsor.auth.signInWithPassword({ email: sponsor.email, password: PASSWORD })).error).toBeNull();
    for (const client of [await clientFor(stranger), asSponsor]) {
      const { data } = await client.rpc("messaging_inbox", { p_limit: 20 });
      expect(data).toEqual([]);
      const { data: unread } = await client.rpc("messaging_unread_summary");
      expect((Array.isArray(unread) ? unread[0] : unread)).toMatchObject({ unread_conversations: 0, pending_requests: 0 });
    }
    expect((await getTestAnonClient().rpc("messaging_inbox", { p_limit: 20 })).error).not.toBeNull(); // closed to the public
    expect(a).not.toBe(b);
  });

  it("an unsent last message shows as removed in the inbox, never its text", async () => {
    const { a, b } = await activePair();
    const m = await sendText(a, b);
    await rpc("messaging_unsend", { p_user_id: a, p_message_id: m.messageId });
    const asB = await clientFor(b);
    const rows = ((await asB.rpc("messaging_inbox", { p_limit: 20 })).data as Row[]).filter((r) => r.counterpart_id === a);
    expect(rows[0].preview_removed).toBe(true);
    expect(rows[0].preview_body).toBeNull();
  });

  it("unread counts the conversations awaiting the reader and the requests awaiting an answer, and drops when read", async () => {
    const { a, b, conversationId } = await activePair();
    const x = await seedUser("unread-x");
    await sendText(x, b); // a pending request to B
    await sendText(a, b); // an unread message from A in the active conversation
    const asB = await clientFor(b);
    const summary = async () => {
      const { data } = await asB.rpc("messaging_unread_summary");
      return (Array.isArray(data) ? data[0] : data) as Row;
    };
    expect(await summary()).toMatchObject({ unread_conversations: 1, pending_requests: 1 });
    const conv = (await admin.from("conversations").select("message_count").eq("id", conversationId).single()).data!;
    await rpc("messaging_mark_read", { p_user_id: b, p_conversation_id: conversationId, p_seq: conv.message_count });
    expect(await summary()).toMatchObject({ unread_conversations: 0, pending_requests: 1 });
    // The sender never counts their own message as unread.
    const asA = await clientFor(a);
    const { data } = await asA.rpc("messaging_unread_summary");
    expect((Array.isArray(data) ? data[0] : data)).toMatchObject({ unread_conversations: 0 });
  });
});

describe("the poll query: new messages by cursor, plus anything unsent since the last look", () => {
  it("returns only what is new or changed, in order, and nothing for a conversation that is not the caller's", async () => {
    const { a, b, conversationId } = await activePair();
    const m1 = await sendText(a, b);
    const m2 = await sendText(b, a);
    const asB = await clientFor(b);
    const delta = async (afterSeq: number, since: string, client = asB) =>
      ((await client.from("messages").select("id, seq, unsent_at").eq("conversation_id", conversationId).or(`seq.gt.${afterSeq},unsent_at.gt.${since},moderation_removed_at.gt.${since}`).order("seq")).data ?? []) as Row[];
    expect((await delta(m1.seq, new Date(Date.now() + 1000).toISOString())).map((m) => m.id)).toEqual([m2.messageId]); // after m1: only m2
    expect(await delta(m2.seq, new Date(Date.now() + 1000).toISOString())).toEqual([]); // nothing new
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 25));
    await rpc("messaging_unsend", { p_user_id: a, p_message_id: m1.messageId });
    const changed = await delta(m2.seq, since);
    expect(changed.map((m) => m.id)).toEqual([m1.messageId]); // an OLDER message that was unsent after the last look is picked up
    expect(changed[0].unsent_at).not.toBeNull();
    // A Member who is not in the conversation gets nothing.
    const outsider = await clientFor(await seedUser("poll-outsider"));
    expect(await delta(0, new Date(0).toISOString(), outsider)).toEqual([]);
  });
});

describe("sharing a Brohda object", () => {
  async function game() {
    const g = await seedGame({ startsInMinutes: 24 * 60 });
    const { data: post } = await admin.from("posts").insert({ fixture_id: g.fixtureId, published_at: new Date().toISOString() }).select("id").single();
    return { ...g, postId: post!.id as string };
  }

  it("a Post must be published; a Market must exist; neither needs the sender to own anything", async () => {
    const g = await game();
    const sender = await seedUser("share-s");
    expect(await senderMayShare(sender, { type: "POST", ref: g.postId })).toBe(true);
    expect(await senderMayShare(sender, { type: "MARKET", ref: g.marketId })).toBe(true);
    const { data: draft } = await admin.from("posts").insert({ fixture_id: (await seedGame()).fixtureId }).select("id").single();
    expect(await senderMayShare(sender, { type: "POST", ref: draft!.id })).toBe(false); // an unpublished Post is not shareable
    expect(await senderMayShare(sender, { type: "POST", ref: randomUUID() })).toBe(false);
    expect(await senderMayShare(sender, { type: "POST", ref: "not-a-uuid" })).toBe(false);
  });

  it("a Pick can only be shared by its OWNER, and the recipient sees it as the owner's Pick (Game, Market, side)", async () => {
    const g = await game();
    const owner = await seedUser("pick-owner");
    const other = await seedUser("pick-other");
    const pickId = await seedPick(owner, g.marketId, "YES");
    expect(await senderMayShare(owner, { type: "PICK", ref: pickId })).toBe(true);
    expect(await senderMayShare(other, { type: "PICK", ref: pickId })).toBe(false); // someone else's Pick is never shareable
    const seen = await resolveSharedObject(other, owner, { type: "PICK", ref: pickId });
    expect(seen).toMatchObject({ state: "ok", type: "PICK" });
    if (seen.state === "ok") {
      expect(seen.title).toBeTruthy();
      expect(seen.href).toBe(`/post/${g.postId}`);
      expect(JSON.stringify(seen)).not.toMatch(/user_id|email|confidence|stake|wallet/i);
    }
    // Attributed to the wrong sender, it simply does not resolve: a Pick is only ever shown as its owner's.
    expect(await resolveSharedObject(other, other, { type: "PICK", ref: pickId })).toEqual({ state: "unavailable" });
  });

  it("a Call BS can only be shared by a participant; the other participant sees it fully, anyone else only once it is RESOLVED", async () => {
    const g = await game();
    const [x, y, viewer] = [await seedUser("cb-x"), await seedUser("cb-y"), await seedUser("cb-viewer")];
    const px = await seedPick(x, g.marketId, "YES");
    const py = await seedPick(y, g.marketId, "NO");
    const { data: ch, error } = await admin
      .from("challenges")
      .insert({ market_id: g.marketId, challenger_user_id: x, recipient_user_id: y, challenger_prediction_id: px, recipient_prediction_id: py, challenger_selection_snapshot: "YES", recipient_selection_snapshot: "NO", status: "PENDING" })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    const target = { type: "CALL_BS" as const, ref: ch!.id as string };
    expect(await senderMayShare(x, target)).toBe(true);
    expect(await senderMayShare(y, target)).toBe(true);
    expect(await senderMayShare(viewer, target)).toBe(false); // not a participant
    expect((await resolveSharedObject(y, x, target)).state).toBe("ok"); // the other participant sees it
    expect(await resolveSharedObject(viewer, x, target)).toEqual({ state: "unavailable" }); // a bystander cannot learn of a pending Call BS through a message
    const now = new Date().toISOString();
    await admin.from("challenges").update({ status: "RESOLVED", accepted_at: now, resolved_at: now, result: "CHALLENGER_WON" }).eq("id", ch!.id);
    const resolved = await resolveSharedObject(viewer, x, target); // a resolved Call BS is already a public record
    expect(resolved).toMatchObject({ state: "ok", type: "CALL_BS" });
  });

  it("an object that has gone away is a calm 'unavailable', never an error", async () => {
    const g = await game();
    const owner = await seedUser("gone-owner");
    const pickId = await seedPick(owner, g.marketId, "NO");
    await admin.from("predictions").delete().eq("id", pickId);
    expect(await resolveSharedObject(owner, owner, { type: "PICK", ref: pickId })).toEqual({ state: "unavailable" });
    expect(await resolveSharedObject(owner, owner, { type: "POST", ref: randomUUID() })).toEqual({ state: "unavailable" });
    expect(await resolveSharedObject(owner, owner, { type: "MARKET", ref: "garbage" })).toEqual({ state: "unavailable" });
  });

  it("a stored share is only a (type, id) reference: no copy of the object is kept in the message", async () => {
    const { a, b } = await activePair();
    const g = await game();
    const r = await rpc("messaging_send", { p_user_id: a, p_recipient_id: b, p_kind: "SHARE", p_body: null, p_share_type: "POST", p_share_ref: g.postId, p_idempotency_key: randomUUID() });
    expect(r.data?.outcome).toBe("sent");
    const { data } = await admin.from("messages").select("*").eq("id", r.data!.messageId).single();
    expect(data!.body).toBeNull();
    expect(data!.share_type).toBe("POST");
    expect(data!.share_ref).toBe(g.postId);
  });
});

describe("the permanent exclusions are enforced by the schema", () => {
  // information_schema is not exposed through the REST API, so the schema is read over a direct connection.
  const columns = async (table: string): Promise<string[]> => {
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      const { rows } = await client.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table]);
      return rows.map((r: { column_name: string }) => r.column_name);
    } finally {
      await client.end();
    }
  };

  it("a message has text or a (type, id) share and NOTHING else: no image, media, file, voice, URL or attachment column anywhere in Messaging", async () => {
    const all = (await Promise.all(["messages", "conversations", "conversation_participants", "member_blocks", "message_reports", "message_unsent_evidence"].map(columns))).flat();
    expect(all.filter((c) => /image|media|photo|video|audio|voice|file|attach|upload|gif|sticker|url|link|storage|blob|mime/i.test(c))).toEqual([]);
    expect((await columns("messages")).sort()).toEqual(["body", "conversation_id", "created_at", "id", "idempotency_key", "is_request", "kind", "moderation_removed_at", "sender_id", "seq", "share_ref", "share_type", "unsent_at"].sort());
  });

  it("the share types are exactly the four Brohda objects, and the message kinds are exactly TEXT and SHARE", async () => {
    const { a, b } = await activePair();
    const bad = async (kind: string, shareType: string | null) =>
      (await rpc("messaging_send", { p_user_id: a, p_recipient_id: b, p_kind: kind, p_body: kind === "TEXT" ? "x" : null, p_share_type: shareType, p_share_ref: shareType ? randomUUID() : null, p_idempotency_key: randomUUID() })).error;
    expect(await bad("IMAGE", null)).not.toBeNull();
    expect(await bad("SHARE", "IMAGE")).not.toBeNull();
    expect(await bad("SHARE", "USER")).not.toBeNull();
    // And directly in the table: the constraints refuse anything else too.
    const conv = (await admin.from("conversations").select("id").limit(1).single()).data!;
    expect((await admin.from("messages").insert({ conversation_id: conv.id, seq: 9999, sender_id: a, kind: "IMAGE", body: "x" })).error).not.toBeNull();
  });

  it("there is no group concept: a conversation has two ordered member columns and a unique pair, and exactly two participant rows", async () => {
    expect((await columns("conversations")).filter((c) => /member|participant|owner|admin/i.test(c)).sort()).toEqual(["member_high", "member_low"]);
    const { conversationId } = await activePair();
    const { count } = await admin.from("conversation_participants").select("member_id", { count: "exact", head: true }).eq("conversation_id", conversationId);
    expect(count).toBe(2);
    const outsider = await seedUser("group-outsider");
    // The schema itself refuses a third participant, and refuses re-pointing the conversation at different Members.
    const third = await admin.from("conversation_participants").insert({ conversation_id: conversationId, member_id: outsider });
    expect(third.error?.message ?? "").toContain("not_a_participant");
    const conv = (await admin.from("conversations").select("member_low, member_high").eq("id", conversationId).single()).data!;
    const swap = await admin.from("conversations").update({ member_high: outsider }).eq("id", conversationId);
    expect(swap.error?.message ?? "").toContain("conversation_members_immutable");
    const swapLow = await admin.from("conversations").update({ member_low: outsider }).eq("id", conversationId);
    expect(swapLow.error?.message ?? "").toContain("conversation_members_immutable");
    expect((await admin.from("conversations").select("member_low, member_high").eq("id", conversationId).single()).data).toEqual(conv);
    // …while an account being removed (which sets the column to NULL) is still allowed, so history is never destroyed.
    const asOutsider = await clientFor(outsider);
    expect(((await asOutsider.from("messages").select("id").eq("conversation_id", conversationId)).data ?? [])).toEqual([]);
  });
});

describe("configuration", () => {
  it("is fail-closed against the real settings and returns the live policy", async () => {
    await admin.from("platform_settings").update({ messaging_enabled: false }).eq("id", true);
    expect(await getMessagingConfig()).toBeNull();
    await admin.from("platform_settings").update({ messaging_enabled: true, messaging_max_message_length: 777 }).eq("id", true);
    expect((await getMessagingConfig())?.maxMessageLength).toBe(777);
    await admin.from("platform_settings").update({ messaging_max_message_length: 1000 }).eq("id", true);
  });

  it("every messaging_* policy column is editable from the Super Admin form (nothing is a silent constant), and the form ranges match the table constraints", async () => {
    const { data } = await admin.from("platform_settings").select("*").eq("id", true).single();
    const columnsInTable = Object.keys(data!).filter((k) => k.startsWith("messaging_")).sort();
    const inForm = ["messaging_enabled", ...MESSAGING_BOOLEAN_FIELDS.map((f) => f.key), ...MESSAGING_SETTING_FIELDS.map((f) => f.key)].sort();
    expect(inForm).toEqual(columnsInTable);
    for (const f of MESSAGING_SETTING_FIELDS) {
      // The form's own bounds are accepted by the database, and one step outside each bound is refused.
      expect((await admin.from("platform_settings").update({ [f.key]: f.min }).eq("id", true)).error, `${f.key} min`).toBeNull();
      expect((await admin.from("platform_settings").update({ [f.key]: f.max }).eq("id", true)).error, `${f.key} max`).toBeNull();
      expect((await admin.from("platform_settings").update({ [f.key]: f.max + 1 }).eq("id", true)).error, `${f.key} above max`).not.toBeNull();
      if (f.min > 0) expect((await admin.from("platform_settings").update({ [f.key]: f.min - 1 }).eq("id", true)).error, `${f.key} below min`).not.toBeNull();
      await admin.from("platform_settings").update({ [f.key]: f.nullable ? null : f.min }).eq("id", true);
    }
    // Restore the shipped defaults for the next test.
    await admin.from("platform_settings").update({
      messaging_max_message_length: 1000, messaging_max_unanswered_requests: 2, messaging_unsend_window_seconds: 900, messaging_duplicate_window_seconds: 30, messaging_send_rate_window_seconds: 60, messaging_send_rate_max: 20,
      messaging_request_rate_window_seconds: 3600, messaging_request_rate_max: 5, messaging_report_rate_window_seconds: 3600, messaging_report_rate_max: 10, messaging_poll_interval_seconds: 10,
      messaging_abuse_window_seconds: 86400, messaging_abuse_requests_threshold: 12, messaging_abuse_declines_threshold: 3, messaging_abuse_blocks_threshold: 3, messaging_abuse_reports_threshold: 3,
      messaging_abuse_duplicate_threshold: 4, messaging_abuse_rapid_window_seconds: 600, messaging_abuse_rapid_threshold: 60, messaging_abuse_coordinated_threshold: 8, messaging_abuse_restrict_hours: 24,
      messaging_retention_unsent_days: 30, messaging_retention_reported_days: 180, messaging_retention_closed_account_days: 30, messaging_retention_audit_days: 365,
    }).eq("id", true);
  });
});
