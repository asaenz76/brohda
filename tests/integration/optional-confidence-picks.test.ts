/**
 * Brohda 2.1, Milestone 1 (migration 211): Confidence is OPTIONAL again, and a Pick is committed by Confidence, not by being made.
 *   - the policy switch (audited, Super Admin, idempotent, write-once "first enabled", reversible, never touching the one-way mandatory cutover);
 *   - an unstaked Pick: created, kept, changed until T-10, refused at/after T-10 and after the Game starts;
 *   - Confidence attached to an existing Pick: reserves exactly the stake, locks the TEAM and fixes the AMOUNT at once, refused at T-10, allowed on a Pick an accepted Call BS has locked;
 *   - changing an editable Pick cancels every PENDING Call BS on it (EXPIRED / PICK_CHANGED), audited, with the notification going to the OTHER participant once;
 *   - the Pick's derived state, era-aware reconciliation/diagnostics, historical rows untouched, new privileges.
 * Real local Supabase. The concurrency, lock-order and T-10-during-a-lock-wait proofs are in optional-confidence-concurrency.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedUser, setFixture } from "./helpers/game-seed";
import { derivePickState } from "@/lib/predictions/pick-state";
import { challengeResponseRate, expiryCountsAsIgnored } from "@/lib/challenges/expiry";
import { notifyPickChangedCancellations, reconcileChallengeCancellationNotifications } from "@/lib/notifications/challenges";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function sql<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}
/** Statements run with triggers off (the explicit remediation/seed path a real connection has) — used only to build historical shapes a normal path can no longer create. */
async function sqlReplica(text: string, params: unknown[] = []): Promise<Row[]> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const r = await client.query(text, params);
    await client.query("commit");
    return r.rows as Row[];
  } finally {
    await client.end();
  }
}
async function resetPolicy() {
  await sqlReplica("update public.platform_settings set confidence_mandatory_since = null, confidence_optional_picks_enabled = false, confidence_optional_first_enabled_at = null where id = true");
}
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};

let staffId: string | null = null;
async function superAdmin() {
  if (!staffId) {
    staffId = await seedUser("opt-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
}
async function ok(name: string, args: Record<string, unknown>) {
  const r = await admin.rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
}
async function activateCutover() {
  await ok("admin_set_confidence_config", { p_admin_id: await superAdmin(), p_config: { confidence_mandatory: true } });
}
async function setOptional(enabled: boolean) {
  return ok("admin_set_confidence_optional_picks", { p_admin_id: await superAdmin(), p_enabled: enabled });
}
const settingsRow = async () => ((await admin.from("platform_settings").select("*").eq("id", true).single()).data as Row);

beforeEach(async () => {
  await resetPolicy();
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true });
});
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});

async function member(label = "op", withAccount = true) {
  const id = await seedUser(label);
  if (withAccount) await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
const account = async (id: string) => (await admin.from("confidence_accounts").select("*").eq("member_id", id).single()).data as Row;
const pickOf = async (userId: string, marketId: string) => ((await admin.from("predictions").select("*").eq("user_id", userId).eq("market_id", marketId).maybeSingle()).data ?? null) as Row | null;
const stakeOf = async (predictionId: string) => ((await admin.from("confidence_prediction_stakes").select("*").eq("prediction_id", predictionId).maybeSingle()).data ?? null) as Row | null;
const challengeOf = async (id: string) => (await admin.from("challenges").select("*").eq("id", id).single()).data as Row;
const reserveEntries = async (memberId: string) => ((await admin.from("confidence_ledger_entries").select("*").eq("member_id", memberId).eq("entry_type", "PREDICTION_RESERVE")).data ?? []) as Row[];

async function setPick(userId: string, marketId: string, side: "YES" | "NO", key: string = randomUUID()) {
  const r = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: side, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: key })
    .single();
  expect(r.error, `set_pick: ${r.error?.message}`).toBeNull();
  return r.data as { prediction: Row | null; outcome: string; cancelled_challenge_ids: string[] | null };
}
async function attach(memberId: string, predictionId: string, amount: number, key: string = randomUUID()) {
  const r = await admin.rpc("confidence_attach_stake", { p_member_id: memberId, p_prediction_id: predictionId, p_amount: amount, p_idempotency_key: key });
  expect(r.error, `attach: ${r.error?.message}`).toBeNull();
  return r.data as Row;
}
async function compose(memberId: string, marketId: string, side: "YES" | "NO", amount: number, key: string = randomUUID()) {
  const r = await admin.rpc("create_confidence_prediction", {
    p_user_id: memberId, p_market_id: marketId, p_selected_outcome: side, p_amount: amount, p_yes_probability: 0.6, p_no_probability: 0.4,
    p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: key,
  });
  expect(r.error, `create_confidence_prediction: ${r.error?.message}`).toBeNull();
  return r.data as Row;
}
async function callBs(challengerId: string, recipientPredictionId: string) {
  return admin.rpc("call_bs", { p_challenger_user_id: challengerId, p_recipient_prediction_id: recipientPredictionId });
}
async function accept(challengeId: string, recipientId: string) {
  const r = await admin.rpc("accept_call_bs", { p_challenge_id: challengeId, p_recipient_user_id: recipientId }).single();
  expect(r.error, `accept_call_bs: ${r.error?.message}`).toBeNull();
  return r.data as { challenge: Row; outcome: string };
}
/** Optional Picks on, in the production-shaped world (the mandatory cutover already set). */
async function optionalWorld() {
  await activateCutover();
  await setOptional(true);
}
/** Two Members with opposing Picks on one Market and a PENDING Call BS from `a` on `b`'s Pick. */
async function pendingPair(marketId: string) {
  const a = await member("opa");
  const b = await member("opb");
  const aPick = (await setPick(a, marketId, "YES")).prediction!;
  const bPick = (await setPick(b, marketId, "NO")).prediction!;
  const created = await callBs(a, bPick.id);
  expect(created.error, created.error?.message).toBeNull();
  return { a, b, aPick, bPick, challenge: created.data as Row };
}

describe("the policy switch", () => {
  it("ships OFF and untouched: today's behaviour holds, the first-enabled instant is empty, and the mandatory cutover is exactly as it was", async () => {
    await activateCutover();
    const s = await settingsRow();
    expect(s.confidence_optional_picks_enabled).toBe(false);
    expect(s.confidence_optional_first_enabled_at).toBeNull();
    expect(s.confidence_two_step_composer_enabled).toBe(false);
    expect(s.confidence_mandatory_since).not.toBeNull();
    const { marketId } = await seedGame({});
    const u = await member();
    expect((await setPick(u, marketId, "YES")).outcome).toBe("rejected_backing_required"); // exactly the mandatory contract
    expect((await attach(u, randomUUID(), 1)).outcome).toBe("retired");
  });

  it("is switched only through the audited Super Admin function: refused for anyone else, idempotent, audited, and it needs Confidence on", async () => {
    await activateCutover();
    const nobody = await member("nobody");
    const refused = await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: nobody, p_enabled: true });
    expect(refused.error).not.toBeNull();
    expect((await settingsRow()).confidence_optional_picks_enabled).toBe(false);

    await setSettings({ confidence_backed_picks_enabled: false });
    const needs = await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: await superAdmin(), p_enabled: true });
    expect(needs.error?.message).toContain("optional_picks_requires_confidence_on");
    await setSettings({ confidence_backed_picks_enabled: true });

    const before = (await admin.from("audit_logs").select("id").eq("action", "settings.confidence_optional_picks_updated")).data!.length;
    await setOptional(true);
    await setOptional(true); // idempotent: nothing more is written
    const audits = ((await admin.from("audit_logs").select("*").eq("action", "settings.confidence_optional_picks_updated")).data ?? []) as Row[];
    expect(audits.length).toBe(before + 1);
    expect(audits.at(-1)!.after.confidence_optional_picks_enabled).toBe(true);
    expect(audits.at(-1)!.before.confidence_optional_picks_enabled).toBe(false);
  });

  it("stamps the first-enabled instant once and keeps it — switching off and on again never moves or clears it; direct tampering is refused; the mandatory cutover never moves", async () => {
    await activateCutover();
    const mandatory = (await settingsRow()).confidence_mandatory_since;
    await setOptional(true);
    const first = (await settingsRow()).confidence_optional_first_enabled_at as string;
    expect(first).not.toBeNull();
    await setOptional(false);
    expect((await settingsRow()).confidence_optional_first_enabled_at).toBe(first);
    await new Promise((r) => setTimeout(r, 20));
    await setOptional(true);
    expect((await settingsRow()).confidence_optional_first_enabled_at).toBe(first);
    expect((await settingsRow()).confidence_mandatory_since).toBe(mandatory);

    const clear = await admin.from("platform_settings").update({ confidence_optional_first_enabled_at: null }).eq("id", true);
    expect(clear.error).not.toBeNull();
    const move = await admin.from("platform_settings").update({ confidence_optional_first_enabled_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", true);
    expect(move.error).not.toBeNull();
    expect((await settingsRow()).confidence_optional_first_enabled_at).toBe(first);
  });

  it("a direct write of the switch still stamps the instant (it can never be on without one)", async () => {
    await setSettings({ confidence_optional_picks_enabled: true });
    expect((await settingsRow()).confidence_optional_first_enabled_at).not.toBeNull();
  });

  it("the two-step composer flag has its own audited switch and changes no database rule", async () => {
    const r = await ok("admin_set_confidence_two_step_composer", { p_admin_id: await superAdmin(), p_enabled: true });
    expect(r.confidence_two_step_composer_enabled).toBe(true);
    expect((await settingsRow()).confidence_optional_picks_enabled).toBe(false);
    const audits = ((await admin.from("audit_logs").select("id").eq("action", "settings.confidence_two_step_composer_updated")).data ?? []) as Row[];
    expect(audits.length).toBeGreaterThan(0);
    const nobody = await member("nobody2");
    expect((await admin.rpc("admin_set_confidence_two_step_composer", { p_admin_id: nobody, p_enabled: false })).error).not.toBeNull();
  });
});

describe("an unstaked Pick (optional Confidence on)", () => {
  it("is created without Confidence: no stake, no reserve, no lock — and it works for a Member with no Confidence account at all", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const u = await member("nocred", false);
    const r = await setPick(u, marketId, "YES");
    expect(r.outcome).toBe("created");
    expect(r.cancelled_challenge_ids ?? []).toEqual([]);
    const pick = await pickOf(u, marketId);
    expect(pick!.locked_at).toBeNull();
    expect(pick!.lock_reason).toBeNull();
    expect(await stakeOf(pick!.id)).toBeNull();
    expect(await reserveEntries(u)).toEqual([]);
  });

  it("the same side again is 'unchanged': no revision, nothing cancelled; the other side is 'updated' with a revision", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const u = await member();
    const first = (await setPick(u, marketId, "YES")).prediction!;
    expect((await setPick(u, marketId, "YES")).outcome).toBe("unchanged");
    expect(((await admin.from("prediction_revisions").select("id").eq("prediction_id", first.id)).data ?? []).length).toBe(0);
    const changed = await setPick(u, marketId, "NO");
    expect(changed.outcome).toBe("updated");
    const revisions = ((await admin.from("prediction_revisions").select("*").eq("prediction_id", first.id)).data ?? []) as Row[];
    expect(revisions.length).toBe(1);
    expect([revisions[0].previous_selected_outcome, revisions[0].new_selected_outcome]).toEqual(["YES", "NO"]);
    expect((await pickOf(u, marketId))!.selected_outcome).toBe("NO");
    expect(await reserveEntries(u)).toEqual([]);
  });

  it("is refused at T-10 and after the Game starts; an existing unstaked Pick can no longer be changed once T-10 passes, and the deadline is recorded as its lock", async () => {
    await optionalWorld();
    const inside = await seedGame({ startsInMinutes: 5 });
    const u = await member();
    expect((await setPick(u, inside.marketId, "YES")).outcome).toBe("rejected_cutoff");
    expect(await pickOf(u, inside.marketId)).toBeNull();

    const started = await seedGame({ startsInMinutes: -5 });
    await setFixture(started.fixtureId, { internal_status: "LIVE" });
    expect((await setPick(u, started.marketId, "YES")).outcome).toBe("rejected_game_closed");

    const g = await seedGame({ startsInMinutes: 12 });
    const made = (await setPick(u, g.marketId, "YES")).prediction!;
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }); // T-10 has now passed
    const late = await setPick(u, g.marketId, "NO");
    expect(late.outcome).toBe("rejected_cutoff");
    const after = (await pickOf(u, g.marketId))!;
    expect(after.id).toBe(made.id);
    expect(after.selected_outcome).toBe("YES"); // the final Pick is the permanent record
    expect(after.lock_reason).toBe("CUTOFF");
  });

  it("is still valid after the switch is turned back off: it keeps its row, and is completed by the composer exactly like an earlier open Pick; plain edits need Confidence again", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const u = await member();
    const made = (await setPick(u, marketId, "YES")).prediction!;
    await setOptional(false);
    expect((await pickOf(u, marketId))!.id).toBe(made.id);
    expect((await setPick(u, marketId, "NO")).outcome).toBe("rejected_backing_required");
    const done = await compose(u, marketId, "YES", 2);
    expect(done.outcome).toBe("created");
    expect(done.predictionId).toBe(made.id);
    expect((await stakeOf(made.id))!.amount).toBe(2);
  });

  it("with the switch OFF the database refuses an unstaked Pick at commit, exactly as before", async () => {
    await activateCutover();
    const { marketId } = await seedGame({});
    const u = await member();
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("insert into public.predictions (user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, market_question_snapshot, market_status_snapshot, idempotency_key) values ($1, $2, 'YES', 0.6, 0.4, 'q', 'ACTIVE', $3)", [u, marketId, randomUUID()]);
      await expect(client.query("commit")).rejects.toThrow(/without Confidence/);
    } finally {
      await client.end();
    }
  });
});

describe("attaching Confidence to a Pick", () => {
  it("reserves exactly the stake, commits the team (CONFIDENCE_COMMITTED) and leaves the selected team alone", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const u = await member();
    const pick = (await setPick(u, marketId, "NO")).prediction!;
    const before = await account(u);
    const r = await attach(u, pick.id, 3);
    expect(r.outcome).toBe("attached");
    expect(r.amount).toBe(3);
    const stake = (await stakeOf(pick.id))!;
    expect([stake.amount, stake.selected_outcome, stake.state]).toEqual([3, "NO", "RESERVED"]);
    const after = await account(u);
    expect([Number(after.available), Number(after.reserved)]).toEqual([Number(before.available) - 3, Number(before.reserved) + 3]);
    const entries = await reserveEntries(u);
    expect(entries.length).toBe(1);
    expect([entries[0].available_delta, entries[0].reserved_delta]).toEqual([-3, 3]);
    const locked = (await pickOf(u, marketId))!;
    expect([locked.selected_outcome, locked.lock_reason]).toEqual(["NO", "CONFIDENCE_COMMITTED"]);
    expect(locked.locked_at).not.toBeNull();
    expect([...new Set((await ok("prediction_lock_reasons", { p_prediction_id: pick.id })) as unknown as string[])]).toEqual(["CONFIDENCE_COMMITTED"]);
  });

  it("locks the team from that moment — even long before T-10 — and fixes the amount: no switching, no second stake, no change, no removal", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({ startsInMinutes: 24 * 60 });
    const u = await member();
    const pick = (await setPick(u, marketId, "YES")).prediction!;
    await attach(u, pick.id, 2);

    expect((await setPick(u, marketId, "NO")).outcome).toBe("rejected_locked");
    expect((await pickOf(u, marketId))!.selected_outcome).toBe("YES");
    const direct = await admin.from("predictions").update({ selected_outcome: "NO" }).eq("id", pick.id);
    expect(direct.error?.message).toContain("Confidence committed behind it");

    expect((await attach(u, pick.id, 4)).outcome).toBe("already_backed");
    expect((await stakeOf(pick.id))!.amount).toBe(2);
    expect((await admin.from("confidence_prediction_stakes").update({ amount: 5 }).eq("prediction_id", pick.id)).error).not.toBeNull();
    expect((await admin.from("confidence_prediction_stakes").delete().eq("prediction_id", pick.id)).error).not.toBeNull();
    expect((await reserveEntries(u)).length).toBe(1);
    const a = await account(u);
    expect(Number(a.reserved)).toBe(2);
  });

  it("is idempotent: the same key replays the first answer and reserves once; a different Pick with that key is a conflict", async () => {
    await optionalWorld();
    const g1 = await seedGame({});
    const g2 = await seedGame({});
    const u = await member();
    const p1 = (await setPick(u, g1.marketId, "YES")).prediction!;
    const p2 = (await setPick(u, g2.marketId, "YES")).prediction!;
    const key = randomUUID();
    expect((await attach(u, p1.id, 1, key)).outcome).toBe("attached");
    const replay = await attach(u, p1.id, 1, key);
    expect(replay.outcome).toBe("attached");
    expect(replay.replay).toBe(true);
    expect((await reserveEntries(u)).length).toBe(1);
    expect((await attach(u, p2.id, 1, key)).outcome).toBe("idempotency_conflict");
  });

  it("refuses an amount off the configured ladder, not enough available Confidence, another Member's Pick, and a Pick that does not exist — creating nothing", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const u = await member();
    const other = await member("other");
    const pick = (await setPick(u, marketId, "YES")).prediction!;
    expect((await attach(u, pick.id, 7)).outcome).toBe("invalid_amount");
    expect((await attach(other, pick.id, 1)).outcome).toBe("not_found");
    expect((await attach(u, randomUUID(), 1)).outcome).toBe("not_found");
    await setSettings({ confidence_baseline: 50 });
    // Spend almost everything on other Markets first: a 5 then needs 5 available.
    for (let i = 0; i < 10; i++) {
      const g = await seedGame({});
      expect((await compose(u, g.marketId, "YES", 5)).outcome).toBe("created");
    }
    const broke = await account(u);
    expect(Number(broke.available)).toBe(0);
    const r = await attach(u, pick.id, 1);
    expect(r.outcome).toBe("insufficient");
    expect(await stakeOf(pick.id)).toBeNull();
    expect((await pickOf(u, marketId))!.locked_at).toBeNull(); // still an open, editable Pick
  });

  it("is refused at T-10 and after the Game starts — a Pick that was fine a moment ago does not get Confidence late", async () => {
    await optionalWorld();
    const u = await member();
    const g = await seedGame({ startsInMinutes: 12 });
    const pick = (await setPick(u, g.marketId, "YES")).prediction!;
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect((await attach(u, pick.id, 1)).outcome).toBe("past_deadline");
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() - 5 * 60_000).toISOString(), internal_status: "LIVE" });
    expect((await attach(u, pick.id, 1)).outcome).toBe("game_started");
    expect(await stakeOf(pick.id)).toBeNull();
    expect(await reserveEntries(u)).toEqual([]);
  });

  it("is allowed on a Pick an accepted Call BS has locked, before T-10: the team stays, both reasons are reported, and the challenge is untouched", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, b, aPick, bPick, challenge } = await pendingPair(marketId);
    const accepted = await accept(challenge.id, b);
    expect(accepted.outcome).toBe("accepted");
    for (const p of [aPick, bPick]) expect((await admin.from("predictions").select("lock_reason, locked_at").eq("id", p.id).single()).data).toMatchObject({ lock_reason: "CHALLENGE_ACCEPTED" });
    expect((await setPick(a, marketId, "NO")).outcome).toBe("rejected_locked");

    const r = await attach(a, aPick.id, 4);
    expect(r.outcome).toBe("attached");
    expect(r.selectedOutcome).toBe("YES");
    const row = (await pickOf(a, marketId))!;
    expect([row.selected_outcome, row.lock_reason]).toEqual(["YES", "CHALLENGE_ACCEPTED"]);
    expect(((await ok("prediction_lock_reasons", { p_prediction_id: aPick.id })) as unknown as string[]).sort()).toEqual(["CHALLENGE_ACCEPTED", "CONFIDENCE_COMMITTED"]);
    expect((await challengeOf(challenge.id)).status).toBe("ACCEPTED");
    expect(await stakeOf(bPick.id)).toBeNull(); // the opponent's Confidence is their own choice: none was transferred or pooled
    expect((await ok("confidence_stake_status", { p_member_id: b, p_prediction_id: bPick.id })).state).toBe("open"); // and they may still add theirs before T-10
  });

  it("the one-step path stays valid with optional Picks on, and completing an open unstaked Pick with the other side cancels its Call BS", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const fresh = await member("fresh");
    const made = await compose(fresh, marketId, "YES", 2);
    expect(made.outcome).toBe("created");
    expect(await stakeOf(made.predictionId)).not.toBeNull();

    const g = await seedGame({});
    const { a, aPick, challenge } = await pendingPair(g.marketId);
    const done = await compose(a, g.marketId, "NO", 1); // a was YES: the other side
    expect(done.outcome).toBe("created");
    expect(done.predictionId).toBe(aPick.id);
    expect(done.cancelledChallengeIds).toEqual([challenge.id]);
    expect((await challengeOf(challenge.id)).expiry_reason).toBe("PICK_CHANGED");
  });
});

describe("changing an editable Pick cancels the Call BS that no longer applies", () => {
  it("one PENDING challenge: EXPIRED / PICK_CHANGED, audited with who, what and which revision; the edit reports its id", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, aPick, challenge } = await pendingPair(marketId);
    const r = await setPick(a, marketId, "NO");
    expect(r.outcome).toBe("updated");
    expect(r.cancelled_challenge_ids).toEqual([challenge.id]);
    const ended = await challengeOf(challenge.id);
    expect([ended.status, ended.expiry_reason]).toEqual(["EXPIRED", "PICK_CHANGED"]);
    const audit = ((await admin.from("audit_logs").select("*").eq("action", "call_bs.pick_changed").eq("entity_id", challenge.id)).data ?? []) as Row[];
    expect(audit.length).toBe(1);
    expect(audit[0].actor_id).toBe(a);
    expect(audit[0].reason).toBe("PICK_CHANGED");
    expect(audit[0].after).toMatchObject({ status: "EXPIRED", expiryReason: "PICK_CHANGED", editedPredictionId: aPick.id, editedMemberId: a, newSelection: "NO", marketId });
    expect(audit[0].before).toMatchObject({ status: "PENDING", previousSelection: "YES" });
    const revision = (await admin.from("prediction_revisions").select("id").eq("prediction_id", aPick.id)).data![0];
    expect(audit[0].after.revisionId).toBe(revision.id);
  });

  it("several PENDING challenges on the one Pick are all cancelled together", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const target = await member("target");
    const targetPick = (await setPick(target, marketId, "NO")).prediction!;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await member(`c${i}`);
      await setPick(c, marketId, "YES");
      const created = await callBs(c, targetPick.id);
      expect(created.error, created.error?.message).toBeNull();
      ids.push((created.data as Row).id);
    }
    const r = await setPick(target, marketId, "YES");
    expect((r.cancelled_challenge_ids ?? []).sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await challengeOf(id)).expiry_reason).toBe("PICK_CHANGED");
  });

  it("no pending challenge, or an unchanged Pick, cancels nothing; the challenger editing their own Pick cancels theirs too", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const lonely = await member();
    await setPick(lonely, marketId, "YES");
    expect((await setPick(lonely, marketId, "NO")).cancelled_challenge_ids ?? []).toEqual([]);

    const g = await seedGame({});
    const { a, aPick, challenge } = await pendingPair(g.marketId);
    expect((await setPick(a, g.marketId, "YES")).outcome).toBe("unchanged");
    expect((await challengeOf(challenge.id)).status).toBe("PENDING"); // an unchanged Pick never cancels

    const g2 = await seedGame({});
    const second = await pendingPair(g2.marketId);
    // the CHALLENGER (a) edits: their outgoing challenge ends as well
    const r = await setPick(second.a, g2.marketId, "NO");
    expect(r.cancelled_challenge_ids).toEqual([second.challenge.id]);
    expect(aPick.id).not.toBe(second.aPick.id);
  });

  it("an ACCEPTED challenge cannot be bypassed: the edit is refused, the Pick and the challenge are unchanged", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, b, challenge } = await pendingPair(marketId);
    await accept(challenge.id, b);
    const r = await setPick(a, marketId, "NO");
    expect(r.outcome).toBe("rejected_locked");
    expect(r.cancelled_challenge_ids ?? []).toEqual([]);
    expect((await pickOf(a, marketId))!.selected_outcome).toBe("YES");
    expect((await challengeOf(challenge.id)).status).toBe("ACCEPTED");
  });

  it("PICK_CHANGED is never counted against a Member as an ignored challenge (TypeScript policy and database policy agree)", async () => {
    expect(expiryCountsAsIgnored("PICK_CHANGED")).toBe(false);
    expect((await ok("challenge_expiry_counts_as_ignored", { p_reason: "PICK_CHANGED" })) as unknown).toBe(false);
    expect(challengeResponseRate({ accepted: 1, declined: 0, ignored: 0 })).toBe(1);
  });

  it("the NEW situation cannot be reached through acceptance: a cancelled challenge answers 'not_pending'", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, b, challenge } = await pendingPair(marketId);
    await setPick(a, marketId, "NO");
    const r = await accept(challenge.id, b);
    expect(r.outcome).toBe("not_pending");
    expect(r.challenge.expiry_reason).toBe("PICK_CHANGED");
  });
});

describe("the cancellation notification", () => {
  const notificationsFor = async (userId: string, challengeId: string) =>
    ((await admin.from("notifications").select("*").eq("user_id", userId).eq("challenge_id", challengeId).eq("type", "CALL_BS_CANCELLED")).data ?? []) as Row[];

  it("goes to the other participant only (never the editor), once — a retry changes nothing", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, b, challenge } = await pendingPair(marketId);
    const edit = await setPick(a, marketId, "NO");
    await notifyPickChangedCancellations(edit.cancelled_challenge_ids ?? [], a);
    await notifyPickChangedCancellations(edit.cancelled_challenge_ids ?? [], a); // a retry
    const toB = await notificationsFor(b, challenge.id);
    expect(toB.length).toBe(1);
    expect(toB[0].body).toContain("Challenge cancelled because the Pick changed");
    expect(toB[0].market_id).toBe(marketId);
    expect(await notificationsFor(a, challenge.id)).toEqual([]);
  });

  it("a delivery that never happened is sent by the reconciliation sweep, exactly once, to the right Member (including when the challenger is the editor, and when the recipient is)", async () => {
    await optionalWorld();
    const g1 = await seedGame({});
    const one = await pendingPair(g1.marketId);
    await setPick(one.a, g1.marketId, "NO"); // challenger edits: owed to b
    const g2 = await seedGame({});
    const two = await pendingPair(g2.marketId);
    await setPick(two.b, g2.marketId, "YES"); // recipient edits: owed to a
    const owed = ((await ok("call_bs_cancellations_awaiting_notification", { p_limit: 50 })) as unknown as Row[]).map((r) => [r.challenge_id, r.notify_user_id]);
    expect(owed).toEqual(expect.arrayContaining([[one.challenge.id, one.b], [two.challenge.id, two.a]]));
    const result = await reconcileChallengeCancellationNotifications();
    expect(result.failed).toBe(0);
    expect(result.delivered).toBeGreaterThanOrEqual(2);
    expect((await notificationsFor(one.b, one.challenge.id)).length).toBe(1);
    expect((await notificationsFor(two.a, two.challenge.id)).length).toBe(1);
    expect(await notificationsFor(one.a, one.challenge.id)).toEqual([]);
    expect(await notificationsFor(two.b, two.challenge.id)).toEqual([]);
    const again = await reconcileChallengeCancellationNotifications();
    expect(again.delivered).toBe(0);
    expect((await notificationsFor(one.b, one.challenge.id)).length).toBe(1);
  });

  it("the database refuses a second notification of that kind for the same challenge and Member (the deduplication is structural)", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, b, challenge } = await pendingPair(marketId);
    await setPick(a, marketId, "NO");
    const row = { user_id: b, type: "CALL_BS_CANCELLED", title: "t", body: "b", challenge_id: challenge.id, market_id: marketId };
    expect((await admin.from("notifications").insert(row)).error).toBeNull();
    expect((await admin.from("notifications").insert(row)).error?.code).toBe("23505");
  });
});

describe("the one timing rule and the lock helper", () => {
  it("pick_action_window answers open / game_started / past_deadline from the one deadline formula, and the sweep and challenge paths agree with it", async () => {
    const open = await seedGame({ startsInMinutes: 60 });
    expect(((await ok("pick_action_window", { p_market_id: open.marketId })) as unknown as Row[])[0]).toMatchObject({ is_open: true, closed_reason: null });
    const late = await seedGame({ startsInMinutes: 5 });
    expect(((await ok("pick_action_window", { p_market_id: late.marketId })) as unknown as Row[])[0]).toMatchObject({ is_open: false, closed_reason: "past_deadline" });
    const started = await seedGame({ startsInMinutes: -1 });
    await setFixture(started.fixtureId, { internal_status: "LIVE" });
    expect(((await ok("pick_action_window", { p_market_id: started.marketId })) as unknown as Row[])[0]).toMatchObject({ is_open: false, closed_reason: "game_started" });
    const start = new Date(Date.now() + 3_600_000).toISOString();
    const [{ d }] = await sql<{ d: Date }>("select public.pick_lock_deadline($1::timestamptz) d", [start]);
    expect(new Date(d).getTime()).toBe(new Date(start).getTime() - 10 * 60_000);
    await setSettings({ pick_lock_minutes_before_kickoff: 20 }); // nothing about T-10 is hard-coded
    const [{ d: d2 }] = await sql<{ d: Date }>("select public.pick_lock_deadline($1::timestamptz) d", [start]);
    expect(new Date(d2).getTime()).toBe(new Date(start).getTime() - 20 * 60_000);
    expect(((await ok("pick_action_window", { p_market_id: late.marketId })) as unknown as Row[])[0].effective_lock_at).toBeTruthy();
  });

  it("the sweep expires a PENDING challenge at T-10 on the shared deadline (reason from the one classifier); no T-5 exists anywhere", async () => {
    await optionalWorld();
    const g = await seedGame({ startsInMinutes: 30 });
    const { challenge } = await pendingPair(g.marketId);
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() + 8 * 60_000).toISOString() });
    const swept = (await admin.rpc("expire_stale_challenges", { p_limit: 50 })).data as Row[];
    expect(swept.map((c) => c.id)).toContain(challenge.id);
    expect((await challengeOf(challenge.id)).status).toBe("EXPIRED");
    const cols = (await sql<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings'")).map((c) => c.column_name);
    // Exactly the two existing prediction timing settings: the one Member deadline (T-10) and the old market-close-relative cutoff. No T-5, no market-lock setting.
    expect(cols.filter((c) => /^(pick|prediction|market|game)_.*(lock|cutoff)/.test(c)).sort()).toEqual(["pick_lock_minutes_before_kickoff", "prediction_cutoff_minutes_before_close"]);
    expect(cols.filter((c) => /(^|_)(t5|five)(_|$)|market_lock/.test(c))).toEqual([]);
  });
});

describe("the Pick's derived state", () => {
  const stateOf = async (userId: string, marketId: string) => ((await ok("pick_state", { p_user_id: userId, p_market_id: marketId })) as unknown as Row[])[0];

  it("NO_PICK → UNSTAKED_EDITABLE → STAKED_LOCKED_CONFIDENCE, with the two sources overlapping when a Call BS is accepted too", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, b, aPick, bPick, challenge } = await pendingPair(marketId);
    const none = await stateOf(await member("nopick"), marketId);
    expect(none).toMatchObject({ state: "NO_PICK", can_change_team: true, can_attach_confidence: false });
    expect(await stateOf(a, marketId)).toMatchObject({ state: "UNSTAKED_EDITABLE", can_change_team: true, can_attach_confidence: true, lock_sources: [] });
    await accept(challenge.id, b);
    expect(await stateOf(b, marketId)).toMatchObject({ state: "LOCKED_CALL_BS", can_change_team: false, can_attach_confidence: true, lock_sources: ["CALL_BS"] });
    await attach(a, aPick.id, 2);
    expect(await stateOf(a, marketId)).toMatchObject({ state: "STAKED_LOCKED_CONFIDENCE", can_change_team: false, can_attach_confidence: false, lock_sources: ["CONFIDENCE", "CALL_BS"] });
    expect(bPick.id).toBeTruthy();
  });

  it("UNSTAKED_LOCKED_T10, GRADED and VOID", async () => {
    await optionalWorld();
    const g = await seedGame({ startsInMinutes: 12 });
    const u = await member();
    await setPick(u, g.marketId, "YES");
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect(await stateOf(u, g.marketId)).toMatchObject({ state: "UNSTAKED_LOCKED_T10", can_change_team: false, can_attach_confidence: false, lock_sources: ["T10"] });
    await sqlReplica("update public.predictions set lifecycle_state = 'GRADED', result = 'CORRECT', resolved_outcome_snapshot = 'YES', graded_at = now() where user_id = $1 and market_id = $2", [u, g.marketId]);
    expect((await stateOf(u, g.marketId)).state).toBe("GRADED");
    await sqlReplica("update public.predictions set result = 'VOID', resolved_outcome_snapshot = null where user_id = $1 and market_id = $2", [u, g.marketId]);
    expect((await stateOf(u, g.marketId)).state).toBe("VOID");
  });

  it("the TypeScript derivation used by the feed gives the same headline state and permissions as the database function", async () => {
    await optionalWorld();
    const { marketId } = await seedGame({});
    const { a, b, aPick, challenge } = await pendingPair(marketId);
    const check = async (userId: string, staked: boolean, accepted: boolean) => {
      const db = await stateOf(userId, marketId);
      const p = (await pickOf(userId, marketId))!;
      const ts = derivePickState({ prediction: { lifecycleState: p.lifecycle_state, result: p.result, lockedAt: p.locked_at, lockReason: p.lock_reason }, staked, acceptedCallBs: accepted, windowOpen: db.is_open });
      expect({ state: ts.state, canChangeTeam: ts.canChangeTeam, canAttachConfidence: ts.canAttachConfidence }).toEqual({ state: db.state, canChangeTeam: db.can_change_team, canAttachConfidence: db.can_attach_confidence });
    };
    await check(a, false, false);
    await accept(challenge.id, b);
    await check(b, false, true);
    await attach(a, aPick.id, 1);
    await check(a, true, true);
    expect(derivePickState({ prediction: null, staked: false, acceptedCallBs: false, windowOpen: true })).toMatchObject({ state: "NO_PICK", canChangeTeam: true });
  });
});

describe("eras, reconciliation and historical rows", () => {
  it("mandatory-era Picks must be backed (a missing stake is reported), optional-era unstaked Picks are valid — and the era split says so", async () => {
    // legacy: an unstaked Pick from before any cutover
    const legacyGame = await seedGame({});
    const legacyUser = await member("legacy");
    await setPick(legacyUser, legacyGame.marketId, "YES");
    await new Promise((r) => setTimeout(r, 30));
    await activateCutover();
    await new Promise((r) => setTimeout(r, 30));
    // mandatory era: a backed Pick, and one defect inserted with triggers off (what the old database refused)
    const mandatoryGame = await seedGame({});
    const backed = await member("backed");
    expect((await compose(backed, mandatoryGame.marketId, "YES", 1)).outcome).toBe("created");
    const defectUser = await member("defect");
    await sqlReplica("insert into public.predictions (user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, market_question_snapshot, market_status_snapshot, idempotency_key) values ($1, $2, 'YES', 0.6, 0.4, 'q', 'ACTIVE', $3)", [defectUser, mandatoryGame.marketId, randomUUID()]);
    const flagged = async () => ((await sql<Row>("select * from public.confidence_reconcile_stakes()")).filter((r) => r.kind === "PICK_WITHOUT_STAKE_AFTER_CUTOVER").map((r) => r.member_id));
    expect(await flagged()).toEqual([defectUser]);

    await new Promise((r) => setTimeout(r, 30));
    await setOptional(true);
    await new Promise((r) => setTimeout(r, 30));
    const optionalGame = await seedGame({});
    const free = await member("free");
    await setPick(free, optionalGame.marketId, "NO");
    const stakedOptional = await member("stk");
    const sp = (await setPick(stakedOptional, optionalGame.marketId, "YES")).prediction!;
    await attach(stakedOptional, sp.id, 2);

    expect(await flagged()).toEqual([defectUser]); // still exactly the mandatory-era defect; the optional-era unstaked Pick is valid
    const cap = (await ok("confidence_prediction_capacity", {})) as unknown as Row;
    expect(cap.optionalPicksEnabled).toBe(true);
    expect(cap.eras.legacy.unstaked).toBeGreaterThanOrEqual(1);
    expect(cap.eras.mandatory).toMatchObject({ picks: 2, unstaked: 1 });
    expect(cap.eras.optional).toMatchObject({ picks: 2, unstaked: 1, staked: 1 });
    expect(cap.mandatorySince).not.toBeNull();
    expect(cap.legacyPicks.total).toBeGreaterThanOrEqual(2); // the old key keeps its old meaning
    // the optional era stays classified after the switch is turned off: nothing is reinterpreted
    await setOptional(false);
    expect(await flagged()).toEqual([defectUser]);
    expect(((await ok("confidence_prediction_capacity", {})) as unknown as Row).eras.optional).toMatchObject({ picks: 2, unstaked: 1, staked: 1 });
  });

  it("historical rows are byte-identical across a full on / activity / off cycle, and the ledger still reconciles", async () => {
    // history: legacy unstaked + accepted challenge, then the mandatory cutover and a backed Pick
    const gH = await seedGame({});
    const hA = await member("ha");
    const hB = await member("hb");
    const hAPick = (await setPick(hA, gH.marketId, "YES")).prediction!;
    const hBPick = (await setPick(hB, gH.marketId, "NO")).prediction!;
    const hc = await callBs(hA, hBPick.id);
    await accept((hc.data as Row).id, hB);
    await activateCutover();
    const gM = await seedGame({});
    const hC = await member("hc");
    await compose(hC, gM.marketId, "YES", 3);
    const snapshot = async () =>
      sql<Row>(
        `select 'p' k, md5(string_agg(p::text, '|' order by p.id)) h from public.predictions p where p.market_id in ($1, $2)
         union all select 'r', md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.prediction_revisions r where r.prediction_id in ($3, $4)
         union all select 's', md5(coalesce(string_agg(s::text, '|' order by s.id), '')) from public.confidence_prediction_stakes s where s.market_id in ($1, $2)
         union all select 'l', md5(coalesce(string_agg(l::text, '|' order by l.id), '')) from public.confidence_ledger_entries l where l.stake_id in (select id from public.confidence_prediction_stakes where market_id in ($1, $2))
         union all select 'c', md5(coalesce(string_agg(c::text, '|' order by c.id), '')) from public.challenges c where c.market_id in ($1, $2)
         union all select 'm', md5(confidence_mandatory_since::text) from public.platform_settings where id = true`,
        [gH.marketId, gM.marketId, hAPick.id, hBPick.id],
      );
    const before = await snapshot();
    // a full cycle: on, new activity on OTHER markets (picks, edits, challenges, cancellations, attaches), off
    await setOptional(true);
    const gN = await seedGame({});
    const { a, aPick } = await pendingPair(gN.marketId);
    await setPick(a, gN.marketId, "NO");
    await attach(a, aPick.id, 2);
    const gN2 = await seedGame({});
    const solo = await member("solo");
    await setPick(solo, gN2.marketId, "YES");
    await setOptional(false);
    expect(await snapshot()).toEqual(before);
    expect(await sql("select * from public.confidence_reconcile_stakes()")).toEqual([]);
  });
});

describe("privileges", () => {
  it("none of the new functions can be called by a visitor or a signed-in Member", async () => {
    const anon = getTestAnonClient();
    const calls: [string, Record<string, unknown>][] = [
      ["admin_set_confidence_optional_picks", { p_admin_id: randomUUID(), p_enabled: true }],
      ["admin_set_confidence_two_step_composer", { p_admin_id: randomUUID(), p_enabled: true }],
      ["lock_market_members", { p_market_id: randomUUID(), p_user_a: randomUUID() }],
      ["pick_action_window", { p_market_id: randomUUID() }],
      ["pick_lock_deadline", { p_scheduled_start: new Date().toISOString() }],
      ["pick_state", { p_user_id: randomUUID(), p_market_id: randomUUID() }],
      ["call_bs_cancellations_awaiting_notification", { p_limit: 5 }],
      ["confidence_attach_stake", { p_member_id: randomUUID(), p_prediction_id: randomUUID(), p_amount: 1, p_idempotency_key: randomUUID() }],
    ];
    for (const [name, args] of calls) {
      const r = await anon.rpc(name, args);
      expect(r.error, name).not.toBeNull();
    }
  });
});
