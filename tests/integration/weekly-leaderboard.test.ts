/**
 * Brohda 2.1 M6 — the weekly leaderboard (migration 219) against the real local Supabase.
 *   - the policy: OFF by default, three independent settings, one audited, validated, idempotent Super-Admin function, server-only reads;
 *   - fairness: the owner's example records (5–0, 9–1, 15–5, 4–1, 3–0), qualification (zero, one, threshold − 1, exactly, above; pending and void never count; lifetime picks never qualify a quiet week);
 *   - ranking: accuracy, then more correct, then fewer incorrect; identical records share a rank; the order is stable; own position outside the top N; progress toward qualifying;
 *   - who is ranked: players only, active only; blocks and everything else about a profile do not change the board;
 *   - the week: one definition (Monday 00:00 America/Costa_Rica), a Game counts in the week it was played, a late grading job never moves it, and a profile's "This week" agrees with the board;
 *   - an independent JavaScript reference over a random population; the shape of the data (aggregates only); scale (100 / 1,000 / 10,000 Members).
 * Every test works in its OWN far-future week (the function takes the instant to look at), so nothing any other suite seeds can enter a ranking. Rows are seeded straight into the canonical tables
 * (trigger-free) because the point is to read history, not to replay how it was made.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Client } from "pg";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl, getTestSupabaseConfig } from "./helpers/test-env";
import { seedUser } from "./helpers/game-seed";
import { getWeeklyLeaderboard } from "@/lib/leaderboard/repository";
import { parseWeeklyLeaderboard } from "@/lib/leaderboard/format";

const admin = getTestAdminClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Monday 2031-01-06 00:00 in America/Costa_Rica (UTC-6, no daylight saving) = 06:00 UTC. Week n starts n weeks later; tests take far-apart weeks so no two ever share data.
const WEEK_ZERO = Date.UTC(2031, 0, 6, 6, 0, 0);
let weekCounter = 100;
const nextWeek = () => WEEK_ZERO + weekCounter++ * 7 * DAY;
const mid = (weekStart: number) => new Date(weekStart + 3 * DAY).toISOString();

type Result = "CORRECT" | "INCORRECT" | "VOID" | "PENDING";
interface PickSpec {
  result: Result;
  /** The Game's scheduled start, epoch ms. */
  startMs: number;
  /** When the grading job ran (default: 3 hours after the Game). */
  gradedMs?: number;
  /** Seed the market with a Game row that no longer exists. */
  noGame?: boolean;
}

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Picks for one Member, each on its own Game and Market. */
async function seedPicks(userId: string, specs: PickSpec[]): Promise<void> {
  if (specs.length === 0) return;
  const rows = specs.map((s) => ({
    fixtureId: randomUUID(),
    marketId: randomUUID(),
    predictionId: randomUUID(),
    result: s.result,
    startMs: s.startMs,
    gradedMs: s.gradedMs ?? s.startMs + 3 * HOUR,
    noGame: Boolean(s.noGame),
  }));
  await withDb(async (c) => {
    for (let at = 0; at < rows.length; at += 500) {
      const chunk = JSON.stringify(rows.slice(at, at + 500));
      await c.query(
        `insert into public.fixtures (id, provider, external_fixture_id, sport, season, home_team_name, away_team_name, scheduled_start_utc, internal_status)
         select x."fixtureId", 'api_nfl', 'lb-' || x."fixtureId", 'american_football', '2026', 'LB Home', 'LB Away', to_timestamp(x."startMs" / 1000.0), 'COMPLETED'
         from jsonb_to_recordset($1::jsonb) as x("fixtureId" uuid, "startMs" double precision, "noGame" boolean) where not x."noGame"`,
        [chunk],
      );
      await c.query(
        `insert into public.markets (id, provider, provider_market_id, question, status, fixture_id, market_template, yes_side, last_synced_at, ingestion_source, provider_metadata)
         select x."marketId", 'lb', 'lb-' || x."marketId", 'LB?', 'ACTIVE', x."fixtureId", 'MONEYLINE', 'HOME', now(), 'test', '{}'::jsonb from jsonb_to_recordset($1::jsonb) as x("marketId" uuid, "fixtureId" uuid)`,
        [chunk],
      );
      await c.query(
        `insert into public.predictions (id, user_id, market_id, selected_outcome, market_question_snapshot, market_status_snapshot, lifecycle_state, result, resolved_outcome_snapshot, graded_at, idempotency_key, created_at)
         select x."predictionId", $2, x."marketId", 'YES', 'LB?', 'RESOLVED',
                case when x.result = 'PENDING' then 'PENDING' else 'GRADED' end,
                case when x.result = 'PENDING' then null else x.result end,
                case x.result when 'CORRECT' then 'YES' when 'INCORRECT' then 'NO' else null end,
                case when x.result = 'PENDING' then null else to_timestamp(x."gradedMs" / 1000.0) end,
                'lb-' || x."predictionId", to_timestamp(x."startMs" / 1000.0) - interval '1 day'
         from jsonb_to_recordset($1::jsonb) as x("predictionId" uuid, "marketId" uuid, result text, "gradedMs" double precision, "startMs" double precision)`,
        [chunk, userId],
      );
    }
  });
}

/** `correct` + `incorrect` decided picks, one every few hours through the middle of the week. */
const record = (weekStart: number, correct: number, incorrect: number, extra: Result[] = []): PickSpec[] =>
  [...Array<Result>(correct).fill("CORRECT"), ...Array<Result>(incorrect).fill("INCORRECT"), ...extra].map((result, i) => ({ result, startMs: weekStart + DAY + i * 2 * HOUR }));

async function member(label: string, opts: { role?: string; active?: boolean; closed?: boolean } = {}): Promise<string> {
  const id = await seedUser(label);
  const patch: Row = {};
  if (opts.role) patch.role = opts.role;
  if (opts.active === false) patch.is_active = false;
  if (opts.closed) patch.account_closed_at = new Date().toISOString();
  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from("user_profiles").update(patch).eq("id", id);
    if (error) throw error;
  }
  return id;
}

async function board(weekStart: number, viewer: string | null = null, limit: number | null = null): Promise<{ raw: Row; entries: Row[]; me: Row | null }> {
  const { data, error } = await admin.rpc("get_weekly_leaderboard", { p_viewer_id: viewer, p_limit: limit, p_at: mid(weekStart) });
  if (error) throw error;
  const raw = data as Row;
  return { raw, entries: raw.entries as Row[], me: (raw.me as Row | null) ?? null };
}

const setWeekly = async (min: number, topN = 20) => {
  const { error } = await admin.from("platform_settings").update({ leaderboard_weekly_min_decided_picks: min, leaderboard_top_n: topN }).eq("id", true);
  if (error) throw error;
};
const reset = async () => {
  const { error } = await admin.from("platform_settings").update({ leaderboard_enabled: false, leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: 20 }).eq("id", true);
  if (error) throw error;
};
beforeEach(reset);
afterEach(reset);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the policy", () => {
  it("is OFF by default, with three independent settings and safe defaults", async () => {
    const { data } = await admin.rpc("get_weekly_leaderboard", { p_at: mid(nextWeek()) });
    expect((data as Row).min_decided).toBe(5);
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      const { rows } = await client.query(
        `select column_name, column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name in ('leaderboard_enabled', 'leaderboard_weekly_min_decided_picks', 'leaderboard_top_n', 'leaderboard_min_decided_picks') order by column_name`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(byName.leaderboard_enabled.column_default).toBe("false");
      expect(byName.leaderboard_weekly_min_decided_picks.column_default).toBe("5");
      expect(byName.leaderboard_top_n.column_default).toBe("20");
      expect(Object.values(byName).every((r) => (r as Row).is_nullable === "NO")).toBe(true);
    } finally {
      await client.end();
    }
    const { data: settings } = await admin.from("platform_settings").select("leaderboard_enabled").eq("id", true).single();
    expect(settings?.leaderboard_enabled).toBe(false);
  });

  it("is edited only by a Super Admin, through one audited, validated, idempotent function", async () => {
    const staff = await member("lb-super", { role: "super_admin" });
    const player = await member("lb-player");
    const set = (adminId: string | null, enabled: boolean | null, min: number | null, top: number | null) => admin.rpc("admin_set_leaderboard_policy", { p_admin_id: adminId, p_enabled: enabled, p_weekly_min: min, p_top_n: top });

    expect((await set(player, true, null, null)).error).not.toBeNull();
    expect((await set(null, true, null, null)).error).not.toBeNull();
    for (const bad of [[null, 0, null], [null, 51, null], [null, null, 2], [null, null, 101]] as const) {
      expect((await set(staff, bad[0], bad[1], bad[2])).error?.message).toContain("invalid_policy");
    }
    const logs = async () => (await admin.from("audit_logs").select("before, after, actor_id").eq("action", "settings.leaderboard_policy_updated").order("created_at", { ascending: false })).data ?? [];
    const before = (await logs()).length;
    const first = await set(staff, true, 7, 12);
    expect(first.error).toBeNull();
    const rows = await logs();
    expect(rows.length).toBe(before + 1);
    expect(rows[0].after).toEqual({ leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: 7, leaderboard_top_n: 12 });
    expect(rows[0].before).toEqual({ leaderboard_enabled: false, leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: 20 });
    expect(rows[0].actor_id).toBe(staff);
    // The same values again change nothing and write nothing; a partial change keeps the rest.
    await set(staff, true, 7, 12);
    expect((await logs()).length).toBe(before + 1);
    await set(staff, null, null, 15);
    const { data: now } = await admin.from("platform_settings").select("leaderboard_enabled, leaderboard_weekly_min_decided_picks, leaderboard_top_n").eq("id", true).single();
    expect(now).toEqual({ leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: 7, leaderboard_top_n: 15 });
  });

  it("is private to the server: neither the public nor a signed-in Member can call any of it", async () => {
    const calls: Array<[string, Row]> = [
      ["get_weekly_leaderboard", { p_viewer_id: null }],
      ["platform_week_bounds", {}],
      ["admin_set_leaderboard_policy", { p_admin_id: randomUUID(), p_enabled: true }],
    ];
    const anon = getTestAnonClient();
    for (const [name, args] of calls) expect((await anon.rpc(name, args)).error, `anon ${name}`).not.toBeNull();

    const { url, anonKey } = getTestSupabaseConfig();
    const email = `lb-priv-${randomUUID()}@test.local`;
    const created = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
    await admin.from("user_profiles").insert({ id: created.data.user!.id, display_name: "lbpriv", role: "player", is_active: true });
    const client = createSupabaseClient(url, anonKey);
    await client.auth.signInWithPassword({ email, password: "integration-test-password-123" });
    for (const [name, args] of calls) expect((await client.rpc(name, args)).error, `authenticated ${name}`).not.toBeNull();
    await admin.auth.admin.deleteUser(created.data.user!.id);

    for (const [name, args] of calls.slice(0, 2)) expect((await admin.rpc(name, args)).error, `service ${name}`).toBeNull();
  });

  it("the weekly minimum and the profile percentage minimum are two settings, not one", async () => {
    const week = nextWeek();
    const u = await member("lb-decoupled");
    await seedPicks(u, record(week, 3, 0));
    // Changing the profile percentage minimum (leaderboard_min_decided_picks) never changes who is ranked this week ...
    for (const profileMin of [1, 3, 9]) {
      await admin.from("platform_settings").update({ leaderboard_min_decided_picks: profileMin }).eq("id", true);
      const b = await board(week, u);
      expect(b.raw.min_decided).toBe(5);
      expect(b.me?.ranked).toBe(false);
    }
    // ... and changing the weekly minimum never changes the profile percentage minimum.
    await setWeekly(3);
    expect((await board(week, u)).me?.ranked).toBe(true);
    const { data: legacy } = await admin.rpc("get_user_prediction_record", { p_user_id: u }).single();
    expect((legacy as Row).min_decided_for_leaderboard).toBe(9);
    await admin.from("platform_settings").update({ leaderboard_min_decided_picks: 5 }).eq("id", true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("fairness: the owner's example records", () => {
  async function population() {
    const week = nextWeek();
    const people = { A: [5, 0], B: [9, 1], C: [15, 5], D: [4, 1], E: [3, 0] } as const;
    const ids: Record<string, string> = {};
    for (const [label, [c, i]] of Object.entries(people)) {
      ids[label] = await member(`lb-fair-${label}`);
      await seedPicks(ids[label], record(week, c, i));
    }
    return { week, ids };
  }
  const order = (entries: Row[], ids: Record<string, string>) => entries.map((e) => Object.entries(ids).find(([, id]) => id === e.user_id)![0]);

  it("with a minimum of 5: 5–0 leads 9–1, then 4–1 and 15–5; 3–0 is not ranked yet and is told what it needs", async () => {
    const { week, ids } = await population();
    const b = await board(week, ids.E);
    expect(order(b.entries, ids)).toEqual(["A", "B", "D", "C"]);
    expect(b.entries.map((e) => [e.correct, e.incorrect, e.rank])).toEqual([[5, 0, 1], [9, 1, 2], [4, 1, 3], [15, 5, 4]]);
    expect(b.raw.total_ranked).toBe(4);
    expect(b.me).toMatchObject({ eligible: true, ranked: false, rank: null, correct: 3, incorrect: 0, decided: 3, needed: 2 });
  });

  it("with a minimum of 3 the 3–0 joins, behind the 5–0 because more correct picks break an accuracy tie", async () => {
    const { week, ids } = await population();
    await setWeekly(3);
    const b = await board(week);
    expect(order(b.entries, ids)).toEqual(["A", "E", "B", "D", "C"]);
    expect(b.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("qualification", () => {
  it("counts only this week's decided picks: zero, one, threshold − 1, exactly the threshold, above", async () => {
    const week = nextWeek();
    const zero = await member("lb-q0");
    const one = await member("lb-q1");
    const below = await member("lb-q4");
    const exact = await member("lb-q5");
    const above = await member("lb-q6");
    await seedPicks(one, record(week, 1, 0));
    await seedPicks(below, record(week, 3, 1));
    await seedPicks(exact, record(week, 3, 2));
    await seedPicks(above, record(week, 4, 2));

    const names = (b: Row) => b.entries.map((e: Row) => e.display_name).sort();
    const b = await board(week);
    expect(names(b)).toEqual(["lb-q5", "lb-q6"]);
    for (const [who, needed, decided] of [[zero, 5, 0], [one, 4, 1], [below, 1, 4], [exact, 0, 5], [above, 0, 6]] as const) {
      const me = (await board(week, who)).me!;
      expect(me.decided, "decided").toBe(decided);
      expect(me.needed, "needed").toBe(needed);
      expect(me.ranked, "ranked").toBe(decided >= 5);
    }
    expect((await board(week, zero)).me).toMatchObject({ eligible: true, ranked: false, correct: 0, incorrect: 0, accuracy: null, rank: null });
  });

  it("never counts pending or void picks, toward the record or the minimum", async () => {
    const week = nextWeek();
    const u = await member("lb-noise");
    await seedPicks(u, record(week, 2, 1, ["VOID", "VOID", "VOID", "VOID", "PENDING", "PENDING", "PENDING", "PENDING"]));
    const me = (await board(week, u)).me!;
    expect(me).toMatchObject({ correct: 2, incorrect: 1, decided: 3, ranked: false, needed: 2 });
    expect((await board(week)).entries).toEqual([]);
    // Two more decided picks and the void and pending ones still add nothing to the record.
    await seedPicks(u, record(week + 0, 2, 0).map((p, i) => ({ ...p, startMs: p.startMs + 30 * HOUR + i * HOUR })));
    const b = await board(week, u);
    expect(b.me).toMatchObject({ correct: 4, incorrect: 1, decided: 5, ranked: true, rank: 1 });
    expect(b.entries[0]).toMatchObject({ correct: 4, incorrect: 1, decided: 5, accuracy: 0.8 });
  });

  it("is a weekly question: a hundred lifetime picks do not qualify a Member who made one pick this week", async () => {
    const week = nextWeek();
    const u = await member("lb-lifetime");
    const older = Array.from({ length: 100 }, (_, i) => ({ result: "CORRECT" as Result, startMs: week - 14 * DAY + i * HOUR }));
    await seedPicks(u, [...older, ...record(week, 1, 0)]);
    const b = await board(week, u);
    expect(b.entries).toEqual([]);
    expect(b.me).toMatchObject({ decided: 1, ranked: false, needed: 4 });
  });

  it("starts again every week with no job: last week's qualifier is unranked this week, and the history is untouched", async () => {
    const week = nextWeek();
    const u = await member("lb-reset");
    await seedPicks(u, record(week, 6, 0));
    expect((await board(week)).entries.map((e) => e.display_name)).toEqual(["lb-reset"]);
    const nextMonday = week + 7 * DAY;
    expect((await board(nextMonday, u)).me).toMatchObject({ ranked: false, decided: 0, needed: 5 });
    expect((await board(week)).entries).toHaveLength(1); // the week it was played in is still exactly what it was
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("ranking and ties", () => {
  it("orders by accuracy, then more correct, then fewer incorrect, and numbers the ranks 1, 2, 3 when nobody is level", async () => {
    const week = nextWeek();
    await setWeekly(3);
    const specs: Array<[string, number, number]> = [["a", 3, 0], ["b", 8, 2], ["c", 4, 0], ["d", 6, 4], ["e", 9, 1], ["f", 3, 2]];
    for (const [label, c, i] of specs) await seedPicks(await member(`lb-ord-${label}`), record(week, c, i));
    const b = await board(week);
    // 4–0 and 3–0 are both 100% (more correct first), then 9–1, 8–2; 6–4 and 3–2 are both 60% (more correct first).
    expect(b.entries.map((e) => `${e.correct}-${e.incorrect}`)).toEqual(["4-0", "3-0", "9-1", "8-2", "6-4", "3-2"]);
    expect(b.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(b.entries.every((e) => e.tied === false)).toBe(true);
  });

  it("identical records share a rank (1, 1, 3), say they are tied, and always list the same people in the same order", async () => {
    const week = nextWeek();
    await setWeekly(3);
    const tied = [await member("lb-t1"), await member("lb-t2"), await member("lb-t3")];
    const leader = await member("lb-lead");
    const behind = await member("lb-behind");
    for (const id of tied) await seedPicks(id, record(week, 4, 1));
    await seedPicks(leader, record(week, 5, 0));
    await seedPicks(behind, record(week, 3, 2));
    const first = await board(week, tied[1]);
    expect(first.entries.map((e) => [e.rank, e.tied])).toEqual([[1, false], [2, true], [2, true], [2, true], [5, false]]);
    expect(first.me).toMatchObject({ ranked: true, rank: 2 });
    // The same request, again and again, is the same board: the tie is broken by Member id, never by chance.
    const ids = first.entries.map((e) => e.user_id);
    for (let n = 0; n < 4; n += 1) expect((await board(week, tied[1])).entries.map((e) => e.user_id)).toEqual(ids);
    const tiedIds = first.entries.filter((e) => e.tied).map((e) => e.user_id);
    expect(tiedIds).toEqual([...tiedIds].sort());
  });

  it("does not reward volume at zero: 0–3 is above 0–5", async () => {
    const week = nextWeek();
    await setWeekly(3);
    const few = await member("lb-zero3");
    const many = await member("lb-zero5");
    await seedPicks(few, record(week, 0, 3));
    await seedPicks(many, record(week, 0, 5));
    const b = await board(week);
    expect(b.entries.map((e) => [e.display_name, e.rank])).toEqual([["lb-zero3", 1], ["lb-zero5", 2]]);
  });

  it("lists the configured top N, and a Member outside it still sees their own position, record and total", async () => {
    const week = nextWeek();
    await setWeekly(3, 3);
    const ids: string[] = [];
    for (let k = 0; k < 6; k += 1) {
      ids.push(await member(`lb-top-${k}`));
      await seedPicks(ids[k], record(week, 10 - k, k === 0 ? 0 : 2)); // 10–0, 8–2 (80%), 7–2, 6–2, 5–2, 4–2
    }
    const b = await board(week, ids[5]);
    expect(b.entries).toHaveLength(3);
    expect(b.raw.top_n).toBe(3);
    expect(b.raw.total_ranked).toBe(6);
    expect(b.me).toMatchObject({ ranked: true, rank: 6, correct: 5, incorrect: 2 });
    expect(b.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    // The caller may ask for a different size; it is bounded.
    expect((await board(week, null, 2)).entries).toHaveLength(2);
    expect((await board(week, null, 1000)).entries).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("who is ranked", () => {
  it("only active players: staff, deactivated and closed accounts are never ranked, and a staff viewer is told so", async () => {
    const week = nextWeek();
    const player = await member("lb-el-player");
    const staff = await member("lb-el-staff", { role: "super_admin" });
    const inactive = await member("lb-el-inactive", { active: false });
    const closed = await member("lb-el-closed", { closed: true });
    const nobody = randomUUID();
    for (const id of [player, staff, inactive, closed]) await seedPicks(id, record(week, 9, 1));
    const b = await board(week, staff);
    expect(b.entries.map((e) => e.user_id)).toEqual([player]);
    expect(b.raw.total_ranked).toBe(1);
    expect(b.me).toEqual({ ranked: false, eligible: false, reason: "not_ranked_account" });
    expect((await board(week, inactive)).me).toMatchObject({ eligible: false });
    expect((await board(week, closed)).me).toMatchObject({ eligible: false });
    expect((await board(week, nobody)).me).toEqual({ ranked: false, eligible: false, reason: "unknown" });
  });

  it("does not apply blocks: a blocked Member and the Member who blocked them both stay on the board (blocking policy is unchanged)", async () => {
    const week = nextWeek();
    const blocker = await member("lb-blocker");
    const blocked = await member("lb-blocked");
    await seedPicks(blocker, record(week, 6, 1));
    await seedPicks(blocked, record(week, 7, 1));
    await admin.from("member_blocks").insert({ blocker_id: blocker, blocked_id: blocked });
    const b = await board(week, blocker);
    expect(b.entries.map((e) => e.user_id).sort()).toEqual([blocker, blocked].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the week", () => {
  const bounds = async (iso: string) => {
    const { data, error } = await admin.rpc("platform_week_bounds", { p_at: iso });
    if (error) throw error;
    const row = (data as Row[])[0];
    return [new Date(row.week_start).toISOString(), new Date(row.week_end).toISOString()];
  };

  it("is Monday 00:00 to the next Monday 00:00 in Costa Rica, the same all year", async () => {
    // Monday 2026-10-26 00:00 CR = 06:00 UTC.
    expect(await bounds("2026-10-26T06:00:00Z")).toEqual(["2026-10-26T06:00:00.000Z", "2026-11-02T06:00:00.000Z"]);
    expect(await bounds("2026-10-26T05:59:59Z")).toEqual(["2026-10-19T06:00:00.000Z", "2026-10-26T06:00:00.000Z"]); // Sunday 23:59:59 in Costa Rica
    expect(await bounds("2026-11-01T23:59:59Z")).toEqual(["2026-10-26T06:00:00.000Z", "2026-11-02T06:00:00.000Z"]);
    expect(await bounds("2026-11-02T05:59:59.999Z")).toEqual(["2026-10-26T06:00:00.000Z", "2026-11-02T06:00:00.000Z"]);
    expect(await bounds("2026-11-02T06:00:00Z")).toEqual(["2026-11-02T06:00:00.000Z", "2026-11-09T06:00:00.000Z"]);
    // Across the months other countries change their clocks, a week is still seven 24-hour days.
    for (const iso of ["2026-03-11T12:00:00Z", "2026-11-04T12:00:00Z"]) {
      const [s, e] = await bounds(iso);
      expect(new Date(e).getTime() - new Date(s).getTime()).toBe(7 * DAY);
      expect(s.endsWith("T06:00:00.000Z")).toBe(true);
    }
  });

  it("counts a pick in the week its GAME was played: Sunday 23:59 is in, Monday 00:00 sharp is next week's", async () => {
    const week = nextWeek();
    const u = await member("lb-boundary");
    const end = week + 7 * DAY;
    await seedPicks(u, [
      { result: "CORRECT", startMs: week }, // Monday 00:00:00.000 — the first instant of the week
      { result: "CORRECT", startMs: end - 60_000 }, // Sunday 23:59
      { result: "CORRECT", startMs: end - 1 }, // the last millisecond
      { result: "INCORRECT", startMs: end }, // Monday 00:00:00.000 — next week
      { result: "INCORRECT", startMs: week - 1 }, // the last millisecond of the week before
    ]);
    await setWeekly(1);
    expect((await board(week, u)).me).toMatchObject({ correct: 3, incorrect: 0 });
    expect((await board(end, u)).me).toMatchObject({ correct: 0, incorrect: 1 });
    expect((await board(week - 7 * DAY, u)).me).toMatchObject({ correct: 0, incorrect: 1 });
  });

  it("a late grading job never moves a Game: Sunday night graded after Monday 00:00 still counts in the week it was played", async () => {
    const week = nextWeek();
    const u = await member("lb-late");
    const end = week + 7 * DAY;
    await setWeekly(1);
    await seedPicks(u, [{ result: "CORRECT", startMs: end - 2 * HOUR, gradedMs: end + 3 * HOUR }]); // played Sunday 22:00, graded Monday 03:00
    expect((await board(week, u)).me).toMatchObject({ correct: 1, decided: 1, ranked: true });
    expect((await board(end, u)).me).toMatchObject({ decided: 0 });
    // And the other way round: a Game played last week and graded THIS week belongs to last week.
    await seedPicks(u, [{ result: "INCORRECT", startMs: week - 2 * HOUR, gradedMs: week + 3 * HOUR }]);
    expect((await board(week, u)).me).toMatchObject({ correct: 1, incorrect: 0 });
    expect((await board(week - 7 * DAY, u)).me).toMatchObject({ correct: 0, incorrect: 1 });
  });

  it("falls back to the grading time only for a pick whose Game is gone", async () => {
    const week = nextWeek();
    const u = await member("lb-nogame");
    await setWeekly(1);
    await seedPicks(u, [{ result: "CORRECT", startMs: week - 30 * DAY, gradedMs: week + 2 * DAY, noGame: true }]);
    expect((await board(week, u)).me).toMatchObject({ correct: 1 });
    expect((await board(week - 7 * DAY, u)).me).toMatchObject({ correct: 0 });
  });

  it("a profile's 'This week' and the board agree about the same Member and the same week", async () => {
    // The current week, because a profile always reads now.
    const { data: now } = await admin.rpc("platform_week_bounds", { p_at: new Date().toISOString() });
    const start = new Date((now as Row[])[0].week_start).getTime();
    const end = new Date((now as Row[])[0].week_end).getTime();
    const u = await member("lb-parity");
    const t = Date.now();
    await seedPicks(u, [
      { result: "CORRECT", startMs: Math.max(start, t - 6 * HOUR), gradedMs: t - 1 * HOUR },
      { result: "INCORRECT", startMs: Math.max(start, t - 5 * HOUR), gradedMs: t - 1 * HOUR },
      { result: "CORRECT", startMs: start - 2 * HOUR, gradedMs: t - 1 * HOUR }, // played LAST week, graded this week: not this week
      { result: "VOID", startMs: Math.max(start, t - 4 * HOUR), gradedMs: t - 1 * HOUR },
      { result: "PENDING", startMs: Math.min(end - 1, t + 2 * HOUR) },
    ]);
    const summary = (await admin.rpc("member_record_summary", { p_user_id: u })).data as Row;
    const { data } = await admin.rpc("get_weekly_leaderboard", { p_viewer_id: u });
    const me = (data as Row).me as Row;
    expect(summary.this_week).toEqual({ correct: 1, incorrect: 1 });
    expect([me.correct, me.incorrect]).toEqual([summary.this_week.correct, summary.this_week.incorrect]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Ref { id: string; c: number; i: number }
/** The ranking written straight from the stated rule, independently of the SQL. */
function reference(members: Ref[], min: number) {
  const ranked = members.filter((m) => m.c + m.i >= min && m.c + m.i > 0);
  // cross-multiplied comparison: exact, no division
  const before = (a: Ref, b: Ref) => {
    const lhs = a.c * (b.c + b.i);
    const rhs = b.c * (a.c + a.i);
    if (lhs !== rhs) return lhs > rhs;
    if (a.c !== b.c) return a.c > b.c;
    return a.i < b.i;
  };
  const same = (a: Ref, b: Ref) => !before(a, b) && !before(b, a);
  ranked.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : a.id < b.id ? -1 : 1));
  return ranked.map((m) => ({ id: m.id, rank: 1 + ranked.filter((o) => before(o, m)).length, tied: ranked.some((o) => o !== m && same(o, m)), c: m.c, i: m.i }));
}

describe("an independent reference", () => {
  it("matches the database on a random population with noise (void, pending, other weeks, staff, deactivated)", async () => {
    const week = nextWeek();
    const rnd = lcg(20261027);
    const min = 4;
    await setWeekly(min, 100);
    const refs: Ref[] = [];
    for (let k = 0; k < 70; k += 1) {
      const kind = k % 17 === 0 ? "staff" : k % 13 === 0 ? "inactive" : "player";
      const id = await member(`lb-ref-${k}`, { role: kind === "staff" ? "super_admin" : undefined, active: kind === "inactive" ? false : undefined });
      const c = Math.floor(rnd() * 11);
      const i = Math.floor(rnd() * 8);
      const specs = [...record(week, c, i, [...Array<Result>(Math.floor(rnd() * 3)).fill("VOID"), ...Array<Result>(Math.floor(rnd() * 3)).fill("PENDING")])];
      specs.push(...record(week - 7 * DAY, Math.floor(rnd() * 6), Math.floor(rnd() * 6)), ...record(week + 7 * DAY, Math.floor(rnd() * 4), 0));
      await seedPicks(id, specs);
      if (kind === "player") refs.push({ id, c, i });
    }
    const expected = reference(refs, min);
    const got = (await board(week, null, 100)).entries.map((e) => ({ id: e.user_id, rank: Number(e.rank), tied: e.tied, c: e.correct, i: e.incorrect }));
    expect(got).toEqual(expected);
    expect(expected.length).toBeGreaterThan(20);
    expect(expected.some((e) => e.tied)).toBe(true);
    // And every Member's own position agrees with the list they are in.
    for (const e of expected.slice(0, 12)) expect((await board(week, e.id)).me).toMatchObject({ ranked: true, rank: e.rank, correct: e.c, incorrect: e.i });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("what is exposed", () => {
  it("is aggregates only: no pick, market, balance, email or private field", async () => {
    const week = nextWeek();
    const u = await member("lb-shape");
    await seedPicks(u, record(week, 6, 1, ["PENDING", "VOID"]));
    const b = await board(week, u);
    expect(Object.keys(b.raw).sort()).toEqual(["entries", "me", "min_decided", "top_n", "total_ranked", "week_end", "week_start"]);
    expect(Object.keys(b.entries[0]).sort()).toEqual(["accuracy", "avatar_url", "correct", "decided", "display_name", "incorrect", "rank", "tied", "user_id", "username"]);
    expect(Object.keys(b.me!).sort()).toEqual(["accuracy", "correct", "decided", "eligible", "incorrect", "needed", "rank", "ranked"]);
    expect(JSON.stringify(b.raw)).not.toMatch(/email|wallet|balance|market|prediction|amount|stake|confidence|pending|void|challenge/i);
  });

  it("parses through the application's fail-closed parser, and the repository makes exactly one call", async () => {
    const week = nextWeek();
    const u = await member("lb-parse");
    await seedPicks(u, record(week, 5, 0));
    const calls: string[] = [];
    const spy = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push(name);
        return admin.rpc(name, { ...args, p_at: mid(week) });
      },
    };
    const parsed = await getWeeklyLeaderboard(u, spy as never);
    expect(calls).toEqual(["get_weekly_leaderboard"]);
    expect(parsed?.entries[0]).toMatchObject({ rank: 1, correct: 5, incorrect: 0, decided: 5, accuracy: 1 });
    expect(parsed?.viewer).toMatchObject({ eligible: true, ranked: true, rank: 1 });
    // A shape that is not exactly what the function returns is refused, never half-trusted.
    expect(parseWeeklyLeaderboard(null)).toBeNull();
    expect(parseWeeklyLeaderboard({ week_start: "x", week_end: "y", min_decided: 5, top_n: 20, total_ranked: 0, entries: [] })).toBeNull();
    const good = (await board(week, u)).raw;
    expect(parseWeeklyLeaderboard({ ...good, entries: [{ ...good.entries[0], decided: 99 }] })).toBeNull();
    expect(parseWeeklyLeaderboard({ ...good, me: { eligible: true, ranked: true, rank: null, correct: 1, incorrect: 0, decided: 1, needed: 0, accuracy: 1 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const created: { weeks: number[] } = { weeks: [] };
const PERF_PREFIX = "lbperf";

async function seedPopulation(count: number, weekStart: number, games = 100): Promise<void> {
  await withDb(async (c) => {
    await c.query(`create temp table perf_users on commit drop as select gen_random_uuid() as id, g from generate_series(1, $1::int) g`, [count]);
    await c.query(
      `insert into public.user_profiles (id, display_name, role, is_active)
       select id, '${PERF_PREFIX}-' || g, 'player', true from perf_users`,
      [],
    );
    await c.query(
      `create temp table perf_games on commit drop as select gen_random_uuid() as fid, gen_random_uuid() as mid, g, to_timestamp(($1::double precision + (g % 7) * 86400000 + (g % 11) * 3600000 + 43200000) / 1000.0) as start_at from generate_series(1, $2::int) g`,
      [weekStart, games],
    );
    await c.query(
      `insert into public.fixtures (id, provider, external_fixture_id, sport, season, home_team_name, away_team_name, scheduled_start_utc, internal_status)
       select fid, 'api_nfl', '${PERF_PREFIX}-' || fid, 'american_football', '2026', 'P Home', 'P Away', start_at, 'COMPLETED' from perf_games`,
      [],
    );
    await c.query(
      `insert into public.markets (id, provider, provider_market_id, question, status, fixture_id, market_template, yes_side, last_synced_at, ingestion_source, provider_metadata)
       select mid, 'lb', '${PERF_PREFIX}-' || mid, 'P?', 'ACTIVE', fid, 'MONEYLINE', 'HOME', now(), 'test', '{}'::jsonb from perf_games`,
      [],
    );
    // Each Member plays a different share of the week's Games (most a few, a few many): about 8 picks a Member on average. Accuracy centred a little above a coin flip, a few voids, none pending.
    await c.query(
      `with activity as (select id, power(random(), 3) * 0.55 as p from perf_users)
       insert into public.predictions (id, user_id, market_id, selected_outcome, market_question_snapshot, market_status_snapshot, lifecycle_state, result, resolved_outcome_snapshot, graded_at, idempotency_key, created_at)
       select gen_random_uuid(), a.id, gm.mid, 'YES', 'P?', 'RESOLVED', 'GRADED', r.result, 'YES', gm.start_at + interval '3 hours', '${PERF_PREFIX}-' || gen_random_uuid(), gm.start_at - interval '1 day'
       from activity a cross join perf_games gm
       cross join lateral (select case when x < 0.03 then 'VOID' when x < 0.03 + 0.97 * 0.56 then 'CORRECT' else 'INCORRECT' end as result from (select random() as x) q) r
       where random() < a.p`,
      [],
    );
  });
}

async function cleanupPerf() {
  await withDb(async (c) => {
    await c.query(`delete from public.predictions where idempotency_key like '${PERF_PREFIX}-%'`);
    await c.query(`delete from public.markets where provider_market_id like '${PERF_PREFIX}-%'`);
    await c.query(`delete from public.fixtures where external_fixture_id like '${PERF_PREFIX}-%'`);
    await c.query(`delete from public.user_profiles where display_name like '${PERF_PREFIX}-%'`);
  });
}
afterAll(cleanupPerf);

describe("scale", () => {
  for (const count of [100, 1000, 10000]) {
    it(`${count.toLocaleString("en-US")} Members with a realistic week: one query, indexed, fast`, async () => {
      await cleanupPerf();
      const week = nextWeek();
      created.weeks.push(week);
      await seedPopulation(count, week);
      const db = new Client({ connectionString: getTestDatabaseUrl() });
      await db.connect();
      try {
        await db.query("analyze public.predictions; analyze public.markets; analyze public.fixtures; analyze public.user_profiles");
        const picks = Number((await db.query(`select count(*) as n from public.predictions where idempotency_key like '${PERF_PREFIX}-%'`)).rows[0].n);
        const viewer = (await db.query(`select id from public.user_profiles where display_name like '${PERF_PREFIX}-%' order by id limit 1`)).rows[0].id as string;
        const at = mid(week);
        const timeIt = async (viewerId: string | null) => {
          const samples: number[] = [];
          let last: Row | null = null;
          for (let n = 0; n < 5; n += 1) {
            const t0 = performance.now();
            const res = await db.query(`select public.get_weekly_leaderboard($1::uuid, null, $2::timestamptz) as r`, [viewerId, at]);
            samples.push(performance.now() - t0);
            last = res.rows[0].r as Row;
          }
          samples.sort((a, b) => a - b);
          return { median: samples[2], max: samples[4], last: last! };
        };
        const withoutViewer = await timeIt(null);
        const withViewer = await timeIt(viewer);
        const plan = (await db.query(`explain (analyze, buffers, format text) select public.get_weekly_leaderboard(null, null, $1::timestamptz)`, [at])).rows.map((r) => Object.values(r)[0] as string).join("\n");

        expect(withoutViewer.last.entries.length).toBeLessThanOrEqual(20);
        expect(withoutViewer.last.total_ranked).toBeGreaterThan(0);
        // The cross-check on a big board too: the top entries are in non-increasing accuracy order with shared ranks.
        const acc = (withoutViewer.last.entries as Row[]).map((e) => e.accuracy as number);
        expect([...acc].sort((a, b) => b - a)).toEqual(acc);
        // Generous ceilings (a shared CI machine): the point is that 10,000 Members is a fraction of a second, not seconds.
        expect(withoutViewer.median).toBeLessThan(count === 10000 ? 2500 : 800);
        expect(withViewer.median).toBeLessThan(count === 10000 ? 3000 : 1000);
        if (process.env.LEADERBOARD_PERF_OUT) {
          appendFileSync(
            process.env.LEADERBOARD_PERF_OUT,
            `${JSON.stringify({ members: count, picksInWeek: picks, topNOnly: { medianMs: Math.round(withoutViewer.median), maxMs: Math.round(withoutViewer.max) }, withViewerPosition: { medianMs: Math.round(withViewer.median), maxMs: Math.round(withViewer.max) }, totalRanked: withoutViewer.last.total_ranked, planTail: plan.split("\n").slice(-4) })}\n`,
          );
        }
      } finally {
        await db.end();
        await cleanupPerf();
      }
    }, 240_000);
  }
});
