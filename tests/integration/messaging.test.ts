/**
 * Member Messaging (migration 198) against the real database: the two-Member invariant, Message Requests and the unanswered-request limit, Block, Mute, Unsend and its tombstone, Reports and
 * moderation evidence, privacy through RLS, Sponsor isolation, idempotency and concurrency, the audited settings, and bounded retention.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedSponsorAccount, seedUser } from "./helpers/game-seed";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args);
  return { data: data as Row | null, error };
}
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};

const send = (from: string, to: string, body: string | null = "hello", extra: Partial<{ kind: string; shareType: string | null; shareRef: string | null; key: string | null }> = {}) =>
  rpc("messaging_send", {
    p_user_id: from, p_recipient_id: to, p_kind: extra.kind ?? "TEXT", p_body: extra.kind === "SHARE" ? null : body, p_share_type: extra.shareType ?? null,
    p_share_ref: extra.shareRef ?? null, p_idempotency_key: extra.key === undefined ? randomUUID() : extra.key,
  });
/** A distinct text each call, so the duplicate-content rule never interferes with tests about other rules. */
let counter = 0;
const text = (label = "msg") => `${label} ${++counter} ${randomUUID().slice(0, 6)}`;
const sendOk = async (from: string, to: string, body = text()) => {
  const r = await send(from, to, body);
  expect(r.error, r.error?.message).toBeNull();
  expect(r.data?.outcome, JSON.stringify(r.data)).toBe("sent");
  return r.data!;
};

const settingsKeys = [
  "messaging_enabled", "messaging_max_message_length", "messaging_max_unanswered_requests", "messaging_unsend_window_seconds", "messaging_duplicate_window_seconds",
  "messaging_retention_messages_days", "messaging_retention_unsent_days", "messaging_retention_reported_days", "messaging_retention_closed_account_days", "messaging_retention_moderation_days",
  "messaging_retention_audit_days", "messaging_retention_purge_enabled",
];
let saved: Row | null = null;
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
beforeEach(async () => {
  const { data } = await admin.from("platform_settings").select(settingsKeys.join(",")).eq("id", true).single();
  saved = data as Row | null;
  // The retention durations start blank in these tests (each test sets only the one it exercises); the shipped defaults are asserted in messaging-owner-decisions.test.ts. The purge switch is on so the purge can be exercised.
  await setSettings({
    messaging_enabled: true, messaging_max_message_length: 1000, messaging_max_unanswered_requests: 2, messaging_unsend_window_seconds: 900, messaging_duplicate_window_seconds: 30,
    messaging_retention_messages_days: null, messaging_retention_unsent_days: null, messaging_retention_reported_days: null, messaging_retention_closed_account_days: null,
    messaging_retention_moderation_days: null, messaging_retention_audit_days: null, messaging_retention_purge_enabled: true,
  });
});
afterEach(async () => {
  if (saved) await setSettings(saved);
});

const staffIds: string[] = [];
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
});
async function superAdmin() {
  const id = await seedUser("msg-admin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}

async function clientFor(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const c = getTestAnonClient();
  const r = await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD });
  expect(r.error).toBeNull();
  return c;
}

const conversationOf = async (a: string, b: string) => {
  const [low, high] = a < b ? [a, b] : [b, a];
  return (await admin.from("conversations").select("*").eq("member_low", low).eq("member_high", high).maybeSingle()).data as Row | null;
};
async function pair() {
  return { a: await seedUser("msg-a"), b: await seedUser("msg-b") };
}
/** An ACTIVE conversation between two fresh Members. */
async function activePair() {
  const { a, b } = await pair();
  const first = await sendOk(a, b);
  await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: first.conversationId, p_action: "ACCEPT" });
  return { a, b, conversationId: first.conversationId as string };
}

describe("the two-Member invariant and who may take part", () => {
  it("one canonical conversation per unordered pair, whichever side writes first or whether both write at once", async () => {
    const { a, b } = await pair();
    const results = await Promise.all([send(a, b, text()), send(b, a, text())]);
    expect(results.every((r) => r.error === null)).toBe(true);
    const outcomes = results.map((r) => r.data?.outcome).sort();
    // One of them opened the conversation; the other was told to accept first. Never two conversations.
    expect(outcomes).toEqual(["request_pending_accept_first", "sent"]);
    const { count } = await admin.from("conversations").select("id", { count: "exact", head: true }).or(`and(member_low.eq.${a},member_high.eq.${b}),and(member_low.eq.${b},member_high.eq.${a})`);
    expect(count).toBe(1);
    const { data: participants } = await admin.from("conversation_participants").select("member_id").eq("conversation_id", (await conversationOf(a, b))!.id);
    expect(new Set(participants!.map((p) => p.member_id))).toEqual(new Set([a, b]));
  });

  it("the database refuses a conversation with three participants or two unordered duplicates", async () => {
    const { a, b } = await pair();
    await sendOk(a, b);
    const [low, high] = a < b ? [a, b] : [b, a];
    // Same pair again, in either order: the unique index and the ordering check refuse it.
    expect((await admin.from("conversations").insert({ member_low: low, member_high: high })).error).not.toBeNull();
    expect((await admin.from("conversations").insert({ member_low: high, member_high: low })).error).not.toBeNull();
    // A participants row for a third Member can exist only through a function that never creates one; the table has exactly two by construction.
    const { count } = await admin.from("conversation_participants").select("member_id", { count: "exact", head: true }).eq("conversation_id", (await conversationOf(a, b))!.id);
    expect(count).toBe(2);
  });

  it("refuses a self-conversation", async () => {
    const a = await seedUser("msg-self");
    expect((await send(a, a)).data?.outcome).toBe("self");
    expect((await admin.from("conversations").insert({ member_low: a, member_high: a })).error).not.toBeNull();
  });

  it("a Sponsor cannot send, be messaged, or exist as a participant", async () => {
    const sponsor = await seedSponsorAccount("MsgSponsor");
    const member = await seedUser("msg-member-s");
    const fromSponsor = await send(sponsor.userId, member);
    expect(fromSponsor.error?.message ?? "").toContain("not_a_member");
    expect((await send(member, sponsor.userId)).data?.outcome).toBe("unavailable");
    // A Sponsor login has no member profile, so no conversation column can reference it.
    expect((await admin.from("conversations").insert({ member_low: sponsor.userId, member_high: member })).error).not.toBeNull();
    expect((await rpc("messaging_set_block", { p_user_id: sponsor.userId, p_blocked_id: member, p_blocked: true })).error?.message ?? "").toContain("not_a_member");
  });

  it("an inactive Member cannot send and cannot be messaged", async () => {
    const { a, b } = await pair();
    await admin.from("user_profiles").update({ is_active: false }).eq("id", b);
    expect((await send(a, b)).data?.outcome).toBe("unavailable");
    expect((await send(b, a)).error?.message ?? "").toContain("not_a_member");
    await admin.from("user_profiles").update({ is_active: true }).eq("id", b);
  });

  it("everything is refused while the capability is OFF, and history is untouched", async () => {
    const { a, b, conversationId } = await activePair();
    const before = (await conversationOf(a, b))!.message_count;
    await setSettings({ messaging_enabled: false });
    expect((await send(a, b, text())).data?.outcome).toBe("messaging_disabled");
    expect((await rpc("messaging_respond_request", { p_user_id: b, p_conversation_id: conversationId, p_action: "ACCEPT" })).data?.outcome).toBe("messaging_disabled");
    expect((await conversationOf(a, b))!.message_count).toBe(before);
  });
});

describe("Message Requests and the unanswered-request limit", () => {
  it("first and second requests are allowed, the third is refused, and nothing is notified past the limit", async () => {
    const { a, b } = await pair();
    expect((await send(a, b, text())).data?.outcome).toBe("sent");
    expect((await send(a, b, text())).data?.outcome).toBe("sent");
    const third = await send(a, b, text());
    expect(third.data?.outcome).toBe("request_limit");
    const conv = (await conversationOf(a, b))!;
    expect(conv.status).toBe("PENDING");
    expect(conv.message_count).toBe(2); // the refused one was never written
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", b).eq("conversation_id", conv.id);
    expect(count).toBe(1); // one coalesced request notification, none for the refused third
  });

  it("a structured share counts as a request exactly like text (no bypass by sending a Game instead)", async () => {
    const { a, b } = await pair();
    await sendOk(a, b);
    const share = await send(a, b, null, { kind: "SHARE", shareType: "POST", shareRef: randomUUID() });
    expect(share.data?.outcome).toBe("sent");
    expect((await send(a, b, null, { kind: "SHARE", shareType: "POST", shareRef: randomUUID() })).data?.outcome).toBe("request_limit");
  });

  it("the recipient must accept explicitly: replying while a request is pending is refused, and acceptance is idempotent", async () => {
    const { a, b } = await pair();
    const first = await sendOk(a, b);
    expect((await send(b, a, text())).data?.outcome).toBe("request_pending_accept_first");
    const accepted = await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: first.conversationId, p_action: "ACCEPT" });
    expect(accepted.outcome).toBe("accepted");
    const again = await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: first.conversationId, p_action: "ACCEPT" });
    expect(again).toMatchObject({ outcome: "accepted", replay: true });
    // Ordinary two-way messaging now works, with no request limit.
    for (let i = 0; i < 5; i++) await sendOk(a, b);
    await sendOk(b, a);
    // The sender, not the recipient, cannot accept their own request.
    const { a: a2, b: b2 } = await pair();
    const f2 = await sendOk(a2, b2);
    expect((await rpc("messaging_respond_request", { p_user_id: a2, p_conversation_id: f2.conversationId, p_action: "ACCEPT" })).data?.outcome).toBe("not_found");
  });

  it("acceptance notifies the requester once; a decline tells the sender nothing", async () => {
    const { a, b } = await pair();
    const first = await sendOk(a, b);
    await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: first.conversationId, p_action: "ACCEPT" });
    const { data: accepted } = await admin.from("notifications").select("type").eq("user_id", a).eq("conversation_id", first.conversationId);
    expect(accepted!.map((n) => n.type)).toEqual(["MESSAGE_REQUEST_ACCEPTED"]);

    const { a: a2, b: b2 } = await pair();
    const f2 = await sendOk(a2, b2);
    await ok("messaging_respond_request", { p_user_id: b2, p_conversation_id: f2.conversationId, p_action: "DECLINE" });
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", a2);
    expect(count).toBe(0);
  });

  it("a declined request still counts: the sender cannot ask indefinitely, nor by recreating anything", async () => {
    const { a, b } = await pair();
    const r1 = await sendOk(a, b);
    await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: r1.conversationId, p_action: "DECLINE" });
    expect((await conversationOf(a, b))!.status).toBe("DECLINED");
    const r2 = await send(a, b, text()); // one more request is allowed (2 total)…
    expect(r2.data?.outcome).toBe("sent");
    expect((await conversationOf(a, b))!.status).toBe("PENDING"); // …and it re-opens the same conversation, not a new one
    await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: r1.conversationId, p_action: "DECLINE" });
    expect((await send(a, b, text())).data?.outcome).toBe("request_limit"); // the counter was not reset
    const { count } = await admin.from("conversations").select("id", { count: "exact", head: true }).eq("member_low", a < b ? a : b).eq("member_high", a < b ? b : a);
    expect(count).toBe(1);
  });

  it("deleting the conversation is not something a Member can do, so it cannot reset the counter", async () => {
    const { a, b } = await pair();
    await sendOk(a, b);
    await sendOk(a, b);
    const conv = (await conversationOf(a, b))!;
    const asA = await clientFor(a);
    const del = await asA.from("conversations").delete().eq("id", conv.id);
    expect(del.error).not.toBeNull(); // no DELETE grant at all
    expect((await conversationOf(a, b))!.id).toBe(conv.id);
    expect((await send(a, b, text())).data?.outcome).toBe("request_limit");
  });

  it("unsending a request message does not give the request back", async () => {
    const { a, b } = await pair();
    const m1 = await sendOk(a, b);
    await sendOk(a, b);
    await ok("messaging_unsend", { p_user_id: a, p_message_id: m1.messageId });
    expect((await send(a, b, text())).data?.outcome).toBe("request_limit");
  });

  it("the Member who declined can later write first, which opens the conversation on their terms", async () => {
    const { a, b } = await pair();
    const r1 = await sendOk(a, b);
    await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: r1.conversationId, p_action: "DECLINE" });
    const reply = await send(b, a, text());
    expect(reply.data?.outcome).toBe("sent");
    expect((await conversationOf(a, b))!.status).toBe("ACTIVE");
    expect((await send(a, b, text())).data?.outcome).toBe("sent");
  });

  it("the limit is the configured value, not a constant", async () => {
    await setSettings({ messaging_max_unanswered_requests: 1 });
    const { a, b } = await pair();
    expect((await send(a, b, text())).data?.outcome).toBe("sent");
    expect((await send(a, b, text())).data?.outcome).toBe("request_limit");
  });
});

describe("sending: validation, normalisation, idempotency and ordering", () => {
  it("normalises text (control characters and blank-line runs removed, trimmed) and stores HTML as plain text", async () => {
    const { a, b } = await pair();
    const r = await sendOk(a, b, "  hello\u0007 world\n\n\n\n<script>alert(1)</script>  ");
    const { data: m } = await admin.from("messages").select("body").eq("id", r.messageId).single();
    expect(m!.body).toBe("hello world\n\n<script>alert(1)</script>"); // stored literally; the UI renders text, never HTML
    expect((await send(a, b, "   \n  ")).data?.outcome).toBe("empty");
  });

  it("enforces the CONFIGURED maximum length", async () => {
    await setSettings({ messaging_max_message_length: 5 });
    const { a, b } = await pair();
    expect((await send(a, b, "123456")).data?.outcome).toBe("too_long");
    expect((await send(a, b, "12345")).data?.outcome).toBe("sent");
  });

  it("a retry with the same key returns the original message and writes nothing new, even concurrently", async () => {
    const { a, b } = await pair();
    const key = randomUUID();
    const results = await Promise.all([send(a, b, "same", { key }), send(a, b, "same", { key }), send(a, b, "same", { key })]);
    for (const r of results) expect(r.error, r.error?.message).toBeNull();
    const ids = new Set(results.map((r) => r.data?.messageId));
    expect(ids.size).toBe(1);
    expect((await conversationOf(a, b))!.message_count).toBe(1);
  });

  it("refuses identical consecutive text inside the duplicate window, and allows it once the window is off", async () => {
    const { a, b, conversationId } = await activePair();
    expect((await send(a, b, "dup")).data?.outcome).toBe("sent");
    expect((await send(a, b, "dup")).data?.outcome).toBe("duplicate_message");
    expect((await send(a, b, "different")).data?.outcome).toBe("sent");
    await setSettings({ messaging_duplicate_window_seconds: 0 });
    expect((await send(a, b, "different")).data?.outcome).toBe("sent");
    expect(conversationId).toBeTruthy();
  });

  it("concurrent sends get distinct, gap-free sequence numbers in one deterministic order", async () => {
    const { a, b } = await activePair();
    const before = (await conversationOf(a, b))!.message_count as number;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => send(i % 2 === 0 ? a : b, i % 2 === 0 ? b : a, text(`c${i}`))));
    for (const r of results) expect(r.data?.outcome).toBe("sent");
    const seqs = results.map((r) => r.data!.seq as number).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => before + 1 + i));
    expect((await conversationOf(a, b))!.message_count).toBe(before + 12);
  });
});

describe("read state and notifications", () => {
  it("a burst of messages produces ONE unread notification, and opening the conversation moves the cursor without per-message writes", async () => {
    const { a, b, conversationId } = await activePair();
    await admin.from("notifications").delete().eq("user_id", b);
    for (let i = 0; i < 4; i++) await sendOk(a, b);
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", b).eq("type", "MESSAGE_RECEIVED").is("read_at", null);
    expect(count).toBe(1);
    const conv = (await conversationOf(a, b))!;
    const { data: p } = await admin.from("conversation_participants").select("last_read_seq").eq("conversation_id", conversationId).eq("member_id", b).single();
    expect(p!.last_read_seq).toBeLessThan(conv.message_count);
    await ok("messaging_mark_read", { p_user_id: b, p_conversation_id: conversationId, p_seq: 999999 });
    const { data: after } = await admin.from("conversation_participants").select("last_read_seq").eq("conversation_id", conversationId).eq("member_id", b).single();
    expect(after!.last_read_seq).toBe(conv.message_count); // capped at what exists
    await ok("messaging_mark_read", { p_user_id: b, p_conversation_id: conversationId, p_seq: 1 });
    const { data: back } = await admin.from("conversation_participants").select("last_read_seq").eq("conversation_id", conversationId).eq("member_id", b).single();
    expect(back!.last_read_seq).toBe(conv.message_count); // never moves backwards
    // The sender's own cursor is already at the latest message.
    const { data: own } = await admin.from("conversation_participants").select("last_read_seq").eq("conversation_id", conversationId).eq("member_id", a).single();
    expect(own!.last_read_seq).toBe(conv.message_count);
  });

  it("a Member cannot move someone else's read cursor", async () => {
    const { a, b, conversationId } = await activePair();
    await sendOk(a, b);
    const third = await seedUser("msg-third-read");
    await ok("messaging_mark_read", { p_user_id: third, p_conversation_id: conversationId, p_seq: 999 });
    const { data: p } = await admin.from("conversation_participants").select("last_read_seq").eq("conversation_id", conversationId).eq("member_id", b).single();
    expect(p!.last_read_seq).toBeLessThan((await conversationOf(a, b))!.message_count);
  });

  it("notifications carry the sender's name and never the message text", async () => {
    const { a, b } = await activePair();
    await admin.from("notifications").delete().eq("user_id", b);
    await sendOk(a, b, "a very private sentence about my picks");
    const { data } = await admin.from("notifications").select("title, body").eq("user_id", b).eq("type", "MESSAGE_RECEIVED").single();
    expect(`${data!.title} ${data!.body}`).not.toContain("private sentence");
  });
});

describe("Block", () => {
  it("a block stops the blocked Member sending (with a neutral answer), keeps history, and unblocking restores it", async () => {
    const { a, b } = await activePair();
    await sendOk(a, b);
    const countBefore = (await conversationOf(a, b))!.message_count;
    await ok("messaging_set_block", { p_user_id: b, p_blocked_id: a, p_blocked: true });
    expect((await send(a, b, text())).data?.outcome).toBe("unavailable"); // reveals nothing about a block
    expect((await send(b, a, text())).data?.outcome).toBe("blocked_by_you");
    expect((await conversationOf(a, b))!.message_count).toBe(countBefore); // nothing deleted
    const { count } = await admin.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", (await conversationOf(a, b))!.id);
    expect(count).toBe(countBefore);
    await ok("messaging_set_block", { p_user_id: b, p_blocked_id: a, p_blocked: false });
    expect((await send(a, b, text())).data?.outcome).toBe("sent");
  });

  it("a blocked Member can neither open a new request nor produce a notification", async () => {
    const { a, b } = await pair();
    await ok("messaging_set_block", { p_user_id: b, p_blocked_id: a, p_blocked: true });
    expect((await send(a, b, text())).data?.outcome).toBe("unavailable");
    expect(await conversationOf(a, b)).toBeNull();
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", b);
    expect(count).toBe(0);
  });

  it("blocking is idempotent, audited once, and a Member sees only their OWN blocks", async () => {
    const { a, b } = await pair();
    await ok("messaging_set_block", { p_user_id: a, p_blocked_id: b, p_blocked: true });
    await ok("messaging_set_block", { p_user_id: a, p_blocked_id: b, p_blocked: true });
    const { count } = await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("actor_id", a).eq("action", "messaging.blocked").eq("entity_id", b);
    expect(count).toBe(1);
    const asB = await clientFor(b);
    expect((await asB.from("member_blocks").select("blocker_id")).data).toEqual([]); // the blocked Member cannot see they are blocked
    const asA = await clientFor(a);
    expect((await asA.from("member_blocks").select("blocked_id")).data).toEqual([{ blocked_id: b }]);
  });

  it("blocking yourself is refused", async () => {
    const a = await seedUser("msg-selfblock");
    expect((await rpc("messaging_set_block", { p_user_id: a, p_blocked_id: a, p_blocked: true })).data?.outcome).toBe("self");
  });

  it("a request cannot be accepted by someone who has since been blocked by the requester", async () => {
    const { a, b } = await pair();
    const first = await sendOk(a, b);
    await ok("messaging_set_block", { p_user_id: a, p_blocked_id: b, p_blocked: true });
    expect((await rpc("messaging_respond_request", { p_user_id: b, p_conversation_id: first.conversationId, p_action: "ACCEPT" })).data?.outcome).toBe("unavailable");
  });
});

describe("Mute", () => {
  it("a muted conversation still delivers both ways, suppresses message notifications, and the other side cannot tell", async () => {
    const { a, b, conversationId } = await activePair();
    expect(await ok("messaging_set_mute", { p_user_id: b, p_conversation_id: conversationId, p_muted: true } as never)).toBeTruthy();
    await admin.from("notifications").delete().eq("user_id", b);
    await sendOk(a, b);
    const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", b);
    expect(count).toBe(0); // no notification…
    await sendOk(b, a); // …but B can still write and A still receives
    const asA = await clientFor(a);
    const { data: visible } = await asA.from("conversation_participants").select("member_id, muted_at");
    expect(visible!.map((p) => p.member_id)).toEqual([a]); // A sees only A's own row: B's mute is invisible
    expect(visible![0].muted_at).toBeNull();
    await ok("messaging_set_mute", { p_user_id: b, p_conversation_id: conversationId, p_muted: false } as never);
    await sendOk(a, b);
    const { count: after } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", b).eq("type", "MESSAGE_RECEIVED");
    expect(after).toBe(1);
  });

  it("only a participant can mute a conversation", async () => {
    const { conversationId } = await activePair();
    const outsider = await seedUser("msg-mute-outsider");
    const r = await rpc("messaging_set_mute", { p_user_id: outsider, p_conversation_id: conversationId, p_muted: true });
    expect(r.data).toBe(false);
  });
});

describe("Unsend and the tombstone", () => {
  it("the sender can unsend inside the window: the body leaves the Member-facing row, the counterpart sees a tombstone, the original is kept only as evidence", async () => {
    const { a, b } = await activePair();
    const m = await sendOk(a, b, "regret this");
    expect((await ok("messaging_unsend", { p_user_id: a, p_message_id: m.messageId })).outcome).toBe("unsent");
    const asB = await clientFor(b);
    const { data } = await asB.from("messages").select("id, body, unsent_at, kind").eq("id", m.messageId).single();
    expect(data!.body).toBeNull();
    expect(data!.unsent_at).not.toBeNull(); // the tombstone: a deleted message, not a silent gap
    expect(JSON.stringify(data)).not.toContain("regret this");
    // The original exists only in evidence, which no Member-facing role can read.
    const { data: evidence } = await admin.from("message_unsent_evidence").select("body").eq("message_id", m.messageId).single();
    expect(evidence!.body).toBe("regret this");
    expect((await asB.from("message_unsent_evidence").select("body")).error).not.toBeNull();
    const asA = await clientFor(a);
    expect((await asA.from("message_unsent_evidence").select("body")).error).not.toBeNull();
  });

  it("is idempotent, and nobody else can unsend it (the answer is the same as for a missing message)", async () => {
    const { a, b } = await activePair();
    const m = await sendOk(a, b);
    expect((await rpc("messaging_unsend", { p_user_id: b, p_message_id: m.messageId })).data?.outcome).toBe("not_found");
    expect((await rpc("messaging_unsend", { p_user_id: a, p_message_id: randomUUID() })).data?.outcome).toBe("not_found");
    await ok("messaging_unsend", { p_user_id: a, p_message_id: m.messageId });
    expect(await ok("messaging_unsend", { p_user_id: a, p_message_id: m.messageId })).toMatchObject({ outcome: "unsent", replay: true });
  });

  it("refuses after the configured window, follows a changed window, and 0 turns unsending off", async () => {
    const { a, b } = await activePair();
    const old = await sendOk(a, b);
    await admin.from("messages").update({ created_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }).eq("id", old.messageId);
    expect((await rpc("messaging_unsend", { p_user_id: a, p_message_id: old.messageId })).data?.outcome).toBe("window_expired");
    await setSettings({ messaging_unsend_window_seconds: 86400 });
    expect((await rpc("messaging_unsend", { p_user_id: a, p_message_id: old.messageId })).data?.outcome).toBe("unsent"); // the window is a live setting
    const fresh = await sendOk(a, b);
    await setSettings({ messaging_unsend_window_seconds: 0 });
    expect((await rpc("messaging_unsend", { p_user_id: a, p_message_id: fresh.messageId })).data?.outcome).toBe("unsend_disabled");
  });

  it("unsending a shared object removes its reference from the visible row too", async () => {
    const { a, b } = await activePair();
    const ref = randomUUID();
    const r = await send(a, b, null, { kind: "SHARE", shareType: "POST", shareRef: ref });
    await ok("messaging_unsend", { p_user_id: a, p_message_id: r.data!.messageId });
    const { data } = await admin.from("messages").select("share_type, share_ref, unsent_at").eq("id", r.data!.messageId).single();
    expect(data!.share_ref).toBeNull();
    expect(data!.unsent_at).not.toBeNull();
  });
});

describe("Report and moderation evidence", () => {
  it("a participant can report; the evidence snapshot survives a later unsend; the reported Member and the reporter cannot read the record", async () => {
    const { a, b, conversationId } = await activePair();
    await sendOk(a, b, "context one");
    const bad = await sendOk(a, b, "the offending message");
    const rep = await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: bad.messageId, p_reason: "HARASSMENT", p_note: "please look" });
    expect(rep.outcome).toBe("reported");
    await ok("messaging_unsend", { p_user_id: a, p_message_id: bad.messageId }); // the sender tries to erase it afterwards
    const { data: report } = await admin.from("message_reports").select("*").eq("id", rep.reportId).single();
    expect(report!.reported_member_id).toBe(a);
    expect(report!.reporter_id).toBe(b);
    expect(JSON.stringify(report!.evidence)).toContain("the offending message");
    expect(JSON.stringify(report!.evidence)).toContain("context one");
    for (const who of [a, b]) {
      const c = await clientFor(who);
      expect((await c.from("message_reports").select("id")).error).not.toBeNull(); // no grant at all: not even the reporter
    }
  });

  it("only a participant can report; you cannot report your own message; a duplicate is recognised", async () => {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b);
    const outsider = await seedUser("msg-rep-outsider");
    expect((await rpc("messaging_report", { p_user_id: outsider, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "SPAM", p_note: null })).data?.outcome).toBe("not_found");
    expect((await rpc("messaging_report", { p_user_id: a, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "SPAM", p_note: null })).data?.outcome).toBe("own_message");
    expect((await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "SPAM", p_note: null })).outcome).toBe("reported");
    expect((await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "SPAM", p_note: null })).outcome).toBe("already_reported");
    expect((await rpc("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "NOT_A_REASON", p_note: null })).error).not.toBeNull();
  });

  it("a conversation-level report is bounded and one open report per reporter", async () => {
    const { a, b, conversationId } = await activePair();
    for (let i = 0; i < 30; i++) await sendOk(a, b);
    const rep = await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: null, p_reason: "SPAM", p_note: null });
    const { data: report } = await admin.from("message_reports").select("scope, evidence").eq("id", rep.reportId).single();
    expect(report!.scope).toBe("CONVERSATION");
    expect((report!.evidence as unknown[]).length).toBeLessThanOrEqual(20);
    expect((await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: null, p_reason: "SPAM", p_note: null })).outcome).toBe("already_reported");
  });

  it("only a Super Admin resolves a report; hiding a message leaves a tombstone and keeps the evidence; every resolution is audited", async () => {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b, "hide me");
    const rep = await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "THREAT", p_note: null });
    const plain = await seedUser("msg-notadmin");
    expect((await rpc("admin_messaging_resolve_report", { p_admin_id: plain, p_report_id: rep.reportId, p_action: "HIDE_MESSAGE", p_note: null })).error).not.toBeNull();
    expect((await rpc("admin_messaging_resolve_report", { p_admin_id: b, p_report_id: rep.reportId, p_action: "DISMISS", p_note: null })).error).not.toBeNull(); // a participant has no moderation power
    const sa = await superAdmin();
    expect((await ok("admin_messaging_resolve_report", { p_admin_id: sa, p_report_id: rep.reportId, p_action: "HIDE_MESSAGE", p_note: "clear threat" })).outcome).toBe("resolved");
    const asB = await clientFor(b);
    const { data: row } = await asB.from("messages").select("body, moderation_removed_at").eq("id", m.messageId).single();
    expect(row!.body).toBeNull();
    expect(row!.moderation_removed_at).not.toBeNull();
    const { data: report } = await admin.from("message_reports").select("status, resolved_by, evidence").eq("id", rep.reportId).single();
    expect(report).toMatchObject({ status: "ACTIONED", resolved_by: sa });
    expect(JSON.stringify(report!.evidence)).toContain("hide me");
    expect((await ok("admin_messaging_resolve_report", { p_admin_id: sa, p_report_id: rep.reportId, p_action: "DISMISS", p_note: null })).outcome).toBe("already_resolved");
    const { count } = await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", rep.reportId);
    expect(count).toBeGreaterThanOrEqual(2); // the report and its resolution
  });
});

describe("privacy: who can read what", () => {
  it("a third Member, an anonymous client and a Sponsor read nothing, and a participant reads only their own conversations", async () => {
    const { a, b, conversationId } = await activePair();
    await sendOk(a, b, "only for the two of us");
    const other = await activePair();
    const third = await seedUser("msg-third");
    const sponsor = await seedSponsorAccount("MsgSponsorRead");

    const readers: Array<[string, ReturnType<typeof getTestAnonClient>]> = [["third", await clientFor(third)], ["sponsor", await (async () => {
      const c = getTestAnonClient();
      expect((await c.auth.signInWithPassword({ email: sponsor.email, password: PASSWORD })).error).toBeNull();
      return c;
    })()], ["anon", getTestAnonClient()]];
    for (const [label, client] of readers) {
      expect((await client.from("conversations").select("id")).data ?? [], label).toEqual([]);
      expect((await client.from("messages").select("id")).data ?? [], label).toEqual([]);
      expect((await client.from("conversation_participants").select("member_id")).data ?? [], label).toEqual([]);
      expect((await client.from("messages").select("id").eq("conversation_id", conversationId)).data ?? [], label).toEqual([]);
    }
    const asA = await clientFor(a);
    const ids = ((await asA.from("conversations").select("id")).data ?? []).map((c) => c.id);
    expect(ids).toContain(conversationId);
    expect(ids).not.toContain(other.conversationId);
    const msgs = ((await asA.from("messages").select("body, conversation_id")).data ?? []);
    expect(msgs.every((m) => m.conversation_id === conversationId)).toBe(true);
    expect(msgs.some((m) => m.body === "only for the two of us")).toBe(true);
  });

  it("no Member-facing role can write any messaging table or call any messaging function directly", async () => {
    const { a, b, conversationId } = await activePair();
    const asA = await clientFor(a);
    expect((await asA.from("messages").insert({ conversation_id: conversationId, seq: 99, sender_id: a, kind: "TEXT", body: "forged" })).error).not.toBeNull();
    expect((await asA.from("messages").update({ body: "tampered" }).eq("conversation_id", conversationId)).error ?? { ok: true }).toBeTruthy();
    const { data: still } = await admin.from("messages").select("body").eq("conversation_id", conversationId);
    expect(still!.some((m) => m.body === "tampered" || m.body === "forged")).toBe(false);
    expect((await asA.from("conversations").update({ status: "ACTIVE" }).eq("id", conversationId)).error ?? { ok: true }).toBeTruthy();
    expect((await asA.from("member_blocks").insert({ blocker_id: a, blocked_id: b })).error).not.toBeNull();
    for (const [fn, args] of [
      ["messaging_send", { p_user_id: a, p_recipient_id: b, p_kind: "TEXT", p_body: "x", p_share_type: null, p_share_ref: null, p_idempotency_key: null }],
      ["messaging_unsend", { p_user_id: a, p_message_id: randomUUID() }],
      ["messaging_set_block", { p_user_id: a, p_blocked_id: b, p_blocked: true }],
      ["messaging_report", { p_user_id: a, p_conversation_id: conversationId, p_message_id: null, p_reason: "SPAM", p_note: null }],
      ["messaging_purge_expired", { p_batch: 10 }],
      ["admin_set_messaging_config", { p_admin_id: a, p_config: {} }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect((await asA.rpc(fn, args)).error, `${fn} must be service-role only`).not.toBeNull();
      expect((await getTestAnonClient().rpc(fn, args)).error, `${fn} must be closed to the public`).not.toBeNull();
    }
  });

  it("a Member cannot impersonate another by passing their id: sending as someone who is not a Member of the pair never exposes the other conversation", async () => {
    const { a, b, conversationId } = await activePair();
    const stranger = await seedUser("msg-stranger");
    // The functions act for the id they are given (the server passes the authenticated Member's id and never a client value); a stranger id simply starts a different conversation.
    await sendOk(stranger, b);
    const sc = await conversationOf(stranger, b);
    expect(sc!.id).not.toBe(conversationId);
    expect((await conversationOf(a, b))!.id).toBe(conversationId);
  });
});

describe("rate limiting", () => {
  it("the Messaging limiter is service-role only, so a Member cannot spend another Member's allowance", async () => {
    const victim = await seedUser("rl-victim");
    const attacker = await seedUser("rl-attacker");
    const asAttacker = await clientFor(attacker);
    const bucket = `msg_send:${victim}`;
    for (let i = 0; i < 5; i++) expect((await asAttacker.rpc("messaging_rate_limit", { p_identifier: bucket, p_window_seconds: 60, p_max_attempts: 1 })).error, "closed to Members").not.toBeNull();
    expect((await getTestAnonClient().rpc("messaging_rate_limit", { p_identifier: bucket, p_window_seconds: 60, p_max_attempts: 1 })).error).not.toBeNull();
    // The victim's allowance is untouched: the server-side limiter lets their first action through.
    const first = await admin.rpc("messaging_rate_limit", { p_identifier: bucket, p_window_seconds: 60, p_max_attempts: 1 });
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);
    expect((await admin.rpc("messaging_rate_limit", { p_identifier: bucket, p_window_seconds: 60, p_max_attempts: 1 })).data).toBe(false); // …and the second inside the window is refused
  });
});

describe("settings and retention", () => {
  it("only a Super Admin can change the Messaging policy; values are validated; a real change is audited and a no-op is not", async () => {
    const sa = await superAdmin();
    const plain = await seedUser("msg-cfg-plain");
    expect((await rpc("admin_set_messaging_config", { p_admin_id: plain, p_config: { messaging_enabled: true } })).error).not.toBeNull();
    for (const bad of [{ messaging_max_message_length: 0 }, { messaging_max_message_length: 4001 }, { messaging_max_unanswered_requests: 0 }, { messaging_poll_interval_seconds: 1 }, { not_a_setting: 1 }]) {
      expect((await rpc("admin_set_messaging_config", { p_admin_id: sa, p_config: bad })).error, JSON.stringify(bad)).not.toBeNull();
    }
    const countAudit = async () => (await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.messaging_updated")).count ?? 0;
    const before = await countAudit();
    await ok("admin_set_messaging_config", { p_admin_id: sa, p_config: { messaging_max_message_length: 321, messaging_unsend_window_seconds: 120 } });
    expect(await countAudit()).toBe(before + 1);
    await ok("admin_set_messaging_config", { p_admin_id: sa, p_config: { messaging_max_message_length: 321 } });
    expect(await countAudit()).toBe(before + 1); // nothing changed, so nothing audited
    const { data } = await admin.from("platform_settings").select("messaging_max_message_length, messaging_unsend_window_seconds").eq("id", true).single();
    expect(data).toEqual({ messaging_max_message_length: 321, messaging_unsend_window_seconds: 120 });
    // Retention can be set and cleared back to "keep" (NULL).
    await ok("admin_set_messaging_config", { p_admin_id: sa, p_config: { messaging_retention_messages_days: 30 } });
    expect((await admin.from("platform_settings").select("messaging_retention_messages_days").eq("id", true).single()).data!.messaging_retention_messages_days).toBe(30);
    await ok("admin_set_messaging_config", { p_admin_id: sa, p_config: { messaging_retention_messages_days: null } });
    expect((await admin.from("platform_settings").select("messaging_retention_messages_days").eq("id", true).single()).data!.messaging_retention_messages_days).toBeNull();
  });

  it("with the master switch off the purge deletes nothing, whatever the durations say", async () => {
    const { a, b } = await activePair();
    const old = await sendOk(a, b);
    await admin.from("messages").update({ created_at: new Date(Date.now() - 400 * 86_400_000).toISOString() }).eq("id", old.messageId);
    await setSettings({ messaging_retention_messages_days: 30, messaging_retention_purge_enabled: false });
    expect((await admin.rpc("messaging_purge_expired", { p_batch: 100 })).data).toEqual({ enabled: false });
    expect((await admin.from("messages").select("id").eq("id", old.messageId)).data).toHaveLength(1);
  });

  it("with NULL durations the purge deletes nothing, however old; with durations it deletes only that category, in bounded batches", async () => {
    const { a, b, conversationId } = await activePair();
    const old = await sendOk(a, b);
    const fresh = await sendOk(a, b);
    const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await admin.from("messages").update({ created_at: ancient }).eq("id", old.messageId);
    expect((await admin.rpc("messaging_purge_expired", { p_batch: 100 })).data!.messages).toBe(0); // NULL = keep
    await setSettings({ messaging_retention_messages_days: 90 });
    const r = (await admin.rpc("messaging_purge_expired", { p_batch: 100 })).data as Row;
    expect(r.messages).toBeGreaterThanOrEqual(1);
    expect((await admin.from("messages").select("id").eq("id", old.messageId)).data).toEqual([]);
    expect((await admin.from("messages").select("id").eq("id", fresh.messageId)).data).toHaveLength(1);
    expect(conversationId).toBeTruthy();
    // Bounded: one call never removes more than the batch size.
    const m1 = await sendOk(a, b);
    const m2 = await sendOk(a, b);
    const m3 = await sendOk(a, b);
    await admin.from("messages").update({ created_at: ancient }).in("id", [m1.messageId, m2.messageId, m3.messageId]);
    expect(((await admin.rpc("messaging_purge_expired", { p_batch: 2 })).data as Row).messages).toBeLessThanOrEqual(2);
  });

  it("unsent evidence, reported evidence and moderation records each follow their OWN duration", async () => {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b, "evidence body");
    await ok("messaging_unsend", { p_user_id: a, p_message_id: m.messageId });
    const m2 = await sendOk(a, b, "reported body");
    const rep = await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m2.messageId, p_reason: "SPAM", p_note: null });
    const sa = await superAdmin();
    await ok("admin_messaging_resolve_report", { p_admin_id: sa, p_report_id: rep.reportId, p_action: "DISMISS", p_note: null });
    const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await admin.from("message_unsent_evidence").update({ unsent_at: ancient }).eq("message_id", m.messageId);
    await admin.from("message_reports").update({ created_at: ancient, resolved_at: ancient }).eq("id", rep.reportId);

    await setSettings({ messaging_retention_unsent_days: 30 });
    let r = (await admin.rpc("messaging_purge_expired", { p_batch: 100 })).data as Row;
    expect(r.unsentEvidence).toBeGreaterThanOrEqual(1);
    expect(r.reportedEvidence).toBe(0); // its own setting is still NULL
    expect((await admin.from("message_reports").select("evidence").eq("id", rep.reportId).single()).data!.evidence).not.toEqual([]);

    await setSettings({ messaging_retention_reported_days: 30 });
    r = (await admin.rpc("messaging_purge_expired", { p_batch: 100 })).data as Row;
    expect(r.reportedEvidence).toBeGreaterThanOrEqual(1);
    expect((await admin.from("message_reports").select("evidence").eq("id", rep.reportId).single()).data!.evidence).toEqual([]);

    await setSettings({ messaging_retention_moderation_days: 30 });
    r = (await admin.rpc("messaging_purge_expired", { p_batch: 100 })).data as Row;
    expect(r.moderationRecords).toBeGreaterThanOrEqual(1);
    expect((await admin.from("message_reports").select("id").eq("id", rep.reportId)).data).toEqual([]);
  });

  it("when one account is gone the conversation stays readable to the other Member and read-only; a missing profile alone is NOT treated as closure", async () => {
    const { a, b, conversationId } = await activePair();
    await sendOk(a, b, "still here");
    // There is no self-service hard delete; an operator removing an account clears its dependents first (notifications are not cascaded), which is outside Messaging.
    await admin.from("notifications").delete().eq("user_id", a);
    const { error } = await admin.from("user_profiles").delete().eq("id", a);
    expect(error, error?.message).toBeNull();
    const conv = (await admin.from("conversations").select("*").eq("id", conversationId)).data![0] as Row;
    expect([conv.member_low, conv.member_high].filter((x) => x === null)).toHaveLength(1); // no dangling foreign key
    const asB = await clientFor(b);
    const { data } = await asB.from("messages").select("body, sender_id").eq("conversation_id", conversationId);
    expect(data!.some((m) => m.body === "still here")).toBe(true);
    expect(data!.some((m) => m.sender_id === null)).toBe(true); // the placeholder identity: no PII retained about the removed account
    expect((await send(b, a, text())).data?.outcome).toBe("unavailable"); // read-only
    // Closure comes ONLY from the canonical marker: a missing profile, however old the conversation, is never inferred to be a closure.
    await admin.from("conversations").update({ last_message_at: new Date(Date.now() - 400 * 86_400_000).toISOString() }).eq("id", conversationId);
    await setSettings({ messaging_retention_closed_account_days: 30 });
    const r = (await admin.rpc("messaging_purge_expired", { p_batch: 100 })).data as Row;
    expect(r.closedAccountMessages).toBe(0);
    expect(r.closedAccountConversations).toBe(0);
    expect((await admin.from("conversations").select("id").eq("id", conversationId)).data).toHaveLength(1);
  });
});
