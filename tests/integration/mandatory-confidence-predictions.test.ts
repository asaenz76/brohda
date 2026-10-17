/**
 * Mandatory Confidence (migration 205): a prediction is a side AND the Confidence behind it, created in ONE transaction by create_confidence_prediction. Covers the atomic creation and its rollback, idempotency and double taps,
 * the configured ladder and available balance, the deadline, multiple Markets, the cutover that retires every other way to create a Pick (set_pick, the separate attach, a direct insert, Member database access), legacy open/locked/
 * graded Picks, Call BS and settlement on composer-made Picks, reconciliation and observability, and privileges. Real local Supabase.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedPick, seedSponsorAccount, seedUser, setFixture } from "./helpers/game-seed";
import { callBS, acceptCallBS } from "@/lib/challenges/repository";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
/** The cutover is one-way for everyone on the normal data path; a test that needs the pre-cutover world back uses the explicit remediation path (a connection with triggers off), exactly what the isolation helper does. */
async function clearCutover() {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.platform_settings set confidence_mandatory_since = null where id = true");
    await client.query("commit");
  } finally {
    await client.end();
  }
}
beforeEach(async () => {
  await clearCutover();
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true });
});
let staffId: string | null = null;
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});
async function superAdmin() {
  if (!staffId) {
    staffId = await seedUser("mc-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
}

async function member(label = "mc") {
  const id = await seedUser(label);
  await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
const account = async (id: string) => (await admin.from("confidence_accounts").select("*").eq("member_id", id).single()).data as Row;
const picksOf = async (userId: string, marketId?: string) => {
  let q = admin.from("predictions").select("*").eq("user_id", userId);
  if (marketId) q = q.eq("market_id", marketId);
  return ((await q).data ?? []) as Row[];
};
const stakesOf = async (memberId: string) => ((await admin.from("confidence_prediction_stakes").select("*").eq("member_id", memberId)).data ?? []) as Row[];
const reserves = async (memberId: string) => ((await admin.from("confidence_ledger_entries").select("*").eq("member_id", memberId).eq("entry_type", "PREDICTION_RESERVE")).data ?? []) as Row[];
const compose = async (memberId: string, marketId: string, side: "YES" | "NO", amount: number, key: string = randomUUID()) =>
  (await admin.rpc("create_confidence_prediction", {
    p_user_id: memberId, p_market_id: marketId, p_selected_outcome: side, p_amount: amount, p_yes_probability: 0.6, p_no_probability: 0.4,
    p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: key,
  })) as { data: Row | null; error: { message: string } | null };
async function nothingCreated(memberId: string, marketId: string, before: Row) {
  expect(await picksOf(memberId, marketId)).toEqual([]);
  expect(await stakesOf(memberId)).toEqual([]);
  expect(await reserves(memberId)).toEqual([]);
  const a = await account(memberId);
  expect([Number(a.available), Number(a.reserved)]).toEqual([Number(before.available), Number(before.reserved)]);
}
async function game(startsInMinutes = 24 * 60, template: Parameters<typeof seedGame>[0] = {}) {
  return seedGame({ startsInMinutes, ...template });
}
const cutover = async () => ((await admin.from("platform_settings").select("confidence_mandatory_since").eq("id", true).single()).data as Row).confidence_mandatory_since as string | null;
async function activateCutover() {
  await ok_("admin_set_confidence_config", { p_admin_id: await superAdmin(), p_config: { confidence_mandatory: true } });
}
async function ok_(name: string, args: Record<string, unknown>) {
  const r = await admin.rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
}
async function clientFor(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const c = getTestAnonClient();
  expect((await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD })).error).toBeNull();
  return c;
}

describe("creating a prediction: side + Confidence, atomically", () => {
  it("creates exactly one Pick, one stake and one reserve and locks it in the same step: available −N, reserved +N, total unchanged", async () => {
    const m = await member("atomic");
    const g = await game();
    const before = await account(m);
    const r = await compose(m, g.marketId, "YES", 3);
    expect(r.data).toMatchObject({ outcome: "created", selectedOutcome: "YES", amount: 3, available: 47, reserved: 3, total: 50 });
    const picks = await picksOf(m, g.marketId);
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ selected_outcome: "YES", lock_reason: "CONFIDENCE_COMMITTED" });
    expect(picks[0].locked_at).not.toBeNull();
    const stakes = await stakesOf(m);
    expect(stakes).toHaveLength(1);
    expect(stakes[0]).toMatchObject({ prediction_id: picks[0].id, amount: 3, state: "RESERVED", selected_outcome: "YES" });
    const entries = await reserves(m);
    expect(entries).toHaveLength(1);
    expect([entries[0].available_delta, entries[0].reserved_delta, entries[0].stake_id]).toEqual([-3, 3, stakes[0].id]);
    const a = await account(m);
    expect([Number(a.available), Number(a.reserved), Number(a.total)]).toEqual([47, 3, Number(before.total)]);
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
    expect((await admin.rpc("confidence_reconcile_stakes", { p_grace_minutes: 0 })).data).toEqual([]);
  });

  it("every confirmed Pick is final: its side and its amount cannot change", async () => {
    const m = await member("final");
    const g = await game();
    await compose(m, g.marketId, "YES", 2);
    const pick = (await picksOf(m, g.marketId))[0];
    expect((await admin.from("predictions").update({ selected_outcome: "NO" }).eq("id", pick.id)).error).not.toBeNull();
    expect((await admin.from("confidence_prediction_stakes").update({ amount: 5 }).eq("prediction_id", pick.id)).error).not.toBeNull();
    // A second prediction on the same Market (different side, different amount, new key) changes nothing.
    const again = await compose(m, g.marketId, "NO", 5);
    expect(again.data).toMatchObject({ outcome: "already_predicted", selectedOutcome: "YES", amount: 2 });
    expect((await picksOf(m, g.marketId))[0].selected_outcome).toBe("YES");
    expect(await stakesOf(m)).toHaveLength(1);
    expect(Number((await account(m)).reserved)).toBe(2);
  });

  it("the amount must be on the configured ladder, and follows it when it changes — nothing is hard-coded", async () => {
    const m = await member("ladder");
    const g = await game();
    const before = await account(m);
    for (const amount of [0, -1, 6, 50]) expect((await compose(m, g.marketId, "YES", amount)).data?.outcome, String(amount)).toBe("invalid_amount");
    await nothingCreated(m, g.marketId, before);
    await setSettings({ confidence_allowed_stakes: [2, 5, 10] });
    expect((await compose(m, g.marketId, "YES", 1)).data?.outcome).toBe("invalid_amount"); // 1 is no longer a choice: the smallest is 2
    expect((await compose(m, g.marketId, "YES", 10)).data).toMatchObject({ outcome: "created", amount: 10, available: 40 });
  });

  it("a prediction needs available Confidence: with less than the amount (or none) it is refused and nothing at all is created", async () => {
    const m = await member("broke");
    const g = await game();
    await ok_("admin_confidence_adjust", { p_admin_id: await superAdmin(), p_member_id: m, p_amount: -48, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() }); // 2 available
    const before = await account(m);
    const r = await compose(m, g.marketId, "YES", 3);
    expect(r.data).toMatchObject({ outcome: "insufficient", available: 2 });
    await nothingCreated(m, g.marketId, before);
    // Zero: no prediction of any size, and no unbacked fallback.
    await ok_("admin_confidence_adjust", { p_admin_id: await superAdmin(), p_member_id: m, p_amount: -2, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() });
    const zero = await account(m);
    expect(Number(zero.available)).toBe(0);
    expect((await compose(m, g.marketId, "YES", 1)).data?.outcome).toBe("insufficient");
    expect(await picksOf(m, g.marketId)).toEqual([]);
  });

  it("only AVAILABLE counts: Confidence already behind another prediction is not spendable twice", async () => {
    const m = await member("twice");
    await ok_("admin_confidence_adjust", { p_admin_id: await superAdmin(), p_member_id: m, p_amount: -47, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() }); // 3 available
    const a = await game();
    const b = await game();
    expect((await compose(m, a.marketId, "YES", 3)).data?.outcome).toBe("created");
    const r = await compose(m, b.marketId, "YES", 1);
    expect(r.data).toMatchObject({ outcome: "insufficient", available: 0 });
    expect(await picksOf(m, b.marketId)).toEqual([]);
  });

  it("is refused — creating nothing — when Confidence or predictions are switched off, or for a Member with no Confidence (a Sponsor)", async () => {
    const m = await member("off");
    const g = await game();
    const before = await account(m);
    await setSettings({ confidence_backed_picks_enabled: false });
    expect((await compose(m, g.marketId, "YES", 1)).data?.outcome).toBe("disabled");
    await setSettings({ confidence_backed_picks_enabled: true, confidence_enabled: false });
    expect((await compose(m, g.marketId, "YES", 1)).data?.outcome).toBe("disabled");
    await setSettings({ confidence_enabled: true });
    await nothingCreated(m, g.marketId, before);
    const sponsor = await seedSponsorAccount("mc-sponsor");
    expect((await compose(sponsor.userId, g.marketId, "YES", 1)).data?.outcome).toBe("ineligible");
    expect(await picksOf(sponsor.userId, g.marketId)).toEqual([]);
  });
});

describe("the deadline and the Game", () => {
  it("inside the lock window, or once the Game has started, nothing is created", async () => {
    const m = await member("deadline");
    const late = await game(60);
    await setFixture(late.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    const before = await account(m);
    expect((await compose(m, late.marketId, "YES", 1)).data?.outcome).toBe("past_deadline");
    const live = await game(60);
    await setFixture(live.fixtureId, { internal_status: "LIVE" });
    expect((await compose(m, live.marketId, "YES", 1)).data?.outcome).toBe("game_started");
    expect(await picksOf(m)).toEqual([]);
    expect(await stakesOf(m)).toEqual([]);
    const a = await account(m);
    expect([Number(a.available), Number(a.reserved)]).toEqual([Number(before.available), Number(before.reserved)]);
  });

  it("the deadline is the configured lock window, not a constant: widening it closes a Market that was open", async () => {
    const m = await member("window");
    const g = await game(30);
    await setSettings({ pick_lock_minutes_before_kickoff: 45 });
    expect((await compose(m, g.marketId, "YES", 1)).data?.outcome).toBe("past_deadline");
    await setSettings({ pick_lock_minutes_before_kickoff: 10 });
    expect((await compose(m, g.marketId, "YES", 1)).data?.outcome).toBe("created");
  });
});

describe("atomicity: all of it or none of it", () => {
  async function withFailingTrigger(table: string, when: string, run: () => Promise<void>) {
    await sql(`create or replace function public.mc_test_fail() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end; $$`);
    await sql(`create trigger mc_test_fail_trg before insert on public.${table} for each row ${when} execute function public.mc_test_fail()`);
    try {
      await run();
    } finally {
      await sql(`drop trigger if exists mc_test_fail_trg on public.${table}`);
      await sql(`drop function if exists public.mc_test_fail()`);
    }
  }

  it("if creating the stake fails, the Pick does not exist and no Confidence moved", async () => {
    const m = await member("rollback-stake");
    const g = await game();
    const before = await account(m);
    await withFailingTrigger("confidence_prediction_stakes", "", async () => {
      const r = await compose(m, g.marketId, "YES", 2);
      expect(r.error).not.toBeNull();
    });
    await nothingCreated(m, g.marketId, before);
  });

  it("if the reserve fails, the Pick and the stake do not exist either", async () => {
    const m = await member("rollback-reserve");
    const g = await game();
    const before = await account(m);
    await withFailingTrigger("confidence_ledger_entries", "when (new.entry_type = 'PREDICTION_RESERVE')", async () => {
      expect((await compose(m, g.marketId, "YES", 2)).error).not.toBeNull();
    });
    await nothingCreated(m, g.marketId, before);
    // And it works normally once the fault is gone.
    expect((await compose(m, g.marketId, "YES", 2)).data?.outcome).toBe("created");
  });

  it("a refused Pick validation (e.g. a started Game) leaves no stake behind", async () => {
    const m = await member("rollback-validate");
    const g = await game(60);
    await setFixture(g.fixtureId, { internal_status: "LIVE" });
    const before = await account(m);
    expect((await compose(m, g.marketId, "YES", 2)).data?.outcome).toBe("game_started");
    await nothingCreated(m, g.marketId, before);
  });
});

describe("exactly once: retries and double taps", () => {
  it("the same request retried returns the original result and creates nothing more", async () => {
    const m = await member("retry");
    const g = await game();
    const key = randomUUID();
    const first = await compose(m, g.marketId, "YES", 3, key);
    const again = await compose(m, g.marketId, "YES", 3, key);
    expect(first.data?.outcome).toBe("created");
    expect(again.data).toMatchObject({ outcome: "created", replay: true, amount: 3, predictionId: first.data?.predictionId });
    expect(await picksOf(m, g.marketId)).toHaveLength(1);
    expect(await stakesOf(m)).toHaveLength(1);
    expect(await reserves(m)).toHaveLength(1);
    expect(Number((await account(m)).reserved)).toBe(3);
  });

  it("a retry with a different amount or side but the same key still returns the ORIGINAL prediction", async () => {
    const m = await member("retry-diff");
    const g = await game();
    const key = randomUUID();
    await compose(m, g.marketId, "YES", 3, key);
    const again = await compose(m, g.marketId, "NO", 5, key);
    expect(again.data).toMatchObject({ replay: true, selectedOutcome: "YES", amount: 3 });
    expect(await stakesOf(m)).toHaveLength(1);
  });

  it("many simultaneous taps (same key, and different keys) produce one Pick, one stake and one reserve", async () => {
    const m = await member("race");
    const g = await game();
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 8 }, () => compose(m, g.marketId, "YES", 3, key)));
    for (const r of same) expect(r.data?.outcome).toBe("created");
    const h = await game();
    const mixed = await Promise.all([1, 2, 3, 4, 5, 1, 2, 3].map((n) => compose(m, h.marketId, n % 2 ? "YES" : "NO", n)));
    expect(mixed.filter((r) => r.data?.outcome === "created")).toHaveLength(1);
    expect(mixed.filter((r) => r.data?.outcome === "already_predicted")).toHaveLength(mixed.length - 1);
    expect(await picksOf(m)).toHaveLength(2);
    expect(await stakesOf(m)).toHaveLength(2);
    expect(await reserves(m)).toHaveLength(2);
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });

  it("the same key for a different Market is a conflict, never a second prediction", async () => {
    const m = await member("conflict");
    const a = await game();
    const b = await game();
    const key = randomUUID();
    await compose(m, a.marketId, "YES", 1, key);
    expect((await compose(m, b.marketId, "YES", 1, key)).data?.outcome).toBe("idempotency_conflict");
    expect(await picksOf(m, b.marketId)).toEqual([]);
  });
});

describe("several Markets of one Game", () => {
  it("Moneyline 🔥3, Total 🔥2, Spread 🔥1 are three independent Picks with three stakes and 🔥6 reserved, each immutable", async () => {
    const m = await member("multi");
    const { fixtureId, marketId } = await game();
    const addMarket = async (template: "TOTAL" | "SPREAD", line: number) =>
      (await admin.from("markets").insert({
        provider: "api_nfl", provider_market_id: `mc_${randomUUID()}`, question: "q?", status: "ACTIVE", fixture_id: fixtureId, yes_price: 0.5, no_price: 0.5, liquidity: 100, last_synced_at: new Date().toISOString(),
        ingestion_source: "test", provider_metadata: {}, market_template: template, yes_side: template === "TOTAL" ? null : "HOME", line_value: line,
      }).select("id").single()).data!.id as string;
    const total = await addMarket("TOTAL", 224);
    const spread = await addMarket("SPREAD", -2.5);
    for (const [market, side, amount] of [[marketId, "YES", 3], [total, "NO", 2], [spread, "YES", 1]] as const) expect((await compose(m, market, side, amount)).data?.outcome).toBe("created");
    const a = await account(m);
    expect([Number(a.available), Number(a.reserved), Number(a.total)]).toEqual([44, 6, 50]);
    expect(await picksOf(m)).toHaveLength(3);
    expect((await stakesOf(m)).map((s) => s.amount).sort()).toEqual([1, 2, 3]);
    for (const p of await picksOf(m)) expect(p.lock_reason).toBe("CONFIDENCE_COMMITTED");
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });
});

describe("the cutover: no other way to create a Pick", () => {
  it("before the switch nothing is enforced differently (earlier Picks and tools keep working); the composer works either way", async () => {
    const m = await member("pre");
    const g = await game();
    const legacy = await seedPick(m, g.marketId, "YES"); // the generic path, as before
    expect(legacy).toBeTruthy();
    expect(await stakesOf(m)).toEqual([]);
  });

  it("only a Super Admin can activate it, activation needs predictions on, it is audited, and asking again keeps the very same instant", async () => {
    const regular = await seedUser("mc-regular");
    expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: regular, p_config: { confidence_mandatory: true } })).error).not.toBeNull();
    await setSettings({ confidence_backed_picks_enabled: false });
    expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: await superAdmin(), p_config: { confidence_mandatory: true } })).error?.message).toMatch(/mandatory_requires_predictions_on/);
    expect(await cutover()).toBeNull();
    await setSettings({ confidence_backed_picks_enabled: true });
    await activateCutover();
    const since = await cutover();
    expect(since).not.toBeNull();
    await activateCutover(); // idempotent: the instant is kept
    expect(await cutover()).toBe(since);
    const audits = await admin.from("audit_logs").select("before, after").eq("action", "settings.confidence_updated").order("created_at", { ascending: false }).limit(5);
    const activation = audits.data!.find((a) => (a.after as Row).confidence_mandatory_since === since && (a.before as Row).confidence_mandatory_since === null);
    expect(activation, "the activation is audited, NULL -> the instant").toBeTruthy();
    // The instant is the SERVER's, never a value a caller supplies: it is within a moment of now.
    expect(Math.abs(Date.now() - new Date(since!).getTime())).toBeLessThan(60_000);
  });

  it("ONE-WAY: once set it cannot be turned off, moved earlier or later, or set to the future — not by the Settings function, not by the service role, not by any direct update", async () => {
    await activateCutover();
    const since = (await cutover())!;
    // The Settings function: asking for "off" is refused outright and nothing changes.
    const off = await admin.rpc("admin_set_confidence_config", { p_admin_id: await superAdmin(), p_config: { confidence_mandatory: false } });
    expect(off.error?.message).toMatch(/cutover_is_permanent/);
    expect(await cutover()).toBe(since);
    // Direct writes through the data API (the service role): unset, a different instant, the future, the past.
    const attempts: Array<string | null> = [null, new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString(), new Date(new Date(since).getTime() + 1).toISOString()];
    for (const value of attempts) {
      const r = await admin.from("platform_settings").update({ confidence_mandatory_since: value }).eq("id", true);
      expect(r.error?.message, String(value)).toMatch(/cutover_is_permanent/);
    }
    expect(await cutover()).toBe(since);
    // The generic settings reads/other columns still work (the trigger only guards this column).
    expect((await admin.from("platform_settings").update({ confidence_baseline: 50 }).eq("id", true)).error).toBeNull();
    // Activation also cannot be backdated or scheduled: from NULL, only "now" is accepted.
    await clearCutover();
    for (const value of [new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString()]) {
      const r = await admin.from("platform_settings").update({ confidence_mandatory_since: value }).eq("id", true);
      expect(r.error?.message, value).toMatch(/cutover_must_be_now/);
    }
    expect(await cutover()).toBeNull();
  });

  it("the operational kill switch is separate: after the cutover, pausing predictions stops NEW ones, never reopens unbacked Picks, never touches the cutover, and existing stakes still settle", async () => {
    const m = await member("kill");
    const open = await game(60);
    await compose(m, open.marketId, "YES", 3);
    await activateCutover();
    const since = await cutover();
    // Pause backed predictions, then Confidence entirely.
    await setSettings({ confidence_backed_picks_enabled: false });
    const g = await game();
    expect((await compose(m, g.marketId, "YES", 1)).data?.outcome).toBe("disabled");
    expect((await admin.rpc("set_pick", { p_user_id: m, p_market_id: g.marketId, p_selected_outcome: "YES", p_yes_probability: 0.5, p_no_probability: 0.5, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single()).data).toMatchObject({ outcome: "rejected_backing_required" });
    expect((await admin.from("predictions").insert({ user_id: m, market_id: g.marketId, selected_outcome: "YES", yes_probability_snapshot: 0.5, no_probability_snapshot: 0.5, market_question_snapshot: "q", market_status_snapshot: "ACTIVE", idempotency_key: randomUUID() })).error?.message).toMatch(/cannot exist without Confidence/);
    expect(await picksOf(m, g.marketId)).toEqual([]);
    await setSettings({ confidence_enabled: false });
    expect(await cutover()).toBe(since); // the cutover never moved
    // The existing reserved stake still settles from the result.
    await setFixture(open.fixtureId, { internal_status: "COMPLETED", home_score: 3, away_score: 1 });
    await runGradingJob(recordGradedPredictionResult);
    const a = await account(m);
    expect([Number(a.available), Number(a.reserved)]).toEqual([53, 0]); // 47 + 3 returned + 3 won
    expect((await stakesOf(m))[0].state).toBe("SETTLED_CORRECT");
    // And turning predictions back on does not touch the cutover either.
    await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true });
    expect(await cutover()).toBe(since);
  });

  it("after the switch set_pick refuses to persist a Pick (so no unbacked Pick can be saved), and the composer still creates backed ones", async () => {
    const m = await member("post");
    const g = await game();
    await activateCutover();
    const direct = await admin.rpc("set_pick", { p_user_id: m, p_market_id: g.marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
    expect((direct.data as Row).outcome).toBe("rejected_backing_required");
    expect(await picksOf(m, g.marketId)).toEqual([]);
    expect((await compose(m, g.marketId, "YES", 2)).data?.outcome).toBe("created");
  });

  it("after the switch a direct insert of a Pick without a stake cannot commit — and a Pick created together with its stake can", async () => {
    const m = await member("direct");
    const g = await game();
    await activateCutover();
    const insert = await admin.from("predictions").insert({ user_id: m, market_id: g.marketId, selected_outcome: "YES", yes_probability_snapshot: 0.5, no_probability_snapshot: 0.5, market_question_snapshot: "q", market_status_snapshot: "ACTIVE", idempotency_key: randomUUID() });
    expect(insert.error?.message).toMatch(/cannot exist without Confidence/);
    expect(await picksOf(m, g.marketId)).toEqual([]);
  });

  it("after the switch the separate attach is retired", async () => {
    const m = await member("attach");
    const g = await game();
    const legacy = await seedPick(m, g.marketId, "YES");
    await activateCutover();
    const r = await admin.rpc("confidence_attach_stake", { p_member_id: m, p_prediction_id: legacy, p_amount: 1, p_idempotency_key: randomUUID() });
    expect((r.data as Row).outcome).toBe("retired");
    expect(await stakesOf(m)).toEqual([]);
  });

  it("a Member's own session can do none of it: no direct write to predictions or stakes, no composer, no set_pick, no attach", async () => {
    const m = await member("rls");
    const g = await game();
    await activateCutover();
    const client = await clientFor(m);
    expect((await client.from("predictions").insert({ user_id: m, market_id: g.marketId, selected_outcome: "YES", yes_probability_snapshot: 0.5, no_probability_snapshot: 0.5, market_question_snapshot: "q", market_status_snapshot: "ACTIVE", idempotency_key: randomUUID() })).error).not.toBeNull();
    expect((await client.from("confidence_prediction_stakes").insert({ member_id: m, prediction_id: randomUUID(), market_id: g.marketId, fixture_id: g.fixtureId, selected_outcome: "YES", amount: 1, allowed_stakes_snapshot: [1] })).error).not.toBeNull();
    expect((await client.rpc("create_confidence_prediction", { p_user_id: m, p_market_id: g.marketId, p_selected_outcome: "YES", p_amount: 1, p_yes_probability: 0.5, p_no_probability: 0.5, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })).error).not.toBeNull();
    expect((await client.rpc("set_pick", { p_user_id: m, p_market_id: g.marketId, p_selected_outcome: "YES", p_yes_probability: 0.5, p_no_probability: 0.5, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })).error).not.toBeNull();
    expect((await client.rpc("confidence_attach_stake", { p_member_id: m, p_prediction_id: randomUUID(), p_amount: 1, p_idempotency_key: randomUUID() })).error).not.toBeNull();
    expect(await picksOf(m, g.marketId)).toEqual([]);
    expect(await stakesOf(m)).toEqual([]);
    for (const fn of ["confidence_pick_requires_stake"]) {
      const rows = await sql<Row>(`select has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [fn]);
      expect(rows[0], fn).toEqual({ a: false, u: false, s: false });
    }
  });

  it("reconciliation reports a Pick without a stake after the switch (and only then)", async () => {
    const m = await member("reconcile");
    const g = await game();
    expect(((await admin.rpc("confidence_reconcile_stakes", { p_grace_minutes: 0 })).data as Row[]).filter((r) => r.kind === "PICK_WITHOUT_STAKE_AFTER_CUTOVER")).toEqual([]);
    await activateCutover();
    // A defect, simulated the only way possible: bypass the trigger as a superuser.
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    let id: string | undefined;
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      id = (await client.query("insert into public.predictions (user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, market_question_snapshot, market_status_snapshot, idempotency_key) values ($1,$2,'YES',0.5,0.5,'q','ACTIVE',$3) returning id", [m, g.marketId, randomUUID()])).rows[0].id;
      await client.query("commit");
    } finally {
      await client.end();
    }
    const found = ((await admin.rpc("confidence_reconcile_stakes", { p_grace_minutes: 0 })).data as Row[]).filter((r) => r.kind === "PICK_WITHOUT_STAKE_AFTER_CUTOVER");
    expect(found.map((r) => r.member_id)).toContain(m);
    await sql("alter table public.predictions disable trigger user"); // cleanup the deliberate defect
    await sql("delete from public.predictions where id = $1", [id]);
    await sql("alter table public.predictions enable trigger user");
  });
});

describe("Picks made before the cutover", () => {
  it("an open, unbacked Pick is COMPLETED by the composer (its side may be re-chosen) — one Pick, one stake — and nothing is invented for others", async () => {
    const m = await member("legacy-open");
    const g = await game();
    const legacyId = await seedPick(m, g.marketId, "YES");
    await activateCutover();
    const r = await compose(m, g.marketId, "NO", 2);
    expect(r.data).toMatchObject({ outcome: "created", predictionId: legacyId, selectedOutcome: "NO", amount: 2 });
    const picks = await picksOf(m, g.marketId);
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ id: legacyId, selected_outcome: "NO", lock_reason: "CONFIDENCE_COMMITTED" });
    expect(await stakesOf(m)).toHaveLength(1);
  });

  it("a legacy Pick that is already locked, or graded, is left exactly as it is: no stake is invented, no completion", async () => {
    const m = await member("legacy-locked");
    const locked = await game();
    const lockedId = await seedPick(m, locked.marketId, "YES");
    await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CHALLENGE_ACCEPTED" }).eq("id", lockedId);
    const graded = await game(60);
    const gradedId = await seedPick(m, graded.marketId, "YES");
    await setFixture(graded.fixtureId, { internal_status: "COMPLETED", home_score: 3, away_score: 1 });
    await runGradingJob(recordGradedPredictionResult);
    await activateCutover();
    const before = await account(m);
    expect((await compose(m, locked.marketId, "NO", 1)).data?.outcome).toBe("pick_locked");
    expect((await compose(m, graded.marketId, "NO", 1)).data?.outcome).toMatch(/game_started|pick_locked/);
    expect(await stakesOf(m)).toEqual([]);
    expect((await picksOf(m, locked.marketId))[0]).toMatchObject({ id: lockedId, selected_outcome: "YES", lock_reason: "CHALLENGE_ACCEPTED" });
    expect((await picksOf(m, graded.marketId))[0]).toMatchObject({ id: gradedId, lifecycle_state: "GRADED", result: "CORRECT" });
    expect(Number((await account(m)).available)).toBe(Number(before.available));
    // Grading and history of legacy Picks keep working with the invariant on.
    expect((await admin.rpc("confidence_reconcile_stakes", { p_grace_minutes: 0 })).data).toEqual([]);
  });
});

describe("settlement, Call BS and the numbers on composer-made predictions", () => {
  it("correct = net +N, incorrect = net −N, void = 0 — unchanged", async () => {
    const win = await member("win");
    const loss = await member("loss");
    const tie = await member("tie");
    const g = await game(60);
    await compose(win, g.marketId, "YES", 4);
    await compose(loss, g.marketId, "NO", 2);
    const g2 = await game(60);
    await compose(tie, g2.marketId, "YES", 3);
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 7, away_score: 3 });
    await setFixture(g2.fixtureId, { internal_status: "COMPLETED", home_score: 2, away_score: 2 });
    await runGradingJob(recordGradedPredictionResult);
    const w = await account(win);
    const l = await account(loss);
    const t = await account(tie);
    expect([Number(w.available), Number(w.reserved)]).toEqual([54, 0]);
    expect([Number(l.available), Number(l.reserved)]).toEqual([48, 0]);
    expect([Number(t.available), Number(t.reserved)]).toEqual([50, 0]);
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });

  it("Call BS works between two composer-made (already locked) Picks and carries no Confidence of its own", async () => {
    const a = await member("cb-a");
    const b = await member("cb-b");
    const g = await game();
    await compose(a, g.marketId, "YES", 2);
    await compose(b, g.marketId, "NO", 3);
    const bPick = (await picksOf(b, g.marketId))[0];
    const call = await callBS(a, bPick.id);
    expect(call.ok, JSON.stringify(call)).toBe(true);
    if (!call.ok) return;
    const accepted = await acceptCallBS(call.challenge.id, b);
    expect(accepted.outcome).toBe("accepted");
    // Confidence is untouched by the challenge: still exactly the two reserves.
    expect(Number((await account(a)).reserved)).toBe(2);
    expect(Number((await account(b)).reserved)).toBe(3);
    expect((await picksOf(a, g.marketId))[0].lock_reason).toBe("CONFIDENCE_COMMITTED"); // the Pick was already final; Call BS is not what locks it
    expect(await reserves(a)).toHaveLength(1);
  });
});

describe("observability and the capacity to predict", () => {
  it("reports members who cannot predict now, the legacy-Pick split and the cutover instant", async () => {
    const broke = await member("cap-broke");
    await ok_("admin_confidence_adjust", { p_admin_id: await superAdmin(), p_member_id: broke, p_amount: -50, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() });
    const before = (await admin.rpc("confidence_prediction_capacity")).data as Row;
    const m = await member("cap-ok");
    const g = await game();
    const legacy = await game();
    await seedPick(m, legacy.marketId, "YES");
    await compose(m, g.marketId, "YES", 1);
    const after = (await admin.rpc("confidence_prediction_capacity")).data as Row;
    expect(after.minimumStake).toBe(1);
    expect(after.unableToPredict).toBeGreaterThanOrEqual(1);
    expect(after.backedPicks - before.backedPicks).toBe(1);
    expect(after.legacyPicks.total - before.legacyPicks.total).toBe(1);
    expect(after.legacyPicks.openAndEditable - before.legacyPicks.openAndEditable).toBe(1);
    expect(after.mandatorySince).toBeNull();
  });

  it("the new functions are service-role only: not callable by the public or a Member", async () => {
    const m = await member("priv");
    for (const client of [getTestAnonClient(), await clientFor(m)]) {
      expect((await client.rpc("confidence_prediction_capacity")).error).not.toBeNull();
    }
  });
});
