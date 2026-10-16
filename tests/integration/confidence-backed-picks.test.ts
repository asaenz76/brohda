/**
 * Milestone 4 — Confidence-backed Picks (migration 203) against the real database: attaching Confidence to the Member's own Pick (reserve + lock atomically), the lock matrix, settlement from the canonical grade
 * exactly once (correct = net +N, incorrect = net −N, void = 0), the capability being independent of settlement, the Daily Claim on TOTAL, concurrency, idempotency, privileges and RLS, reconciliation, observability
 * and the one enriched notification. Real local Supabase, real jobs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedPick, seedSponsorAccount, seedUser, setFixture } from "./helpers/game-seed";
import { setPick } from "@/lib/predictions/repository";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rpc = async (name: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await admin.rpc(name, args);
  return { data: data as Row | null, error };
};
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
async function sql<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_daily_claim_amount: 1, confidence_daily_claim_interval_hours: 24, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10 });
});

async function member(label = "bp") {
  const id = await seedUser(label);
  await ok("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
const account = async (id: string) => (await admin.from("confidence_accounts").select("*").eq("member_id", id).maybeSingle()).data as Row;
const entries = async (id: string, type?: string) => {
  let q = admin.from("confidence_ledger_entries").select("*").eq("member_id", id).order("created_at").order("id");
  if (type) q = q.eq("entry_type", type);
  return ((await q).data ?? []) as Row[];
};
const stakeOf = async (predictionId: string) => (await admin.from("confidence_prediction_stakes").select("*").eq("prediction_id", predictionId).maybeSingle()).data as Row | null;
const prediction = async (id: string) => (await admin.from("predictions").select("*").eq("id", id).single()).data as Row;
const attach = (memberId: string, predictionId: string, amount: number, key: string = randomUUID()) => rpc("confidence_attach_stake", { p_member_id: memberId, p_prediction_id: predictionId, p_amount: amount, p_idempotency_key: key });
/** A Member with a pending Pick on a fresh Game that starts tomorrow. */
async function picked(label = "bp", side: "YES" | "NO" = "YES", game: Parameters<typeof seedGame>[0] = {}) {
  const memberId = await member(label);
  const g = await seedGame(game);
  const predictionId = await seedPick(memberId, g.marketId, side);
  return { memberId, predictionId, ...g };
}
const totalOf = (a: Row) => Number(a.available) + Number(a.reserved);
async function grade(fixtureId: string, home: number, away: number) {
  await setFixture(fixtureId, { internal_status: "COMPLETED", home_score: home, away_score: away });
  const summary = await runGradingJob(recordGradedPredictionResult);
  expect(summary.failures).toEqual([]);
}
async function clientFor(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const c = getTestAnonClient();
  const r = await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD });
  expect(r.error).toBeNull();
  return c;
}
async function expectReconciled() {
  expect((await ok("confidence_reconcile")) as unknown).toEqual([]);
  expect((await ok("confidence_reconcile_stakes", { p_grace_minutes: 0 })) as unknown).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("attaching Confidence to a Pick", () => {
  it("reserves the amount and locks the Pick in one step: available −N, reserved +N, total unchanged", async () => {
    const { memberId, predictionId } = await picked("attach");
    const before = await account(memberId);
    const r = await attach(memberId, predictionId, 3);
    expect(r.data).toMatchObject({ outcome: "attached", amount: 3, available: 47, reserved: 3, total: 50 });
    const after = await account(memberId);
    expect([Number(after.available), Number(after.reserved), totalOf(after)]).toEqual([47, 3, totalOf(before)]);
    const reserve = await entries(memberId, "PREDICTION_RESERVE");
    expect(reserve).toHaveLength(1);
    expect([reserve[0].available_delta, reserve[0].reserved_delta]).toEqual([-3, 3]);
    const pick = await prediction(predictionId);
    expect(pick.lock_reason).toBe("CONFIDENCE_COMMITTED");
    expect(pick.locked_at).not.toBeNull();
    expect(await stakeOf(predictionId)).toMatchObject({ amount: 3, state: "RESERVED", member_id: memberId, selected_outcome: "YES" });
    await expectReconciled();
  });

  it("is idempotent: a retry of the same request returns the first result and reserves nothing more", async () => {
    const { memberId, predictionId } = await picked("idem");
    const key = randomUUID();
    expect((await attach(memberId, predictionId, 2, key)).data).toMatchObject({ outcome: "attached" });
    expect((await attach(memberId, predictionId, 2, key)).data).toMatchObject({ outcome: "attached", replay: true });
    expect(await entries(memberId, "PREDICTION_RESERVE")).toHaveLength(1);
    expect(Number((await account(memberId)).reserved)).toBe(2);
    // The same key for a different Pick is a conflict, never a second reserve.
    const g2 = await seedGame();
    const second = await seedPick(memberId, g2.marketId, "NO");
    expect((await attach(memberId, second, 2, key)).data?.outcome).toBe("idempotency_conflict");
    expect(await stakeOf(second)).toBeNull();
  });

  it("a Pick can be backed once, ever: a second attach (even with a different amount or key) is refused", async () => {
    const { memberId, predictionId } = await picked("once");
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("attached");
    expect((await attach(memberId, predictionId, 4)).data?.outcome).toBe("already_backed");
    expect(await entries(memberId, "PREDICTION_RESERVE")).toHaveLength(1);
    expect(Number((await stakeOf(predictionId))!.amount)).toBe(1);
  });

  it("refuses an amount that is not on the configured ladder, zero and negative amounts", async () => {
    const { memberId, predictionId } = await picked("ladder");
    for (const amount of [0, -1, 6, 50]) expect((await attach(memberId, predictionId, amount)).data?.outcome, String(amount)).toBe("invalid_amount");
    await setSettings({ confidence_allowed_stakes: [2, 5, 10] });
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("invalid_amount");
    expect((await attach(memberId, predictionId, 10)).data?.outcome).toBe("attached");
  });

  it("is refused when the capability is off — either flag — and for someone else's Pick", async () => {
    const { memberId, predictionId } = await picked("gates");
    await setSettings({ confidence_backed_picks_enabled: false });
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("disabled");
    await setSettings({ confidence_backed_picks_enabled: true, confidence_enabled: false });
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("disabled");
    await setSettings({ confidence_enabled: true });
    const other = await member("gates-other");
    expect((await attach(other, predictionId, 1)).data?.outcome).toBe("not_found");
    expect(await stakeOf(predictionId)).toBeNull();
    expect(Number((await account(memberId)).reserved)).toBe(0);
  });

  it("a Sponsor has no Confidence and cannot back anything", async () => {
    const { predictionId } = await picked("sponsor-target");
    const sponsor = await seedSponsorAccount("bp-sponsor");
    const r = await attach(sponsor.userId, predictionId, 1);
    expect(["ineligible", "not_found"]).toContain(r.data?.outcome);
    expect(await stakeOf(predictionId)).toBeNull();
    expect((await admin.from("confidence_accounts").select("member_id").eq("member_id", sponsor.userId)).data).toHaveLength(0);
  });

  it("reserved Confidence cannot be spent twice: only AVAILABLE counts", async () => {
    const memberId = await member("avail");
    await admin.rpc("admin_confidence_adjust", { p_admin_id: await adminId(), p_member_id: memberId, p_amount: -47, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() });
    expect(Number((await account(memberId)).available)).toBe(3);
    const a = await seedGame();
    const b = await seedGame();
    const pa = await seedPick(memberId, a.marketId, "YES");
    const pb = await seedPick(memberId, b.marketId, "YES");
    expect((await attach(memberId, pa, 2)).data?.outcome).toBe("attached");
    const r = await attach(memberId, pb, 2);
    expect(r.data).toMatchObject({ outcome: "insufficient", available: 1 });
    expect(await stakeOf(pb)).toBeNull();
    expect((await attach(memberId, pb, 1)).data?.outcome).toBe("attached");
    expect(Number((await account(memberId)).available)).toBe(0);
    await expectReconciled();
  });

  it("several Picks hold several independent stakes; the account's reserved is exactly their sum", async () => {
    const memberId = await member("multi");
    const preds: string[] = [];
    for (const amount of [1, 2, 5]) {
      const g = await seedGame();
      const p = await seedPick(memberId, g.marketId, "YES");
      expect((await attach(memberId, p, amount)).data?.outcome).toBe("attached");
      preds.push(p);
    }
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved)]).toEqual([42, 8]);
    await expectReconciled();
  });
});

let staffId: string | null = null;
async function adminId() {
  if (!staffId) {
    staffId = await seedUser("bp-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
}
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the canonical deadline and the lock matrix", () => {
  it("is refused once the Pick's deadline has passed, and once the Game has started", async () => {
    const { memberId, predictionId, fixtureId } = await picked("deadline", "YES", { startsInMinutes: 60 });
    await setFixture(fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }); // inside the 10-minute lock
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("past_deadline");
    expect(Number((await account(memberId)).reserved)).toBe(0);

    const live = await picked("started", "YES", { startsInMinutes: 60 });
    await setFixture(live.fixtureId, { internal_status: "LIVE" });
    expect((await attach(live.memberId, live.predictionId, 1)).data?.outcome).toBe("game_started");
  });

  it("follows the configured lock window: widening it closes a Pick that was open", async () => {
    const { memberId, predictionId } = await picked("window", "YES", { startsInMinutes: 30 });
    await setSettings({ pick_lock_minutes_before_kickoff: 45 });
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("past_deadline");
    await setSettings({ pick_lock_minutes_before_kickoff: 10 });
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("attached");
  });

  it("is refused for a graded Pick", async () => {
    const { memberId, predictionId, fixtureId } = await picked("graded");
    await grade(fixtureId, 1, 0);
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("pick_graded");
  });

  it("a backed Pick is immutable: set_pick refuses an edit, and a direct side change is refused by the database", async () => {
    const { memberId, predictionId, marketId } = await picked("immutable", "YES");
    await attach(memberId, predictionId, 2);
    const edit = await setPick({ userId: memberId, marketId, selectedOutcome: "NO", yesProbability: 0.6, noProbability: 0.4, marketQuestionSnapshot: "q", marketCloseAtSnapshot: null, marketStatusSnapshot: "ACTIVE", idempotencyKey: randomUUID() });
    expect(edit.outcome).toBe("rejected_locked");
    expect(edit.prediction!.selectedOutcome).toBe("YES");
    expect((await admin.from("predictions").update({ selected_outcome: "NO" }).eq("id", predictionId)).error).not.toBeNull();
    expect((await prediction(predictionId)).selected_outcome).toBe("YES");
  });

  it("the stake itself is immutable: no update of the amount or side, no delete, no direct insert of a settled one", async () => {
    const { memberId, predictionId } = await picked("stake-immutable");
    await attach(memberId, predictionId, 2);
    const stake = (await stakeOf(predictionId))!;
    expect((await admin.from("confidence_prediction_stakes").update({ amount: 5 }).eq("id", stake.id)).error).not.toBeNull();
    expect((await admin.from("confidence_prediction_stakes").update({ selected_outcome: "NO" }).eq("id", stake.id)).error).not.toBeNull();
    expect((await admin.from("confidence_prediction_stakes").delete().eq("id", stake.id)).error).not.toBeNull();
    expect((await stakeOf(predictionId))).toMatchObject({ amount: 2, selected_outcome: "YES" });
  });

  it("an existing lock reason is kept: a Pick already locked by an accepted Call BS can still be backed, and stays CHALLENGE_ACCEPTED", async () => {
    const { memberId, predictionId } = await picked("callbs-lock");
    await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CHALLENGE_ACCEPTED" }).eq("id", predictionId);
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("attached");
    expect((await prediction(predictionId)).lock_reason).toBe("CHALLENGE_ACCEPTED");
    expect(await ok("prediction_lock_reasons", { p_prediction_id: predictionId }) as unknown).toEqual(["CHALLENGE_ACCEPTED", "CONFIDENCE_COMMITTED"]);
  });

  it("a Pick already locked by the cutoff cannot be backed", async () => {
    const { memberId, predictionId } = await picked("cutoff-lock");
    await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CUTOFF" }).eq("id", predictionId);
    expect((await attach(memberId, predictionId, 1)).data?.outcome).toBe("past_deadline");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("settlement from the canonical grade", () => {
  it("a correct Pick returns the stake and issues the same amount again: net +N, exactly once", async () => {
    const { memberId, predictionId, fixtureId } = await picked("win", "YES");
    await attach(memberId, predictionId, 4);
    await grade(fixtureId, 7, 3); // home wins; YES = HOME
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved)]).toEqual([54, 0]);
    const win = await entries(memberId, "PREDICTION_WIN");
    expect(win).toHaveLength(1);
    expect([win[0].available_delta, win[0].reserved_delta]).toEqual([8, -4]);
    expect(await stakeOf(predictionId)).toMatchObject({ state: "SETTLED_CORRECT", result: "CORRECT" });
    await expectReconciled();
  });

  it("an incorrect Pick burns the stake: net −N, nothing returned", async () => {
    const { memberId, predictionId, fixtureId } = await picked("loss", "NO");
    await attach(memberId, predictionId, 5);
    await grade(fixtureId, 7, 3); // NO but home won
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved)]).toEqual([45, 0]);
    const loss = await entries(memberId, "PREDICTION_LOSS");
    expect(loss).toHaveLength(1);
    expect([loss[0].available_delta, loss[0].reserved_delta]).toEqual([0, -5]);
    expect(await stakeOf(predictionId)).toMatchObject({ state: "SETTLED_INCORRECT", result: "INCORRECT" });
    await expectReconciled();
  });

  it("a void Pick (a tied Moneyline) returns the stake untouched: net 0", async () => {
    const { memberId, predictionId, fixtureId } = await picked("void", "YES");
    await attach(memberId, predictionId, 3);
    await grade(fixtureId, 4, 4);
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved)]).toEqual([50, 0]);
    const release = await entries(memberId, "PREDICTION_RELEASE");
    expect(release).toHaveLength(1);
    expect([release[0].available_delta, release[0].reserved_delta]).toEqual([3, -3]);
    expect(await stakeOf(predictionId)).toMatchObject({ state: "SETTLED_VOID", result: "VOID" });
    await expectReconciled();
  });

  it("settles on the amount committed, whatever the ladder becomes afterwards; there are no fees and no odds", async () => {
    const { memberId, predictionId, fixtureId } = await picked("snapshot", "YES");
    await attach(memberId, predictionId, 5);
    await setSettings({ confidence_allowed_stakes: [1, 2] });
    await grade(fixtureId, 2, 0);
    expect(Number((await account(memberId)).available)).toBe(55); // 45 + 10, 1:1 exactly
    expect(Number((await stakeOf(predictionId))!.amount)).toBe(5);
  });

  it("settlement does not depend on the capability: with both flags OFF a reserved stake still settles", async () => {
    const { memberId, predictionId, fixtureId } = await picked("off-settles", "YES");
    await attach(memberId, predictionId, 2);
    await setSettings({ confidence_backed_picks_enabled: false, confidence_enabled: false });
    await grade(fixtureId, 1, 0);
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved)]).toEqual([52, 0]);
    expect((await stakeOf(predictionId))!.state).toBe("SETTLED_CORRECT");
  });

  it("settles exactly once: re-running settlement or the sweep changes nothing", async () => {
    const { memberId, predictionId, fixtureId } = await picked("once-only", "YES");
    await attach(memberId, predictionId, 2);
    await grade(fixtureId, 1, 0);
    expect((await ok("confidence_settle_prediction", { p_prediction_id: predictionId })).outcome).toBe("already_settled");
    expect((await ok("confidence_settle_pending", { p_limit: 100 })).settled).toBe(0);
    await runGradingJob(recordGradedPredictionResult);
    expect(await entries(memberId, "PREDICTION_WIN")).toHaveLength(1);
    expect(Number((await account(memberId)).available)).toBe(52);
    // And the database refuses a second settlement entry even when asked directly.
    const stake = (await stakeOf(predictionId))!;
    const dup = await admin.from("confidence_ledger_entries").insert({ member_id: memberId, entry_type: "PREDICTION_LOSS", available_delta: 0, reserved_delta: 0, stake_id: stake.id, idempotency_key: randomUUID() });
    expect(dup.error).not.toBeNull();
  });

  it("a Pick that is still pending never settles, and an unbacked Pick has nothing to settle", async () => {
    const { memberId, predictionId } = await picked("pending");
    await attach(memberId, predictionId, 2);
    expect((await ok("confidence_settle_prediction", { p_prediction_id: predictionId })).outcome).toBe("not_graded");
    expect((await ok("confidence_settle_prediction", { p_prediction_id: randomUUID() })).outcome).toBe("no_stake");
    expect((await stakeOf(predictionId))!.state).toBe("RESERVED");
  });

  it("the ledger conserves: total supply moves only by +N on a win and −N on a loss, and every account reconciles", async () => {
    const supply = async () => Number((await sql<Row>("select coalesce(sum(available + reserved), 0)::int as s from public.confidence_accounts"))[0].s);
    const a = await picked("sup-a", "YES");
    const b = await picked("sup-b", "NO");
    const c = await picked("sup-c", "YES");
    await attach(a.memberId, a.predictionId, 3);
    await attach(b.memberId, b.predictionId, 2);
    await attach(c.memberId, c.predictionId, 5);
    const midSupply = await supply();
    await grade(a.fixtureId, 1, 0); // correct: +3
    await grade(b.fixtureId, 1, 0); // incorrect: −2
    await grade(c.fixtureId, 2, 2); // void: 0
    expect(await supply()).toBe(midSupply + 3 - 2);
    await expectReconciled();
  });

  it("settlement failure is contained and retry-safe: the grade still lands, and the sweep settles later", async () => {
    const { memberId, predictionId, fixtureId } = await picked("sweep", "YES");
    await attach(memberId, predictionId, 2);
    // Grade WITHOUT the settlement trigger (as if settlement had failed inside the transaction), then restore it.
    await sql("alter table public.predictions disable trigger predictions_confidence_settle");
    try {
      await setFixture(fixtureId, { internal_status: "COMPLETED", home_score: 1, away_score: 0 });
      await runGradingJob(recordGradedPredictionResult);
    } finally {
      await sql("alter table public.predictions enable trigger predictions_confidence_settle");
    }
    expect((await prediction(predictionId)).lifecycle_state).toBe("GRADED");
    expect((await stakeOf(predictionId))!.state).toBe("RESERVED");
    // Reconciliation sees a stranded reserve (grace 0) …
    const stranded = (await ok("confidence_reconcile_stakes", { p_grace_minutes: 0 })) as unknown as Row[];
    expect(stranded.map((r) => r.kind)).toContain("STRANDED_RESERVE");
    // … and the sweep settles it, once.
    expect((await ok("confidence_settle_pending", { p_limit: 100 })).settled).toBe(1);
    expect((await ok("confidence_settle_pending", { p_limit: 100 })).settled).toBe(0);
    expect(Number((await account(memberId)).available)).toBe(52);
    await expectReconciled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("concurrency", () => {
  it("simultaneous attaches to the same Pick create exactly one stake and one reserve", async () => {
    const { memberId, predictionId } = await picked("race-same");
    const results = await Promise.all([1, 2, 3, 4, 5, 1, 2, 3].map((n) => attach(memberId, predictionId, n)));
    const outcomes = results.map((r) => r.data?.outcome);
    expect(outcomes.filter((o) => o === "attached")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_backed")).toHaveLength(outcomes.length - 1);
    expect(await entries(memberId, "PREDICTION_RESERVE")).toHaveLength(1);
    const a = await account(memberId);
    expect(Number(a.reserved)).toBe(Number((await stakeOf(predictionId))!.amount));
    await expectReconciled();
  });

  it("the same request retried concurrently reserves once and returns the same result to every caller", async () => {
    const { memberId, predictionId } = await picked("race-key");
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => attach(memberId, predictionId, 3, key)));
    for (const r of results) expect(r.data?.outcome).toBe("attached");
    expect(await entries(memberId, "PREDICTION_RESERVE")).toHaveLength(1);
    expect(Number((await account(memberId)).reserved)).toBe(3);
  });

  it("two Picks racing for the last available Confidence: exactly one wins and nothing goes negative", async () => {
    const memberId = await member("race-two");
    await ok("admin_confidence_adjust", { p_admin_id: await adminId(), p_member_id: memberId, p_amount: -47, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() });
    const preds: string[] = [];
    for (let i = 0; i < 4; i++) preds.push(await seedPick(memberId, (await seedGame()).marketId, "YES"));
    const results = await Promise.all(preds.map((p) => attach(memberId, p, 3)));
    expect(results.filter((r) => r.data?.outcome === "attached")).toHaveLength(1);
    expect(results.filter((r) => r.data?.outcome === "insufficient")).toHaveLength(3);
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved)]).toEqual([0, 3]);
    await expectReconciled();
  });

  it("an edit racing an attach: either the edit wins and the stake describes the new side, or the attach wins and the edit is refused — never a mismatch", async () => {
    for (let i = 0; i < 6; i++) {
      const { memberId, predictionId, marketId } = await picked(`race-edit-${i}`, "YES");
      const [edit, att] = await Promise.all([
        setPick({ userId: memberId, marketId, selectedOutcome: "NO", yesProbability: 0.6, noProbability: 0.4, marketQuestionSnapshot: "q", marketCloseAtSnapshot: null, marketStatusSnapshot: "ACTIVE", idempotencyKey: randomUUID() }),
        attach(memberId, predictionId, 2),
      ]);
      expect(att.data?.outcome).toBe("attached");
      const pick = await prediction(predictionId);
      const stake = (await stakeOf(predictionId))!;
      expect(stake.selected_outcome).toBe(pick.selected_outcome);
      if (edit.outcome === "rejected_locked") expect(pick.selected_outcome).toBe("YES");
    }
  });

  it("an attach racing the deadline is decided by the instant it runs: a Pick is either backed before the lock or refused, never half-done", async () => {
    const { memberId, predictionId, fixtureId } = await picked("race-deadline", "YES", { startsInMinutes: 60 });
    // 11 minutes out is still open; move the kickoff so the lock moment (10 minutes before) is about a second away.
    await setFixture(fixtureId, { scheduled_start_utc: new Date(Date.now() + 10 * 60_000 + 1500).toISOString() });
    const results = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i * 250));
      return attach(memberId, predictionId, 1);
    }));
    const attached = results.filter((r) => r.data?.outcome === "attached");
    const refused = results.filter((r) => r.data?.outcome === "past_deadline");
    expect(attached.length).toBeLessThanOrEqual(1);
    expect(attached.length + refused.length + results.filter((r) => r.data?.outcome === "already_backed").length).toBe(12);
    expect(await entries(memberId, "PREDICTION_RESERVE")).toHaveLength(attached.length);
    await expectReconciled();
  });

  it("grading and the sweep running together settle each stake exactly once", async () => {
    const picks = [];
    for (let i = 0; i < 4; i++) {
      const p = await picked(`race-grade-${i}`, "YES");
      await attach(p.memberId, p.predictionId, 2);
      picks.push(p);
    }
    for (const p of picks) await setFixture(p.fixtureId, { internal_status: "COMPLETED", home_score: 1, away_score: 0 });
    await Promise.all([runGradingJob(recordGradedPredictionResult), ok("confidence_settle_pending", {}), ok("confidence_settle_pending", {}), runGradingJob(recordGradedPredictionResult)]);
    await ok("confidence_settle_pending", {});
    for (const p of picks) {
      expect(await entries(p.memberId, "PREDICTION_WIN")).toHaveLength(1);
      expect(Number((await account(p.memberId)).available)).toBe(52);
    }
    await expectReconciled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the Daily Claim counts total Confidence", () => {
  const claim = (id: string) => rpc("confidence_daily_claim", { p_member_id: id, p_idempotency_key: randomUUID() });
  async function with45And5(label: string) {
    const memberId = await member(label);
    const p = await seedPick(memberId, (await seedGame()).marketId, "YES");
    expect((await attach(memberId, p, 5)).data?.outcome).toBe("attached");
    return memberId;
  }

  it("45 available + 5 reserved is 50 in total: at the baseline, so there is nothing to claim", async () => {
    const memberId = await with45And5("claim-45-5");
    expect((await claim(memberId)).data?.outcome).toBe("at_or_above_baseline");
    expect(await entries(memberId, "DAILY_CLAIM")).toHaveLength(0);
  });

  it("44 available + 5 reserved is 49: claimable, credited to AVAILABLE", async () => {
    const memberId = await with45And5("claim-44-5");
    await ok("admin_confidence_adjust", { p_admin_id: await adminId(), p_member_id: memberId, p_amount: -1, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() });
    const r = await claim(memberId);
    expect(r.data).toMatchObject({ outcome: "claimed", amount: 1 });
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved)]).toEqual([45, 5]);
  });

  it("the cap is on total: with 42 + 5 and a claim of 5, only 3 is credited", async () => {
    await setSettings({ confidence_daily_claim_amount: 5 });
    const memberId = await with45And5("claim-42-5");
    await ok("admin_confidence_adjust", { p_admin_id: await adminId(), p_member_id: memberId, p_amount: -3, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() });
    const r = await claim(memberId);
    expect(r.data).toMatchObject({ outcome: "claimed", amount: 3 });
    const a = await account(memberId);
    expect([Number(a.available), Number(a.reserved), totalOf(a)]).toEqual([45, 5, 50]);
  });

  it("reserving Confidence never creates claim eligibility, and losing it does", async () => {
    const memberId = await member("claim-lose");
    const p = await seedPick(memberId, (await seedGame()).marketId, "NO");
    await attach(memberId, p, 5);
    expect((await claim(memberId)).data?.outcome).toBe("at_or_above_baseline"); // 45 + 5 = 50 total
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("privileges and row-level security", () => {
  it("Members, the public and Sponsors cannot call any of the new functions", async () => {
    const { memberId, predictionId } = await picked("rpc-priv");
    const sponsor = await seedSponsorAccount("bp-priv");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["confidence_attach_stake", { p_member_id: memberId, p_prediction_id: predictionId, p_amount: 1, p_idempotency_key: randomUUID() }],
      ["confidence_stake_status", { p_member_id: memberId, p_prediction_id: predictionId }],
      ["confidence_settle_prediction", { p_prediction_id: predictionId }],
      ["confidence_settle_pending", { p_limit: 10 }],
      ["confidence_reconcile_stakes", { p_grace_minutes: 0 }],
      ["prediction_lock_reasons", { p_prediction_id: predictionId }],
      ["pick_market_timing", { p_market_id: randomUUID() }],
    ];
    for (const client of [await clientFor(memberId), getTestAnonClient(), await clientFor(sponsor.userId)]) {
      for (const [name, args] of calls) expect((await client.rpc(name, args)).error, name).not.toBeNull();
    }
    expect(await stakeOf(predictionId)).toBeNull();
    for (const fn of ["confidence_settle_on_grade", "confidence_stakes_guard", "predictions_confidence_stake_guard"]) {
      const rows = await sql<Row>(`select has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [fn]);
      expect(rows[0], fn).toEqual({ a: false, u: false, s: false });
    }
  });

  it("a Member reads only their own stakes, with no ledger snapshot columns, and cannot write the table", async () => {
    const a = await picked("rls-a");
    const b = await picked("rls-b");
    await attach(a.memberId, a.predictionId, 2);
    await attach(b.memberId, b.predictionId, 3);
    const client = await clientFor(a.memberId);
    const own = await client.from("confidence_prediction_stakes").select("id, member_id, amount, state");
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);
    expect(own.data![0]).toMatchObject({ member_id: a.memberId, amount: 2 });
    expect((await client.from("confidence_prediction_stakes").select("allowed_stakes_snapshot")).error).not.toBeNull();
    expect((await client.from("confidence_prediction_stakes").insert({ member_id: a.memberId, prediction_id: b.predictionId, market_id: b.marketId, fixture_id: b.fixtureId, selected_outcome: "YES", amount: 1, allowed_stakes_snapshot: [1] })).error).not.toBeNull();
    expect((await client.from("confidence_prediction_stakes").update({ amount: 5 }).eq("member_id", a.memberId)).data ?? []).toHaveLength(0);
    expect((await client.from("confidence_prediction_stakes").delete().eq("member_id", a.memberId)).data ?? []).toHaveLength(0);
    expect(Number((await stakeOf(a.predictionId))!.amount)).toBe(2);
    // The public sees nothing, and neither does anyone while Confidence is off.
    expect((await getTestAnonClient().from("confidence_prediction_stakes").select("id")).data ?? []).toHaveLength(0);
    await setSettings({ confidence_enabled: false });
    expect((await client.from("confidence_prediction_stakes").select("id")).data ?? []).toHaveLength(0);
  });

  it("a Sponsor session reads no stakes", async () => {
    const { memberId, predictionId } = await picked("rls-sponsor");
    await attach(memberId, predictionId, 1);
    const sponsor = await seedSponsorAccount("bp-rls");
    expect(((await (await clientFor(sponsor.userId)).from("confidence_prediction_stakes").select("id")).data ?? [])).toHaveLength(0);
  });

  it("the ledger shape is enforced: prediction entries need a stake and the right sign pattern", async () => {
    const { memberId, predictionId } = await picked("shape");
    await attach(memberId, predictionId, 2);
    const stake = (await stakeOf(predictionId))!;
    const bad = [
      { entry_type: "PREDICTION_WIN", available_delta: 1, reserved_delta: 0, stake_id: null },
      { entry_type: "PREDICTION_WIN", available_delta: 3, reserved_delta: -2, stake_id: stake.id }, // not 2N
      { entry_type: "PREDICTION_RESERVE", available_delta: -2, reserved_delta: 1, stake_id: stake.id },
      { entry_type: "DAILY_CLAIM", available_delta: 1, reserved_delta: 0, stake_id: stake.id },
    ];
    for (const row of bad) expect((await admin.from("confidence_ledger_entries").insert({ member_id: memberId, idempotency_key: randomUUID(), ...row })).error, JSON.stringify(row)).not.toBeNull();
    const cols = Object.keys(((await admin.from("confidence_ledger_entries").select("*").limit(1)).data ?? [{}])[0] ?? {});
    expect(cols.some((c) => /odds|fee|payout|price|currency|cash|wallet|redeem/i.test(c))).toBe(false);
    const stakeCols = Object.keys(stake);
    expect(stakeCols.some((c) => /odds|fee|payout|price|currency|cash|wallet|redeem/i.test(c))).toBe(false);
  });

  it("an admin cannot reverse a prediction entry by hand: settlement is the only way a stake resolves", async () => {
    const { memberId, predictionId } = await picked("admin-reverse");
    await attach(memberId, predictionId, 2);
    const reserve = (await entries(memberId, "PREDICTION_RESERVE"))[0];
    const r = await rpc("admin_confidence_reverse", { p_admin_id: await adminId(), p_entry_id: reserve.id, p_note: "should be refused", p_idempotency_key: randomUUID() });
    expect(r.data?.outcome).toBe("prediction_entry");
    expect(Number((await account(memberId)).reserved)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("reconciliation and observability", () => {
  it("reserved on an account must equal its active stakes: a drifted account is reported", async () => {
    const { memberId, predictionId } = await picked("drift");
    await attach(memberId, predictionId, 2);
    expect((await ok("confidence_reconcile")) as unknown).toEqual([]);
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('brohda.confidence_ledger', 'on', true)");
      await client.query("update public.confidence_accounts set reserved = reserved + 1, available = available - 1 where member_id = $1", [memberId]);
      await client.query("commit");
    } finally {
      await client.end();
    }
    const found = (await ok("confidence_reconcile")) as unknown as Row[];
    expect(found.some((r) => r.member_id === memberId)).toBe(true);
    // Put the account back (same documented session switch) so the deliberate drift does not leak into other tests.
    const fix = new Client({ connectionString: getTestDatabaseUrl() });
    await fix.connect();
    try {
      await fix.query("begin");
      await fix.query("select set_config('brohda.confidence_ledger', 'on', true)");
      await fix.query("update public.confidence_accounts set reserved = reserved - 1, available = available + 1 where member_id = $1", [memberId]);
      await fix.query("commit");
    } finally {
      await fix.end();
    }
    expect((await ok("confidence_reconcile")) as unknown).toEqual([]);
  });

  it("the economy overview reports active and settled backed Picks, winnings, burns, voids, by-amount and net change", async () => {
    const base = (await ok("confidence_economy_overview")).predictions as Row;
    const baseNet = (await ok("confidence_economy_overview")).netChange.days7 as number;
    const win = await picked("ov-win", "YES");
    const loss = await picked("ov-loss", "NO");
    const open = await picked("ov-open", "YES");
    const tie = await picked("ov-tie", "YES");
    await attach(win.memberId, win.predictionId, 4);
    await attach(loss.memberId, loss.predictionId, 2);
    await attach(open.memberId, open.predictionId, 4);
    await attach(tie.memberId, tie.predictionId, 3);
    await grade(win.fixtureId, 1, 0);
    await grade(loss.fixtureId, 1, 0);
    await grade(tie.fixtureId, 2, 2);
    const o = await ok("confidence_economy_overview");
    const p = o.predictions as Row;
    expect({
      active: p.activeBackedPicks - base.activeBackedPicks,
      reserved: p.reserved - base.reserved,
      backed: p.backedPicks - base.backedPicks,
      committed: p.totalCommitted - base.totalCommitted,
      winnings: p.winningsIssued - base.winningsIssued,
      burned: p.lossesBurned - base.lossesBurned,
      voids: p.voidReleases - base.voidReleases,
    }).toEqual({ active: 1, reserved: 4, backed: 4, committed: 13, winnings: 4, burned: 2, voids: 3 });
    expect(Number(p.byAmount["4"]) - Number(base.byAmount["4"] ?? 0)).toBe(2);
    expect(o.netChange.days7 - baseNet).toBe(4 * 50 + 4 - 2); // four initial grants, +4 won, −2 burned, void 0, reserves net 0
    expect(o.reserved).toBe(p.reserved);
    expect(o.reconciliationMismatches).toBe(0);
    // Nothing private: aggregates only, no Member ids anywhere in the overview.
    expect(JSON.stringify(o)).not.toContain(win.memberId);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the graded notification", () => {
  const notes = async (userId: string) => ((await admin.from("notifications").select("type, title, body").eq("user_id", userId).eq("type", "prediction_graded")).data ?? []) as Row[];

  it("a backed Pick's ONE graded notification carries the configured Confidence sentence; an unbacked Pick's is unchanged", async () => {
    const backed = await picked("note-backed", "YES");
    const plain = await picked("note-plain", "YES");
    await attach(backed.memberId, backed.predictionId, 3);
    await setFixture(backed.fixtureId, { internal_status: "COMPLETED", home_score: 1, away_score: 0 });
    await setFixture(plain.fixtureId, { internal_status: "COMPLETED", home_score: 1, away_score: 0 });
    await runGradingJob(recordGradedPredictionResult);
    const a = await notes(backed.memberId);
    const b = await notes(plain.memberId);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].body).toContain("+3🔥 Confidence.");
    expect(b[0].body).not.toMatch(/Confidence/);
    expect(a[0].body.startsWith(b[0].body)).toBe(true);
  });

  it("the wording is configuration, per result, with {{amount}} substituted", async () => {
    await setSettings({ confidence_notify_incorrect: "You lost {{amount}} Confidence.", confidence_notify_void: "{{amount}} Confidence came back." });
    const lost = await picked("note-lost", "NO");
    const tied = await picked("note-tied", "YES");
    await attach(lost.memberId, lost.predictionId, 2);
    await attach(tied.memberId, tied.predictionId, 5);
    await setFixture(lost.fixtureId, { internal_status: "COMPLETED", home_score: 2, away_score: 0 });
    await setFixture(tied.fixtureId, { internal_status: "COMPLETED", home_score: 1, away_score: 1 });
    await runGradingJob(recordGradedPredictionResult);
    expect((await notes(lost.memberId))[0].body).toContain("You lost 2 Confidence.");
    expect((await notes(tied.memberId))[0].body).toContain("5 Confidence came back.");
  });

  it("a settlement that happens with the capability OFF is still reported", async () => {
    const { memberId, predictionId, fixtureId } = await picked("note-off", "YES");
    await attach(memberId, predictionId, 1);
    await setSettings({ confidence_backed_picks_enabled: false, confidence_enabled: false });
    await grade(fixtureId, 1, 0);
    expect((await stakeOf(predictionId))!.state).toBe("SETTLED_CORRECT");
    expect((await notes(memberId))).toHaveLength(1);
  });
});

describe("configuration of the capability and the copy", () => {
  it("the new capability defaults OFF, is separate from confidence_enabled, and the copy has sensible defaults", async () => {
    const defaults = await sql<Row>(`select column_name, column_default from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name in ('confidence_backed_picks_enabled','confidence_notify_correct','confidence_notify_incorrect','confidence_notify_void') order by 1`);
    expect(defaults).toHaveLength(4);
    expect(defaults.find((d) => d.column_name === "confidence_backed_picks_enabled")!.column_default).toBe("false");
  });

  it("only a Super Admin changes it, through the audited function, and invalid copy is refused as a whole", async () => {
    const sa = await adminId();
    const regular = await seedUser("bp-regular");
    const base = { confidence_enabled: true, confidence_backed_picks_enabled: true };
    expect((await rpc("admin_set_confidence_config", { p_admin_id: regular, p_config: base })).error).not.toBeNull();
    expect((await rpc("admin_set_confidence_config", { p_admin_id: sa, p_config: { ...base, confidence_notify_correct: "" } })).error).not.toBeNull();
    expect((await rpc("admin_set_confidence_config", { p_admin_id: sa, p_config: { ...base, confidence_notify_correct: "x".repeat(201) } })).error).not.toBeNull();
    expect((await rpc("admin_set_confidence_config", { p_admin_id: sa, p_config: { ...base, confidence_backed_picks_enabled: false, nope: 1 } })).error).not.toBeNull();
    expect(await ok("admin_set_confidence_config", { p_admin_id: sa, p_config: { ...base, confidence_backed_picks_enabled: false, confidence_notify_correct: "Won {{amount}}." } }) as unknown).toBeTruthy();
    const s = (await admin.from("platform_settings").select("confidence_backed_picks_enabled, confidence_notify_correct").eq("id", true).single()).data as Row;
    expect(s).toEqual({ confidence_backed_picks_enabled: false, confidence_notify_correct: "Won {{amount}}." });
    const audited = await admin.from("audit_logs").select("id").eq("actor_id", sa).eq("action", "settings.confidence_updated");
    expect((audited.data ?? []).length).toBeGreaterThan(0);
  });
});
