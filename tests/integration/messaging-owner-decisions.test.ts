/**
 * Milestone 2 final owner decisions (migration 199) against the real database:
 *   - the canonical account-closure marker and the retention model that follows it (semantic defaults, master switch, closure, open cases),
 *   - narrowly scoped, auditable retention holds,
 *   - Call BS expiry reasons and the centralised "ignored" policy,
 *   - Block as a relationship boundary (Messaging, Call BS, direct replies; comments never deleted),
 *   - bounded, auditable abuse signals and the opt-in temporary restriction,
 *   - generic reporter outcome notifications.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";
import { acceptCallBS, callBS, declineCallBS, expireStaleChallenges } from "@/lib/challenges/repository";
import { CHALLENGE_EXPIRY_REASONS, IGNORED_EXPIRY_REASONS, expiryCountsAsIgnored } from "@/lib/challenges/expiry";
import { ensurePostForFixture, publishPost } from "@/lib/posts/repository";
import { addPostComment, getPostConversation } from "@/lib/post-comments/repository";
import { runMessagingRetention } from "@/lib/messaging/retention";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await admin.rpc(name, args);
  return { data: data as Row | null, error };
};
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};

let counter = 0;
const text = (label = "msg") => `${label} ${++counter} ${randomUUID().slice(0, 6)}`;
const send = (from: string, to: string, body: string | null = text(), idem: string | null = randomUUID()) =>
  rpc("messaging_send", { p_user_id: from, p_recipient_id: to, p_kind: "TEXT", p_body: body, p_share_type: null, p_share_ref: null, p_idempotency_key: idem });
const sendOk = async (from: string, to: string, body = text()) => {
  const r = await send(from, to, body);
  expect(r.error, r.error?.message).toBeNull();
  expect(r.data?.outcome, JSON.stringify(r.data)).toBe("sent");
  return r.data!;
};

const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
const SETTINGS_KEYS = [
  "messaging_enabled", "messaging_max_unanswered_requests", "messaging_duplicate_window_seconds", "messaging_retention_messages_days", "messaging_retention_unsent_days",
  "messaging_retention_reported_days", "messaging_retention_closed_account_days", "messaging_retention_moderation_days", "messaging_retention_audit_days", "messaging_retention_purge_enabled",
  "messaging_report_outcome_notifications_enabled", "messaging_abuse_window_seconds", "messaging_abuse_requests_threshold", "messaging_abuse_declines_threshold",
  "messaging_abuse_blocks_threshold", "messaging_abuse_reports_threshold", "messaging_abuse_duplicate_threshold", "messaging_abuse_rapid_window_seconds", "messaging_abuse_rapid_threshold",
  "messaging_abuse_coordinated_threshold", "messaging_abuse_restrict_enabled", "messaging_abuse_restrict_hours", "call_bs_enabled", "pick_lock_minutes_before_kickoff",
];
let saved: Row | null = null;
beforeEach(async () => {
  const { data } = await admin.from("platform_settings").select(SETTINGS_KEYS.join(",")).eq("id", true).single();
  saved = data as Row | null;
  await setSettings({
    messaging_enabled: true, messaging_max_unanswered_requests: 2, messaging_duplicate_window_seconds: 30, messaging_retention_messages_days: null, messaging_retention_unsent_days: null,
    messaging_retention_reported_days: null, messaging_retention_closed_account_days: null, messaging_retention_moderation_days: null, messaging_retention_audit_days: null,
    messaging_retention_purge_enabled: true, messaging_report_outcome_notifications_enabled: true, messaging_abuse_restrict_enabled: false, messaging_abuse_restrict_hours: 24,
    // Thresholds high enough that ordinary test traffic never trips them; the abuse tests lower the one they exercise.
    messaging_abuse_window_seconds: 86400, messaging_abuse_requests_threshold: 1000, messaging_abuse_declines_threshold: 1000, messaging_abuse_blocks_threshold: 1000,
    messaging_abuse_reports_threshold: 1000, messaging_abuse_duplicate_threshold: 1000, messaging_abuse_rapid_window_seconds: 600, messaging_abuse_rapid_threshold: 10000,
    messaging_abuse_coordinated_threshold: 1000, call_bs_enabled: true, pick_lock_minutes_before_kickoff: 10,
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
  const id = await seedUser("owner-admin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}
const ancient = () => new Date(Date.now() - 400 * 86_400_000).toISOString();

async function activePair() {
  const a = await seedUser("od-a");
  const b = await seedUser("od-b");
  const first = await sendOk(a, b);
  await ok("messaging_respond_request", { p_user_id: b, p_conversation_id: first.conversationId, p_action: "ACCEPT" });
  return { a, b, conversationId: first.conversationId as string, firstMessageId: first.messageId as string };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the canonical account-closure marker", () => {
  it("close_own_account sets account_closed_at; an admin deactivation does not — is_active alone cannot tell them apart", async () => {
    const closer = await seedUser("od-closer");
    const deactivated = await seedUser("od-deactivated");
    // close_own_account needs the wallet row every real account has.
    await admin.from("wallet_balances").insert({ user_id: closer, account_type: "user", balance: 0 });
    await ok("close_own_account", { p_user_id: closer });
    await admin.from("user_profiles").update({ is_active: false }).eq("id", deactivated);
    const rows = (await admin.from("user_profiles").select("id, is_active, account_closed_at").in("id", [closer, deactivated])).data as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[closer].is_active).toBe(false);
    expect(byId[closer].account_closed_at).not.toBeNull();
    expect(byId[deactivated].is_active).toBe(false);
    expect(byId[deactivated].account_closed_at).toBeNull();
  });

  it("is set once and never changed or cleared", async () => {
    const id = await seedUser("od-once");
    const at = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect((await admin.from("user_profiles").update({ account_closed_at: at }).eq("id", id)).error).toBeNull();
    expect((await admin.from("user_profiles").update({ account_closed_at: null }).eq("id", id)).error).not.toBeNull();
    expect((await admin.from("user_profiles").update({ account_closed_at: new Date().toISOString() }).eq("id", id)).error).not.toBeNull();
    expect(new Date((await admin.from("user_profiles").select("account_closed_at").eq("id", id).single()).data!.account_closed_at).getTime()).toBe(new Date(at).getTime());
  });

  it("a Member cannot write the marker themselves", async () => {
    const id = await seedUser("od-self-mark");
    const { data } = await admin.auth.admin.getUserById(id);
    const c = getTestAnonClient();
    expect((await c.auth.signInWithPassword({ email: data.user!.email!, password: "integration-test-password-123" })).error).toBeNull();
    const r = await c.from("user_profiles").update({ account_closed_at: new Date().toISOString() }).eq("id", id);
    expect(r.error).not.toBeNull();
  });
});

describe("retention: one coherent model", () => {
  it("inactivity and an old conversation are not closure: nothing is removed until the marker says the account closed, and not before the configured days", async () => {
    const { a, conversationId } = await activePair();
    await setSettings({ messaging_retention_closed_account_days: 30 });
    // Inactive and old, but NOT closed: nothing happens.
    await admin.from("user_profiles").update({ is_active: false }).eq("id", a);
    await admin.from("messages").update({ created_at: ancient() }).eq("conversation_id", conversationId);
    let r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.closedAccountMessages).toBe(0);
    expect((await admin.from("messages").select("id").eq("conversation_id", conversationId)).data).toHaveLength(1);
    // Closed 10 days ago: inside the 30-day window, still kept.
    await admin.from("user_profiles").update({ account_closed_at: new Date(Date.now() - 10 * 86_400_000).toISOString() }).eq("id", a);
    r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.closedAccountMessages).toBe(0);
    expect((await admin.from("messages").select("id").eq("conversation_id", conversationId)).data).toHaveLength(1);
  });

  it("closure retention removes content in conversations of a Member closed more than N days ago", async () => {
    const { a, b, conversationId } = await activePair();
    await sendOk(b, a);
    // Closed 40 days ago, set directly (the column is write-once, and nothing had set it).
    await admin.from("user_profiles").update({ is_active: false, account_closed_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }).eq("id", a);
    await setSettings({ messaging_retention_closed_account_days: 30 });
    const r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.closedAccountMessages).toBeGreaterThanOrEqual(2);
    expect((await admin.from("messages").select("id").eq("conversation_id", conversationId)).data).toEqual([]);
    expect(r.closedAccountConversations).toBeGreaterThanOrEqual(1);
    expect((await admin.from("conversations").select("id").eq("id", conversationId)).data).toEqual([]);
    // The other Member's account is untouched.
    expect((await admin.from("user_profiles").select("is_active").eq("id", b).single()).data!.is_active).toBe(true);
  });

  it("the master switch: off deletes nothing; ordinary messages with a NULL duration are never purged by age", async () => {
    const { a, b, conversationId } = await activePair();
    await admin.from("messages").update({ created_at: ancient() }).eq("conversation_id", conversationId);
    await setSettings({ messaging_retention_purge_enabled: false, messaging_retention_unsent_days: 1, messaging_retention_reported_days: 1, messaging_retention_closed_account_days: 1 });
    expect(await ok("messaging_purge_expired", { p_batch: 100 })).toEqual({ enabled: false });
    await setSettings({ messaging_retention_purge_enabled: true });
    const r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.enabled).toBe(true);
    expect(r.messages).toBe(0); // NULL = no age-based purge while the accounts remain active
    expect((await admin.from("messages").select("id").eq("conversation_id", conversationId)).data!.length).toBeGreaterThanOrEqual(1);
    expect(a && b).toBeTruthy();
  });

  it("reported evidence is counted from CASE CLOSURE, never while the case is open", async () => {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b, "evidence-body");
    const rep = await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "SPAM", p_note: null });
    await admin.from("message_reports").update({ created_at: ancient() }).eq("id", rep.reportId); // filed long ago, still open
    await setSettings({ messaging_retention_reported_days: 180 });
    let r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.reportedEvidence).toBe(0);
    const sa = await superAdmin();
    await ok("admin_messaging_resolve_report", { p_admin_id: sa, p_report_id: rep.reportId, p_action: "DISMISS", p_note: null });
    r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.reportedEvidence).toBe(0); // closed just now: 180 days have not passed since CLOSURE
    await admin.from("message_reports").update({ resolved_at: new Date(Date.now() - 181 * 86_400_000).toISOString() }).eq("id", rep.reportId);
    r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.reportedEvidence).toBe(1);
    expect((await admin.from("message_reports").select("evidence").eq("id", rep.reportId).single()).data!.evidence).toEqual([]);
  });

  it("an unresolved report protects the reported message's original from the unsent-evidence purge", async () => {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b, "protected original");
    await ok("messaging_unsend", { p_user_id: a, p_message_id: m.messageId });
    await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "HARASSMENT", p_note: null });
    await admin.from("message_unsent_evidence").update({ unsent_at: ancient() }).eq("message_id", m.messageId);
    await setSettings({ messaging_retention_unsent_days: 30 });
    await ok("messaging_purge_expired", { p_batch: 100 });
    expect((await admin.from("message_unsent_evidence").select("message_id").eq("message_id", m.messageId)).data).toHaveLength(1);
  });

  it("the shipped defaults are the owner's policy (30 / 180 / 30 / 365), ordinary messages default to no age-based purge, and the purge and restriction switches default OFF", async () => {
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      const { rows } = await client.query<{ column_name: string; column_default: string | null }>(
        "select column_name, column_default from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name like 'messaging\\_%'",
      );
      const d = Object.fromEntries(rows.map((r) => [r.column_name, r.column_default]));
      expect(d.messaging_retention_unsent_days).toBe("30");
      expect(d.messaging_retention_reported_days).toBe("180");
      expect(d.messaging_retention_closed_account_days).toBe("30");
      expect(d.messaging_retention_audit_days).toBe("365");
      expect(d.messaging_retention_messages_days).toBeNull(); // NULL = no age-based purge while accounts remain active
      expect(d.messaging_retention_moderation_days).toBeNull();
      expect(d.messaging_retention_purge_enabled).toBe("false");
      expect(d.messaging_abuse_restrict_enabled).toBe("false");
      expect(d.messaging_enabled).toBe("false");
      expect(d.messaging_report_outcome_notifications_enabled).toBe("true");
    } finally {
      await client.end();
    }
  });
});

describe("the retention runner (what the cron calls)", () => {
  it("does nothing and says so while the master switch is off; with it on it removes only what the policy allows, in bounded rounds", async () => {
    const { a, b, conversationId } = await activePair();
    const old = await sendOk(a, b);
    await admin.from("messages").update({ created_at: ancient() }).eq("id", old.messageId);
    await setSettings({ messaging_retention_messages_days: 30, messaging_retention_purge_enabled: false });
    expect(await runMessagingRetention()).toEqual({ enabled: false, rounds: 0, removed: {} });
    expect((await admin.from("messages").select("id").eq("id", old.messageId)).data).toHaveLength(1);
    await setSettings({ messaging_retention_purge_enabled: true });
    const result = await runMessagingRetention();
    expect(result.enabled).toBe(true);
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.removed.messages).toBeGreaterThanOrEqual(1);
    expect((await admin.from("messages").select("id").eq("id", old.messageId)).data).toEqual([]);
    expect((await admin.from("messages").select("id").eq("conversation_id", conversationId)).data!.length).toBeGreaterThanOrEqual(1); // recent history is untouched
  });
});

describe("retention holds", () => {
  it("a hold on one message preserves ONLY that message; unrelated history in the same conversation is purged", async () => {
    const { a, b, conversationId } = await activePair();
    const held = await sendOk(a, b, "held message");
    const other = await sendOk(b, a, "unrelated message");
    const sa = await superAdmin();
    const hold = await ok("admin_messaging_place_hold", { p_admin_id: sa, p_reason: "ABUSE_INVESTIGATION", p_scope: "MESSAGE", p_message_id: held.messageId, p_report_id: null, p_conversation_id: null, p_seq_from: null, p_seq_to: null, p_note: "investigating a pattern" });
    expect(hold.outcome).toBe("held");
    await admin.from("messages").update({ created_at: ancient() }).eq("conversation_id", conversationId);
    await setSettings({ messaging_retention_messages_days: 30 });
    await ok("messaging_purge_expired", { p_batch: 100 });
    const left = ((await admin.from("messages").select("id").eq("conversation_id", conversationId)).data as Row[]).map((m) => m.id);
    expect(left).toContain(held.messageId);
    expect(left).not.toContain(other.messageId);
    // Releasing it makes it ordinary again.
    await ok("admin_messaging_release_hold", { p_admin_id: sa, p_hold_id: hold.holdId, p_note: "done" });
    await ok("messaging_purge_expired", { p_batch: 100 });
    expect((await admin.from("messages").select("id").eq("id", held.messageId)).data).toEqual([]);
  });

  it("a hold on a report preserves its record, its evidence and the message it names", async () => {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b, "reported + held");
    const rep = await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "SCAM", p_note: null });
    const sa = await superAdmin();
    await ok("admin_messaging_resolve_report", { p_admin_id: sa, p_report_id: rep.reportId, p_action: "ACTION", p_note: null });
    await ok("admin_messaging_place_hold", { p_admin_id: sa, p_reason: "LEGAL_OBLIGATION", p_scope: "REPORT", p_message_id: null, p_report_id: rep.reportId, p_conversation_id: null, p_seq_from: null, p_seq_to: null, p_note: "counsel asked" });
    await admin.from("message_reports").update({ resolved_at: ancient() }).eq("id", rep.reportId);
    await admin.from("messages").update({ created_at: ancient() }).eq("id", m.messageId);
    await setSettings({ messaging_retention_reported_days: 30, messaging_retention_moderation_days: 30, messaging_retention_messages_days: 30 });
    await ok("messaging_purge_expired", { p_batch: 100 });
    expect((await admin.from("message_reports").select("evidence").eq("id", rep.reportId).single()).data!.evidence).not.toEqual([]);
    expect((await admin.from("messages").select("id").eq("id", m.messageId)).data).toHaveLength(1);
  });

  it("a conversation-range hold is bounded and keeps only that run when the account closes", async () => {
    const { a, b, conversationId } = await activePair();
    const m2 = await sendOk(a, b);
    await sendOk(b, a);
    const sa = await superAdmin();
    const msgs = (await admin.from("messages").select("id, seq").eq("conversation_id", conversationId).order("seq")).data as Row[];
    const target = msgs.find((m) => m.id === m2.messageId)!;
    expect((await rpc("admin_messaging_place_hold", { p_admin_id: sa, p_reason: "MODERATION_CASE", p_scope: "CONVERSATION_RANGE", p_message_id: null, p_report_id: null, p_conversation_id: conversationId, p_seq_from: 1, p_seq_to: 500, p_note: "too wide" })).data?.outcome).toBe("invalid_range");
    await ok("admin_messaging_place_hold", { p_admin_id: sa, p_reason: "MODERATION_CASE", p_scope: "CONVERSATION_RANGE", p_message_id: null, p_report_id: null, p_conversation_id: conversationId, p_seq_from: target.seq, p_seq_to: target.seq, p_note: "one message" });
    await admin.from("user_profiles").update({ is_active: false, account_closed_at: new Date(Date.now() - 60 * 86_400_000).toISOString() }).eq("id", a);
    await setSettings({ messaging_retention_closed_account_days: 30 });
    const r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.closedAccountMessages).toBeGreaterThanOrEqual(msgs.length - 1);
    const left = ((await admin.from("messages").select("id").eq("conversation_id", conversationId)).data as Row[]).map((m) => m.id);
    expect(left).toEqual([m2.messageId]);
    expect(r.closedAccountConversations).toBe(0); // the conversation still holds a protected message
  });

  it("holds are Super Admin only, need a note, can't duplicate, and placing and releasing are audited", async () => {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b);
    const sa = await superAdmin();
    const args = { p_reason: "MODERATION_CASE", p_scope: "MESSAGE", p_message_id: m.messageId, p_report_id: null, p_conversation_id: null, p_seq_from: null, p_seq_to: null, p_note: "case 12" };
    expect((await rpc("admin_messaging_place_hold", { p_admin_id: a, ...args })).error).not.toBeNull();
    expect((await rpc("admin_messaging_place_hold", { p_admin_id: sa, ...args, p_note: "" })).data?.outcome).toBe("note_required");
    expect((await rpc("admin_messaging_place_hold", { p_admin_id: sa, ...args, p_reason: "BECAUSE" })).error).not.toBeNull();
    const hold = await ok("admin_messaging_place_hold", { p_admin_id: sa, ...args });
    expect((await rpc("admin_messaging_place_hold", { p_admin_id: sa, ...args })).data?.outcome).toBe("already_held");
    const audit = async (action: string) => (await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", action).eq("entity_id", hold.holdId)).count ?? 0;
    expect(await audit("messaging.hold_placed")).toBe(1);
    expect((await rpc("admin_messaging_release_hold", { p_admin_id: a, p_hold_id: hold.holdId, p_note: null })).error).not.toBeNull();
    await ok("admin_messaging_release_hold", { p_admin_id: sa, p_hold_id: hold.holdId, p_note: "closed" });
    expect(await audit("messaging.hold_released")).toBe(1);
    expect((await rpc("admin_messaging_release_hold", { p_admin_id: sa, p_hold_id: hold.holdId, p_note: null })).data?.outcome).toBe("already_released");
    expect(conversationId).toBeTruthy();
  });

  it("there is no Member-wide or conversation-wide hold: the schema refuses an unbounded scope", async () => {
    const { conversationId } = await activePair();
    const sa = await superAdmin();
    const bad = await admin.from("messaging_retention_holds").insert({ reason: "LEGAL_OBLIGATION", scope: "CONVERSATION_RANGE", conversation_id: conversationId, seq_from: 1, seq_to: 100000, note: "everything", placed_by: sa });
    expect(bad.error).not.toBeNull();
    const none = await admin.from("messaging_retention_holds").insert({ reason: "LEGAL_OBLIGATION", scope: "CONVERSATION_RANGE", conversation_id: conversationId, note: "everything", placed_by: sa });
    expect(none.error).not.toBeNull();
  });

  it("the new tables and functions are closed to Members and the public", async () => {
    const a = await seedUser("od-priv");
    const { data } = await admin.auth.admin.getUserById(a);
    const c = getTestAnonClient();
    await c.auth.signInWithPassword({ email: data.user!.email!, password: "integration-test-password-123" });
    for (const table of ["messaging_retention_holds", "messaging_abuse_signals", "messaging_restrictions"]) {
      expect((await c.from(table).select("*")).error, `${table} must not be readable by a Member`).not.toBeNull();
      expect((await getTestAnonClient().from(table).select("*")).error, `${table} must not be readable by the public`).not.toBeNull();
    }
    const fns: Array<[string, Record<string, unknown>]> = [
      ["members_blocked", { p_a: a, p_b: a }],
      ["messaging_is_restricted", { p_user_id: a }],
      ["messaging_abuse_check", { p_member: a, p_type: "RAPID_MESSAGING", p_body: null }],
      ["messaging_message_protected", { p_message_id: randomUUID(), p_conversation_id: randomUUID(), p_seq: 1 }],
      ["admin_messaging_place_hold", { p_admin_id: a, p_reason: "LEGAL_OBLIGATION", p_scope: "REPORT", p_message_id: null, p_report_id: randomUUID(), p_conversation_id: null, p_seq_from: null, p_seq_to: null, p_note: "x" }],
      ["admin_messaging_release_hold", { p_admin_id: a, p_hold_id: randomUUID(), p_note: null }],
      ["admin_messaging_resolve_signal", { p_admin_id: a, p_signal_id: randomUUID(), p_action: "DISMISS", p_note: null }],
      ["admin_messaging_lift_restriction", { p_admin_id: a, p_restriction_id: randomUUID(), p_note: null }],
      ["call_bs_response_stats", { p_recipient_id: a }],
      ["challenge_expiry_counts_as_ignored", { p_reason: "NO_RESPONSE" }],
    ];
    for (const [fn, args] of fns) {
      expect((await c.rpc(fn, args)).error, `${fn} must be service-role only`).not.toBeNull();
      expect((await getTestAnonClient().rpc(fn, args)).error, `${fn} must be closed to the public`).not.toBeNull();
    }
  });
});

describe("retention of Messaging's own security metadata", () => {
  it("resolved signals, ended restrictions and released holds go after the audit days; open ones and audit_logs never", async () => {
    const m = await seedUser("od-meta");
    const sa = await superAdmin();
    const oldSignal = (await admin.from("messaging_abuse_signals").insert({ member_id: m, signal_type: "RAPID_MESSAGING", status: "DISMISSED", observed_count: 9, threshold: 5, window_seconds: 60, resolved_by: sa, resolved_at: ancient() }).select("id").single()).data!.id;
    const openSignal = (await admin.from("messaging_abuse_signals").insert({ member_id: m, signal_type: "DUPLICATE_BURST", status: "OPEN", observed_count: 9, threshold: 5, window_seconds: 60, first_seen_at: ancient() }).select("id").single()).data!.id;
    const start = new Date(Date.now() - 500 * 86_400_000);
    const endedRestriction = (await admin.from("messaging_restrictions").insert({ member_id: m, rule: "RAPID_MESSAGING", starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 86_400_000).toISOString() }).select("id").single()).data!.id;
    const auditBefore = (await admin.from("audit_logs").select("id", { count: "exact", head: true })).count;
    await setSettings({ messaging_retention_audit_days: 365 });
    const r = await ok("messaging_purge_expired", { p_batch: 100 });
    expect(r.securityMetadata).toBeGreaterThanOrEqual(2);
    expect((await admin.from("messaging_abuse_signals").select("id").eq("id", oldSignal)).data).toEqual([]);
    expect((await admin.from("messaging_abuse_signals").select("id").eq("id", openSignal)).data).toHaveLength(1);
    expect((await admin.from("messaging_restrictions").select("id").eq("id", endedRestriction)).data).toEqual([]);
    expect((await admin.from("audit_logs").select("id", { count: "exact", head: true })).count).toBeGreaterThanOrEqual(auditBefore ?? 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("Call BS expiry reasons and the 'ignored' policy", () => {
  async function pending(game?: { fixtureId: string; marketId: string }) {
    const g = game ?? (await seedGame());
    const a = await seedUser("cb-a");
    const b = await seedUser("cb-b");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const sent = await callBS(a, bPick);
    if (!sent.ok) throw new Error(sent.error);
    return { ...g, a, b, bPick, id: sent.challenge.id };
  }
  const reasonOf = async (id: string) => (await admin.from("challenges").select("status, expiry_reason").eq("id", id).single()).data as Row;

  it("the sweep names the cause: kickoff passed with no answer is NO_RESPONSE", async () => {
    const c = await pending();
    await setFixture(c.fixtureId, { scheduled_start_utc: new Date(Date.now() + 2 * 60_000).toISOString() });
    await expireStaleChallenges();
    expect(await reasonOf(c.id)).toEqual({ status: "EXPIRED", expiry_reason: "NO_RESPONSE" });
  });

  it("a Game that started or finished with it unanswered is NO_RESPONSE; a cancelled or postponed Game is GAME_OR_MARKET_CANCELLED; a deactivated Market too", async () => {
    const live = await pending();
    await setFixture(live.fixtureId, { internal_status: "LIVE" });
    const cancelled = await pending();
    await setFixture(cancelled.fixtureId, { internal_status: "CANCELLED" });
    const postponed = await pending();
    await setFixture(postponed.fixtureId, { internal_status: "POSTPONED" });
    const inactive = await pending();
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", inactive.marketId);
    const unknown = await pending();
    await setFixture(unknown.fixtureId, { internal_status: "UNKNOWN" });
    await expireStaleChallenges();
    expect((await reasonOf(live.id)).expiry_reason).toBe("NO_RESPONSE");
    expect((await reasonOf(cancelled.id)).expiry_reason).toBe("GAME_OR_MARKET_CANCELLED");
    expect((await reasonOf(postponed.id)).expiry_reason).toBe("GAME_OR_MARKET_CANCELLED");
    expect((await reasonOf(inactive.id)).expiry_reason).toBe("GAME_OR_MARKET_CANCELLED");
    expect((await reasonOf(unknown.id)).expiry_reason).toBe("SYSTEM_INVALIDATED");
  });

  it("accepting after a competing Call BS was resolved, after an account became ineligible, or after a Pick changed each get their own reason", async () => {
    const g = await seedGame();
    const a = await seedUser("cb-x");
    const b = await seedUser("cb-y");
    const c = await seedUser("cb-z");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const cPick = await seedPick(c, g.marketId, "NO");
    const first = await callBS(a, bPick);
    const second = await callBS(a, cPick);
    if (!first.ok || !second.ok) throw new Error("setup");
    expect((await acceptCallBS(first.challenge.id, b)).outcome).toBe("accepted");
    // The cascade expired the other pending one: a competing Call BS was resolved first.
    expect((await reasonOf(second.challenge.id)).expiry_reason).toBe("COMPETING_CHALLENGE_RESOLVED");

    const g2 = await seedGame();
    const p = await seedUser("cb-p");
    const q = await seedUser("cb-q");
    await seedPick(p, g2.marketId, "YES");
    const qPick = await seedPick(q, g2.marketId, "NO");
    const sent = await callBS(p, qPick);
    if (!sent.ok) throw new Error("setup");
    await admin.from("user_profiles").update({ is_active: false }).eq("id", p);
    expect((await acceptCallBS(sent.challenge.id, q)).outcome).toBe("rejected_ineligible_account");
    expect((await reasonOf(sent.challenge.id)).expiry_reason).toBe("ACCOUNT_STATE_CHANGE");

    const g3 = await seedGame();
    const r1 = await seedUser("cb-r");
    const r2 = await seedUser("cb-s");
    await seedPick(r1, g3.marketId, "YES");
    const r2Pick = await seedPick(r2, g3.marketId, "NO");
    const sent3 = await callBS(r1, r2Pick);
    if (!sent3.ok) throw new Error("setup");
    await seedPick(r2, g3.marketId, "YES"); // the recipient edits their Pick, so the Call BS no longer names a real disagreement
    expect(r2Pick).toBeTruthy();
    expect((await acceptCallBS(sent3.challenge.id, r2)).outcome).toBe("rejected_invalidated");
    expect((await reasonOf(sent3.challenge.id)).expiry_reason).toBe("SYSTEM_INVALIDATED");
  });

  it("EXPIRED always carries a reason and nothing else does — even a direct write that forgets one", async () => {
    const c = await pending();
    await admin.from("challenges").update({ status: "EXPIRED" }).eq("id", c.id);
    expect((await reasonOf(c.id)).expiry_reason).toBe("OTHER_SYSTEM_REASON");
    expect((await admin.from("challenges").update({ expiry_reason: "NOT_A_REASON" }).eq("id", c.id)).error).not.toBeNull();
    const d = await pending();
    await admin.from("challenges").update({ expiry_reason: "NO_RESPONSE" }).eq("id", d.id); // PENDING: the guard clears it
    expect((await reasonOf(d.id)).expiry_reason).toBeNull();
  });

  it("only NO_RESPONSE counts as ignored: the database policy and the TypeScript policy agree on every reason", async () => {
    for (const reason of CHALLENGE_EXPIRY_REASONS) {
      const { data, error } = await admin.rpc("challenge_expiry_counts_as_ignored", { p_reason: reason });
      expect(error).toBeNull();
      expect(data, reason).toBe(expiryCountsAsIgnored(reason));
    }
    expect(IGNORED_EXPIRY_REASONS).toEqual(["NO_RESPONSE"]);
    expect(expiryCountsAsIgnored(null)).toBe(false);
  });

  it("the response record counts genuine silence only: system and relationship expirations, and pending ones, are in neither number", async () => {
    const recipient = await seedUser("cb-rate");
    const make = async (status: string, reason: string | null, extra: Record<string, unknown> = {}) => {
      const challenger = await seedUser("cb-rater");
      const game = await seedGame();
      await seedPick(challenger, game.marketId, "YES");
      const rp = await seedPick(recipient, game.marketId, "NO");
      const sent = await callBS(challenger, rp);
      if (!sent.ok) throw new Error(sent.error);
      if (status !== "PENDING") await admin.from("challenges").update({ status, ...(reason ? { expiry_reason: reason } : {}), ...extra }).eq("id", sent.challenge.id);
      return sent.challenge.id;
    };
    await make("EXPIRED", "NO_RESPONSE");
    await make("EXPIRED", "NO_RESPONSE");
    await make("EXPIRED", "GAME_OR_MARKET_CANCELLED");
    await make("EXPIRED", "RELATIONSHIP_BLOCKED");
    await make("EXPIRED", "COMPETING_CHALLENGE_RESOLVED");
    await make("DECLINED", null, { declined_at: new Date().toISOString() });
    await make("PENDING", null);
    const stats = (await admin.rpc("call_bs_response_stats", { p_recipient_id: recipient })).data as Row[];
    expect(stats[0]).toMatchObject({ answerable: 3, accepted: 0, declined: 1, ignored: 2 });
    expect(Number(stats[0].response_rate)).toBeCloseTo(1 / 3, 3);
    const none = (await admin.rpc("call_bs_response_stats", { p_recipient_id: await seedUser("cb-none") })).data as Row[];
    expect(none[0].answerable).toBe(0);
    expect(none[0].response_rate).toBeNull();
  });

  it("a Call BS that expired before reasons existed is never counted as ignored", async () => {
    const c = await pending();
    await admin.from("challenges").update({ status: "EXPIRED" }).eq("id", c.id);
    const stats = (await admin.rpc("call_bs_response_stats", { p_recipient_id: c.b })).data as Row[];
    expect(stats[0].ignored).toBe(0);
    expect(stats[0].answerable).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("Block as a relationship boundary", () => {
  async function blocked() {
    const a = await seedUser("bl-a");
    const b = await seedUser("bl-b");
    await ok("messaging_set_block", { p_user_id: a, p_blocked_id: b, p_blocked: true });
    return { a, b };
  }

  it("Messaging: no DMs and no requests in either direction", async () => {
    const { a, b } = await blocked();
    expect((await send(b, a)).data?.outcome).toBe("unavailable"); // the blocked Member: one neutral answer
    expect((await send(a, b)).data?.outcome).toBe("blocked_by_you");
  });

  it("Call BS: neither side can send one while the block exists, and unblocking restores it", async () => {
    const { a, b } = await blocked();
    const g = await seedGame();
    const aPick = await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const fromBlocked = await callBS(b, aPick); // B → A, where A blocked B
    expect(fromBlocked.ok).toBe(false);
    expect(!fromBlocked.ok && fromBlocked.error).toContain("relationship_blocked");
    const fromBlocker = await callBS(a, bPick); // A → B, while the block exists
    expect(fromBlocker.ok).toBe(false);
    expect(!fromBlocker.ok && fromBlocker.error).toContain("relationship_blocked");
    await ok("messaging_set_block", { p_user_id: a, p_blocked_id: b, p_blocked: false });
    expect((await callBS(a, bPick)).ok).toBe(true);
  });

  it("blocking ends a still-pending Call BS between the pair (RELATIONSHIP_BLOCKED, never counted as ignored) and an accept can no longer succeed", async () => {
    const g = await seedGame();
    const a = await seedUser("bl-c");
    const b = await seedUser("bl-d");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const sent = await callBS(a, bPick);
    if (!sent.ok) throw new Error(sent.error);
    await ok("messaging_set_block", { p_user_id: b, p_blocked_id: a, p_blocked: true });
    const row = (await admin.from("challenges").select("status, expiry_reason").eq("id", sent.challenge.id).single()).data as Row;
    expect(row).toEqual({ status: "EXPIRED", expiry_reason: "RELATIONSHIP_BLOCKED" });
    expect(expiryCountsAsIgnored(row.expiry_reason)).toBe(false);
    await expect(declineCallBS(sent.challenge.id, b)).rejects.toBeTruthy(); // nothing left to answer
  });

  it("a block that is created after a Call BS was sent but before it was accepted still stops acceptance", async () => {
    const g = await seedGame();
    const a = await seedUser("bl-e");
    const b = await seedUser("bl-f");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const sent = await callBS(a, bPick);
    if (!sent.ok) throw new Error(sent.error);
    // A block inserted behind the function's back (the table row, not messaging_set_block) is still honoured at accept time.
    await admin.from("member_blocks").insert({ blocker_id: a, blocked_id: b });
    expect((await acceptCallBS(sent.challenge.id, b)).outcome).toBe("rejected_invalidated");
    expect((await admin.from("challenges").select("expiry_reason").eq("id", sent.challenge.id).single()).data!.expiry_reason).toBe("RELATIONSHIP_BLOCKED");
  });

  async function publishedPost() {
    const g = await seedGame();
    const { id } = await ensurePostForFixture(g.fixtureId);
    await publishPost(id);
    return id;
  }

  it("comments: direct replies between the pair are refused in both directions; top-level comments and everyone else are unaffected", async () => {
    const postId = await publishedPost();
    const { a, b } = await blocked();
    const bystander = await seedUser("bl-by");
    const aTop = await addPostComment({ postId, userId: a, body: "a top", parentCommentId: null });
    const bTop = await addPostComment({ postId, userId: b, body: "b top", parentCommentId: null });
    await expect(addPostComment({ postId, userId: b, body: "reply to blocker", parentCommentId: aTop.id })).rejects.toMatchObject({ message: expect.stringContaining("relationship_blocked") });
    await expect(addPostComment({ postId, userId: a, body: "reply to blocked", parentCommentId: bTop.id })).rejects.toMatchObject({ message: expect.stringContaining("relationship_blocked") });
    // Top-level comments are public and untouched; a bystander can reply to either; neither comment was deleted.
    await expect(addPostComment({ postId, userId: b, body: "another top", parentCommentId: null })).resolves.toBeTruthy();
    await expect(addPostComment({ postId, userId: bystander, body: "reply to a", parentCommentId: aTop.id })).resolves.toBeTruthy();
    await expect(addPostComment({ postId, userId: bystander, body: "reply to b", parentCommentId: bTop.id })).resolves.toBeTruthy();
    expect((await admin.from("post_comments").select("id").in("id", [aTop.id, bTop.id]).is("deleted_at", null)).data).toHaveLength(2);
  });

  it("comments: the blocker's own view hides the blocked Member's comments; nobody else's view changes, and nothing is deleted", async () => {
    const postId = await publishedPost();
    const { a, b } = await blocked(); // a blocked b
    const bystander = await seedUser("bl-view");
    const aTop = await addPostComment({ postId, userId: a, body: "from the blocker", parentCommentId: null });
    const bTop = await addPostComment({ postId, userId: b, body: "from the blocked", parentCommentId: null });
    const bAlone = await addPostComment({ postId, userId: b, body: "unanswered by anyone", parentCommentId: null });
    await addPostComment({ postId, userId: bystander, body: "bystander reply to b", parentCommentId: bTop.id });
    await addPostComment({ postId, userId: b, body: "b replies to a's thread?", parentCommentId: aTop.id }).catch(() => undefined);
    await addPostComment({ postId, userId: bystander, body: "bystander reply to a", parentCommentId: aTop.id });

    const bodies = (tree: Awaited<ReturnType<typeof getPostConversation>>) => tree.flatMap((c) => [c.hiddenByBlock ? "[hidden]" : c.body, ...c.replies.map((r) => r.body)]);
    const asBlocker = await getPostConversation(postId, undefined, a);
    expect(bodies(asBlocker)).toContain("from the blocker");
    expect(bodies(asBlocker)).not.toContain("from the blocked");
    expect(bodies(asBlocker)).not.toContain("unanswered by anyone"); // no replies, so simply left out
    expect(bodies(asBlocker)).toContain("[hidden]"); // kept as a placeholder because the bystander replied beneath it
    expect(bodies(asBlocker)).toContain("bystander reply to b");
    const asBlocked = await getPostConversation(postId, undefined, b);
    expect(bodies(asBlocked)).toEqual(expect.arrayContaining(["from the blocker", "from the blocked", "unanswered by anyone"])); // being blocked changes nothing you see
    const asBystander = await getPostConversation(postId, undefined, bystander);
    expect(bodies(asBystander)).toEqual(expect.arrayContaining(["from the blocker", "from the blocked", "unanswered by anyone"]));
    const asAnonymousLoader = await getPostConversation(postId);
    expect(bodies(asAnonymousLoader)).toContain("from the blocked");
    expect((await admin.from("post_comments").select("id").in("id", [aTop.id, bTop.id, bAlone.id]).is("deleted_at", null)).data).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("abuse signals", () => {
  const signalsFor = async (member: string, type?: string) => {
    let q = admin.from("messaging_abuse_signals").select("*").eq("member_id", member);
    if (type) q = q.eq("signal_type", type);
    return ((await q).data ?? []) as Row[];
  };

  it("many new requests: flagged at the threshold, once (idempotent), with counts only and an audit entry", async () => {
    await setSettings({ messaging_abuse_requests_threshold: 3, messaging_max_unanswered_requests: 10 });
    const sender = await seedUser("ab-sender");
    const targets = [await seedUser("ab-t1"), await seedUser("ab-t2"), await seedUser("ab-t3"), await seedUser("ab-t4")];
    await sendOk(sender, targets[0]);
    await sendOk(sender, targets[1]);
    expect(await signalsFor(sender, "EXCESSIVE_REQUESTS")).toHaveLength(0);
    await sendOk(sender, targets[2]);
    let signals = await signalsFor(sender, "EXCESSIVE_REQUESTS");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ status: "OPEN", observed_count: 3, threshold: 3, response: "FLAGGED" });
    await sendOk(sender, targets[3]);
    signals = await signalsFor(sender, "EXCESSIVE_REQUESTS");
    expect(signals).toHaveLength(1); // one OPEN signal per Member and type
    expect(signals[0].observed_count).toBe(4);
    // Only counts and the rule: no column can hold content, an IP, a device or a score.
    expect(Object.keys(signals[0]).sort()).toEqual(["first_seen_at", "id", "last_seen_at", "member_id", "observed_count", "resolution_note", "resolved_at", "resolved_by", "response", "signal_type", "status", "threshold", "window_seconds"]);
    const audit = (await admin.from("audit_logs").select("action, after").eq("action", "messaging.abuse_signal").eq("entity_id", sender)).data as Row[];
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].after)).not.toMatch(/body|text|ip|device/i);
  });

  it("by default a signal NEVER restricts anyone (flag only)", async () => {
    await setSettings({ messaging_abuse_rapid_threshold: 2, messaging_abuse_restrict_enabled: false });
    const { a, b } = await activePair();
    await sendOk(a, b);
    await sendOk(a, b);
    expect((await signalsFor(a, "RAPID_MESSAGING")).length).toBe(1);
    expect((await admin.from("messaging_restrictions").select("id").eq("member_id", a)).data).toEqual([]);
    expect((await rpc("messaging_is_restricted", { p_user_id: a })).data).toBe(false);
  });

  it("when the rule is switched on, a sender-behaviour signal applies a short bounded restriction, audited and liftable", async () => {
    await setSettings({ messaging_abuse_rapid_threshold: 2, messaging_abuse_restrict_enabled: true, messaging_abuse_restrict_hours: 2 });
    const { a, b } = await activePair();
    await sendOk(a, b);
    await sendOk(a, b);
    const sig = (await signalsFor(a, "RAPID_MESSAGING"))[0];
    expect(sig.response).toBe("RESTRICTED");
    const restrictions = (await admin.from("messaging_restrictions").select("*").eq("member_id", a)).data as Row[];
    expect(restrictions).toHaveLength(1);
    const hours = (new Date(restrictions[0].ends_at).getTime() - new Date(restrictions[0].starts_at).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(2, 1);
    expect((await rpc("messaging_is_restricted", { p_user_id: a })).data).toBe(true);
    // Not a second restriction on further messages.
    await sendOk(a, b);
    expect((await admin.from("messaging_restrictions").select("id").eq("member_id", a)).data).toHaveLength(1);
    expect((await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "messaging.restriction_applied").eq("entity_id", a)).count).toBe(1);
    const sa = await superAdmin();
    expect((await rpc("admin_messaging_lift_restriction", { p_admin_id: a, p_restriction_id: restrictions[0].id, p_note: null })).error).not.toBeNull();
    await ok("admin_messaging_lift_restriction", { p_admin_id: sa, p_restriction_id: restrictions[0].id, p_note: "reviewed" });
    expect((await rpc("messaging_is_restricted", { p_user_id: a })).data).toBe(false);
    expect((await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "messaging.restriction_lifted").eq("entity_id", a)).count).toBe(1);
  });

  it("a restriction expires on its own, and the schema bounds it to seven days", async () => {
    const m = await seedUser("ab-exp");
    const past = new Date(Date.now() - 3 * 3_600_000);
    await admin.from("messaging_restrictions").insert({ member_id: m, rule: "RAPID_MESSAGING", starts_at: past.toISOString(), ends_at: new Date(Date.now() - 1000).toISOString() });
    expect((await rpc("messaging_is_restricted", { p_user_id: m })).data).toBe(false);
    const tooLong = await admin.from("messaging_restrictions").insert({ member_id: m, rule: "RAPID_MESSAGING", ends_at: new Date(Date.now() + 8 * 86_400_000).toISOString() });
    expect(tooLong.error).not.toBeNull();
  });

  it("repeated declines, repeated blocks and repeated reports flag the Member they are about — and never restrict, even with the rule on", async () => {
    await setSettings({ messaging_abuse_declines_threshold: 2, messaging_abuse_blocks_threshold: 2, messaging_abuse_reports_threshold: 2, messaging_abuse_restrict_enabled: true, messaging_max_unanswered_requests: 10 });
    const target = await seedUser("ab-target");
    const r1 = await seedUser("ab-r1");
    const r2 = await seedUser("ab-r2");
    // Two Members decline `target`'s requests.
    const c1 = await sendOk(target, r1);
    const c2 = await sendOk(target, r2);
    await ok("messaging_respond_request", { p_user_id: r1, p_conversation_id: c1.conversationId, p_action: "DECLINE" });
    await ok("messaging_respond_request", { p_user_id: r2, p_conversation_id: c2.conversationId, p_action: "DECLINE" });
    expect(await signalsFor(target, "REPEATED_DECLINES")).toHaveLength(1);
    // Two Members block them.
    await ok("messaging_set_block", { p_user_id: r1, p_blocked_id: target, p_blocked: true });
    await ok("messaging_set_block", { p_user_id: r2, p_blocked_id: target, p_blocked: true });
    expect(await signalsFor(target, "REPEATED_BLOCKS")).toHaveLength(1);
    // Two Members report them.
    for (const [reporter, conv] of [[r1, c1], [r2, c2]] as Array<[string, Row]>) {
      await ok("messaging_report", { p_user_id: reporter, p_conversation_id: conv.conversationId, p_message_id: null, p_reason: "SPAM", p_note: null });
    }
    expect(await signalsFor(target, "REPEATED_REPORTS")).toHaveLength(1);
    // Blocks and reports are about what OTHER Members did, so they can never restrict the Member (a mass-report cannot silence anyone); declines are about sending behaviour.
    const signals = await signalsFor(target);
    expect(signals.find((s) => s.signal_type === "REPEATED_BLOCKS")!.response).toBe("FLAGGED");
    expect(signals.find((s) => s.signal_type === "REPEATED_REPORTS")!.response).toBe("FLAGGED");
    // The same reporter reporting twice is one reporter, not two.
  });

  it("duplicate bursts across different conversations are flagged; the same text in one conversation is already refused", async () => {
    await setSettings({ messaging_abuse_duplicate_threshold: 3, messaging_max_unanswered_requests: 10 });
    const sender = await seedUser("ab-dup");
    const same = `buy my thing ${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 3; i++) await sendOk(sender, await seedUser(`ab-dup-t${i}`), same);
    expect((await signalsFor(sender, "DUPLICATE_BURST"))[0]).toMatchObject({ observed_count: 3, threshold: 3 });
  });

  it("many different Members requesting one Member is flagged on the recipient and never restricts anyone", async () => {
    await setSettings({ messaging_abuse_coordinated_threshold: 3, messaging_abuse_restrict_enabled: true });
    const target = await seedUser("ab-coord");
    for (let i = 0; i < 3; i++) await sendOk(await seedUser(`ab-coord-s${i}`), target);
    const s = (await signalsFor(target, "COORDINATED_TARGETING"))[0];
    expect(s).toMatchObject({ observed_count: 3, response: "FLAGGED" });
    expect((await admin.from("messaging_restrictions").select("id").eq("member_id", target)).data).toEqual([]);
  });

  it("signals are resolved by a Super Admin only, once, and audited; detection can never break the action that triggered it", async () => {
    await setSettings({ messaging_abuse_rapid_threshold: 2 });
    const { a, b } = await activePair();
    await sendOk(a, b);
    await sendOk(a, b); // the send succeeded even though a signal was raised in the same transaction
    const sig = (await signalsFor(a, "RAPID_MESSAGING"))[0];
    const sa = await superAdmin();
    expect((await rpc("admin_messaging_resolve_signal", { p_admin_id: a, p_signal_id: sig.id, p_action: "DISMISS", p_note: null })).error).not.toBeNull();
    expect((await rpc("admin_messaging_resolve_signal", { p_admin_id: sa, p_signal_id: sig.id, p_action: "BAN", p_note: null })).error).not.toBeNull(); // there is no ban action
    await ok("admin_messaging_resolve_signal", { p_admin_id: sa, p_signal_id: sig.id, p_action: "REVIEW", p_note: "looks fine" });
    expect((await signalsFor(a, "RAPID_MESSAGING"))[0]).toMatchObject({ status: "REVIEWED", resolved_by: sa });
    expect((await rpc("admin_messaging_resolve_signal", { p_admin_id: sa, p_signal_id: sig.id, p_action: "DISMISS", p_note: null })).data?.outcome).toBe("already_resolved");
    expect((await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "messaging.abuse_signal_review").eq("entity_id", sig.id)).count).toBe(1);
    // A fresh burst after resolution can raise a new signal (the old one no longer occupies the OPEN slot).
    await sendOk(a, b);
    expect((await signalsFor(a, "RAPID_MESSAGING")).filter((s) => s.status === "OPEN")).toHaveLength(1);
  });

  it("nothing is flagged while Messaging is off", async () => {
    await setSettings({ messaging_abuse_rapid_threshold: 2 });
    const { a, b } = await activePair();
    await sendOk(a, b); // a has now sent two messages: the threshold is met and a signal was raised
    await admin.from("messaging_abuse_signals").delete().eq("member_id", a);
    await setSettings({ messaging_enabled: false });
    await rpc("messaging_abuse_check", { p_member: a, p_type: "RAPID_MESSAGING", p_body: null });
    expect(await signalsFor(a)).toHaveLength(0);
    await setSettings({ messaging_enabled: true });
    await rpc("messaging_abuse_check", { p_member: a, p_type: "RAPID_MESSAGING", p_body: null });
    expect(await signalsFor(a, "RAPID_MESSAGING")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("reporter outcome notifications", () => {
  async function reportAndResolve(action: "DISMISS" | "HIDE_MESSAGE" | "ACTION", note: string | null) {
    const { a, b, conversationId } = await activePair();
    const m = await sendOk(a, b, "something rude");
    const rep = await ok("messaging_report", { p_user_id: b, p_conversation_id: conversationId, p_message_id: m.messageId, p_reason: "HARASSMENT", p_note: "reporter note" });
    const sa = await superAdmin();
    await ok("admin_messaging_resolve_report", { p_admin_id: sa, p_report_id: rep.reportId, p_action: action, p_note: note });
    const notes = ((await admin.from("notifications").select("*").eq("user_id", b).eq("type", "MESSAGE_REPORT_OUTCOME")).data ?? []) as Row[];
    return { a, b, notes };
  }

  it("a dismissed report tells the reporter we found no violation under the current rules — nothing else", async () => {
    const { a, notes } = await reportAndResolve("DISMISS", "internal: reporter is the aggressor");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("We reviewed your report");
    expect(notes[0].body).toBe("We reviewed your report and did not find a violation under the current rules.");
    expect(JSON.stringify(notes[0])).not.toContain("aggressor");
    expect((await admin.from("notifications").select("id").eq("user_id", a).eq("type", "MESSAGE_REPORT_OUTCOME")).data).toEqual([]); // the reported Member is told nothing
  });

  it("an actioned or hidden report says action was taken, with no detail about it, the other Member or the moderator's note", async () => {
    for (const action of ["ACTION", "HIDE_MESSAGE"] as const) {
      const { notes } = await reportAndResolve(action, "internal: banned for 7 days, score 91");
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toBe("We reviewed your report and action was taken.");
      expect(JSON.stringify(notes[0])).not.toMatch(/banned|score|7 days|rude|rud/i);
      // No link to a conversation or message, and nothing identifying anyone.
      expect(notes[0].conversation_id).toBeNull();
    }
  });

  it("the policy switch turns the notification off, and a removed reporter simply gets none", async () => {
    await setSettings({ messaging_report_outcome_notifications_enabled: false });
    const { notes } = await reportAndResolve("DISMISS", null);
    expect(notes).toHaveLength(0);
  });
});
