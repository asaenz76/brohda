/**
 * Brohda 2.1 M5 — a Member's record (migration 218) against the real local Supabase.
 *   - the semantics, checked against an independent JavaScript reference on random sequences: accuracy, void, pending, order by GAME time, current and best streak, this week, sport and season, Confidence;
 *   - Call BS opponents: dedup, exclusions (pending / declined / expired incl. PICK_CHANGED), deterministic order;
 *   - parity with the existing record functions (nothing drifts);
 *   - privacy: the new functions are service-role only;
 *   - the personas Newbie / Casual / Active / Veteran, and the veteran's timing.
 * Rows are seeded straight into the canonical tables (trigger-free, like the suite's own isolation) because the point is to read history, not to replay how it was made.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl, getTestSupabaseConfig } from "./helpers/test-env";
import { seedUser } from "./helpers/game-seed";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getMemberRecord } from "@/lib/member-record/repository";
import { parseMemberRecordSummary } from "@/lib/member-record/format";
import { listUserPredictionsPage } from "@/lib/predictions/repository";

const admin = getTestAdminClient();
const DAY = 86_400_000;

type Result = "CORRECT" | "INCORRECT" | "VOID";
interface PickSpec {
  result: Result | "PENDING";
  /** Days from now the Game is played (negative = in the past). */
  startDays: number;
  /** An exact start time (epoch ms), for tests of the platform-week boundary; wins over startDays. */
  startAtMs?: number;
  gradedDaysAgo?: number;
  sport?: string;
  season?: string | null;
  confidence?: boolean;
}
interface Seeded {
  fixtureId: string;
  marketId: string;
  predictionId: string;
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

/** Graded (or pending) picks, each on its own Game and Market. */
async function seedPicks(userId: string, specs: PickSpec[]): Promise<Seeded[]> {
  const rows = specs.map((s, i) => ({
    i,
    fixtureId: randomUUID(),
    marketId: randomUUID(),
    predictionId: randomUUID(),
    stakeId: randomUUID(),
    result: s.result,
    startMs: s.startAtMs ?? Date.now() + s.startDays * DAY,
    gradedMs: Date.now() - (s.gradedDaysAgo ?? 1) * DAY,
    sport: s.sport ?? "american_football",
    season: s.season === undefined ? "2026" : s.season,
    confidence: Boolean(s.confidence),
  }));
  if (rows.length === 0) return [];
  await withDb(async (c) => {
    for (let at = 0; at < rows.length; at += 500) {
      const chunk = JSON.stringify(rows.slice(at, at + 500));
      await c.query(
        `insert into public.fixtures (id, provider, external_fixture_id, sport, season, home_team_name, away_team_name, scheduled_start_utc, internal_status)
         select x."fixtureId", 'api_nfl', 'm5-' || x."fixtureId", x.sport, x.season, 'M5 Home', 'M5 Away', to_timestamp(x."startMs" / 1000.0), 'COMPLETED' from jsonb_to_recordset($1::jsonb) as x("fixtureId" uuid, sport text, season text, "startMs" double precision)`,
        [chunk],
      );
      await c.query(
        `insert into public.markets (id, provider, provider_market_id, question, status, fixture_id, market_template, yes_side, last_synced_at, ingestion_source, provider_metadata)
         select x."marketId", 'm5', 'm5-' || x."marketId", 'M5?', 'ACTIVE', x."fixtureId", 'MONEYLINE', 'HOME', now(), 'test', '{}'::jsonb from jsonb_to_recordset($1::jsonb) as x("marketId" uuid, "fixtureId" uuid)`,
        [chunk],
      );
      await c.query(
        `insert into public.predictions (id, user_id, market_id, selected_outcome, market_question_snapshot, market_status_snapshot, lifecycle_state, result, resolved_outcome_snapshot, graded_at, idempotency_key, created_at)
         select x."predictionId", $2, x."marketId", 'YES', 'M5?', 'RESOLVED',
                case when x.result = 'PENDING' then 'PENDING' else 'GRADED' end,
                case when x.result = 'PENDING' then null else x.result end,
                case x.result when 'CORRECT' then 'YES' when 'INCORRECT' then 'NO' else null end,
                case when x.result = 'PENDING' then null else to_timestamp(x."gradedMs" / 1000.0) end,
                'm5-' || x."predictionId", to_timestamp(x."startMs" / 1000.0) - interval '1 day'
         from jsonb_to_recordset($1::jsonb) as x("predictionId" uuid, "marketId" uuid, result text, "gradedMs" double precision, "startMs" double precision)`,
        [chunk, userId],
      );
      await c.query(
        `insert into public.confidence_prediction_stakes (id, member_id, prediction_id, market_id, fixture_id, selected_outcome, amount, allowed_stakes_snapshot, state, result, settled_at)
         select x."stakeId", $2, x."predictionId", x."marketId", x."fixtureId", 'YES', 2, array[1,2,3,4,5], 'SETTLED_' || x.result, x.result, now()
         from jsonb_to_recordset($1::jsonb) as x("stakeId" uuid, "predictionId" uuid, "marketId" uuid, "fixtureId" uuid, result text, confidence boolean) where x.confidence and x.result in ('CORRECT','INCORRECT','VOID')`,
        [chunk, userId],
      );
    }
  });
  return rows.map((r) => ({ fixtureId: r.fixtureId, marketId: r.marketId, predictionId: r.predictionId }));
}

interface ChallengeSpec {
  pick: number;
  opponentId: string;
  outcome: "WON" | "LOST" | "VOID";
  status?: "RESOLVED" | "PENDING" | "DECLINED" | "EXPIRED" | "ACCEPTED";
  expiryReason?: string;
  resolvedDaysAgo?: number;
}

/** Challenges where `userId` is the challenger on one of `seeded`'s picks (YES) against an opponent who took NO on the same Market. */
async function seedChallenges(userId: string, seeded: Seeded[], specs: ChallengeSpec[]) {
  const rows = specs.map((s) => ({
    id: randomUUID(),
    oppPick: randomUUID(),
    marketId: seeded[s.pick].marketId,
    myPick: seeded[s.pick].predictionId,
    opponentId: s.opponentId,
    status: s.status ?? "RESOLVED",
    result: s.outcome === "VOID" ? "VOID" : s.outcome === "WON" ? "CHALLENGER_WON" : "RECIPIENT_WON",
    expiryReason: s.expiryReason ?? null,
    resolvedMs: Date.now() - (s.resolvedDaysAgo ?? 1) * DAY,
  }));
  if (rows.length === 0) return;
  await withDb(async (c) => {
    const json = JSON.stringify(rows);
    await c.query(
      `insert into public.predictions (id, user_id, market_id, selected_outcome, market_question_snapshot, market_status_snapshot, lifecycle_state, idempotency_key)
       select x."oppPick", x."opponentId", x."marketId", 'NO', 'M5?', 'ACTIVE', 'PENDING', 'm5-' || x."oppPick" from jsonb_to_recordset($1::jsonb) as x("oppPick" uuid, "opponentId" uuid, "marketId" uuid)
       on conflict do nothing`,
      [json],
    );
    await c.query(
      `insert into public.challenges (id, market_id, challenger_user_id, recipient_user_id, challenger_prediction_id, recipient_prediction_id, challenger_selection_snapshot, recipient_selection_snapshot, status, result, accepted_at, resolved_at, expiry_reason, declined_at)
       select x.id, x."marketId", $2, x."opponentId", x."myPick", x."oppPick", 'YES', 'NO', x.status,
              case when x.status = 'RESOLVED' then x.result else null end,
              case when x.status in ('ACCEPTED','RESOLVED') then now() else null end,
              case when x.status = 'RESOLVED' then to_timestamp(x."resolvedMs" / 1000.0) else null end,
              case when x.status = 'EXPIRED' then x."expiryReason" else null end,
              case when x.status = 'DECLINED' then now() else null end
       from jsonb_to_recordset($1::jsonb) as x(id uuid, "marketId" uuid, "opponentId" uuid, "myPick" uuid, "oppPick" uuid, status text, result text, "resolvedMs" double precision, "expiryReason" text)`,
      [json, userId],
    );
  });
}

// ---------------------------------------------------------------- the independent reference

function reference(specs: PickSpec[]) {
  const graded = specs.filter((s) => s.result !== "PENDING") as Array<PickSpec & { result: Result }>;
  const decided = graded.filter((s) => s.result !== "VOID").sort((a, b) => a.startDays - b.startDays);
  const newestFirst = [...decided].reverse();
  const form = newestFirst.slice(0, 10).map((s) => (s.result === "CORRECT" ? "W" : "L"));
  let current: { kind: Result; length: number } | null = null;
  if (newestFirst.length > 0) {
    const kind = newestFirst[0].result;
    let length = 0;
    for (const s of newestFirst) {
      if (s.result !== kind) break;
      length += 1;
    }
    current = { kind, length };
  }
  let best = 0;
  let run = 0;
  for (const s of decided) {
    run = s.result === "CORRECT" ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const count = (xs: typeof graded, r: Result) => xs.filter((s) => s.result === r).length;
  return {
    correct: count(graded, "CORRECT"),
    incorrect: count(graded, "INCORRECT"),
    void: count(graded, "VOID"),
    form,
    current,
    best,
  };
}

async function summaryOf(userId: string) {
  const { data, error } = await admin.rpc("member_record_summary", { p_user_id: userId, p_form: 10 });
  if (error) throw error;
  return data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// A tiny deterministic generator: the same "random" history every run.
function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

describe("accuracy and void", () => {
  it("counts graded picks only: correct, incorrect and void; a pending pick is nowhere; accuracy ignores void", async () => {
    const u = await seedUser("m5-acc");
    await seedPicks(u, [
      { result: "CORRECT", startDays: -6 },
      { result: "CORRECT", startDays: -5 },
      { result: "CORRECT", startDays: -4 },
      { result: "INCORRECT", startDays: -3 },
      { result: "INCORRECT", startDays: -2 },
      { result: "VOID", startDays: -1 },
      { result: "PENDING", startDays: 2 },
    ]);
    const s = await summaryOf(u);
    expect([s.correct, s.incorrect, s.void]).toEqual([3, 2, 1]);
    // Parity with the existing canonical record: nothing can drift from it.
    const existing = (await admin.rpc("get_user_prediction_record", { p_user_id: u }).single()).data as { correct: number; incorrect: number; void: number; accuracy: number };
    expect([existing.correct, existing.incorrect, existing.void]).toEqual([s.correct, s.incorrect, s.void]);
    expect(Number(existing.accuracy)).toBeCloseTo(3 / 5, 4); // correct / (correct + incorrect), void excluded
  });

  it("a member with no graded pick has an empty record, no streak, and never a fabricated number", async () => {
    const u = await seedUser("m5-new");
    const s = await summaryOf(u);
    expect(s).toMatchObject({ correct: 0, incorrect: 0, void: 0, form: [], current_streak: null, best_correct_streak: 0, by_sport: [], by_season: [] });
    expect(parseMemberRecordSummary(s)).not.toBeNull();
    // Only pending picks: still empty (a pending pick is never part of a record).
    const u2 = await seedUser("m5-pending");
    await seedPicks(u2, [{ result: "PENDING", startDays: 3 }]);
    expect(await summaryOf(u2)).toMatchObject({ correct: 0, incorrect: 0, void: 0, form: [], current_streak: null });
  });
});

describe("form and streaks", () => {
  it("are ordered by when the GAMES were played, not by when grading happened to run; void and pending are ignored", async () => {
    const u = await seedUser("m5-order");
    // Played oldest -> newest: C, I, C, (void), C, C. Graded in a scrambled order on purpose.
    await seedPicks(u, [
      { result: "CORRECT", startDays: -10, gradedDaysAgo: 1 },
      { result: "INCORRECT", startDays: -9, gradedDaysAgo: 5 },
      { result: "CORRECT", startDays: -8, gradedDaysAgo: 2 },
      { result: "VOID", startDays: -7, gradedDaysAgo: 9 },
      { result: "CORRECT", startDays: -6, gradedDaysAgo: 3 },
      { result: "CORRECT", startDays: -5, gradedDaysAgo: 8 },
      { result: "PENDING", startDays: 4 },
    ]);
    const s = await summaryOf(u);
    expect(s.form).toEqual(["W", "W", "W", "L", "W"]); // newest first
    expect(s.current_streak).toEqual({ kind: "CORRECT", length: 3 }); // the void between them neither breaks nor extends it
    expect(s.best_correct_streak).toBe(3);
  });

  it("a miss at the end is a run of misses; an all-void history has no streak", async () => {
    const u = await seedUser("m5-miss");
    await seedPicks(u, [
      { result: "CORRECT", startDays: -4 },
      { result: "INCORRECT", startDays: -3 },
      { result: "INCORRECT", startDays: -2 },
      { result: "VOID", startDays: -1 },
    ]);
    const s = await summaryOf(u);
    expect(s.current_streak).toEqual({ kind: "INCORRECT", length: 2 });
    expect(s.form).toEqual(["L", "L", "W"]);
    const v = await seedUser("m5-allvoid");
    await seedPicks(v, [{ result: "VOID", startDays: -2 }, { result: "VOID", startDays: -1 }]);
    expect(await summaryOf(v)).toMatchObject({ correct: 0, incorrect: 0, void: 2, current_streak: null, form: [] });
  });

  it("matches an independent reference on random histories (form, current streak, best streak, totals)", async () => {
    for (const seed of [1, 7, 42, 2026]) {
      const rnd = lcg(seed);
      const specs: PickSpec[] = Array.from({ length: 60 }, (_, i) => {
        const r = rnd();
        return { result: r < 0.05 ? "PENDING" : r < 0.12 ? "VOID" : r < 0.6 ? "CORRECT" : "INCORRECT", startDays: -90 + i * 1.3 + rnd() * 0.5, gradedDaysAgo: 1 + rnd() * 20 } as PickSpec;
      });
      const u = await seedUser(`m5-ref${seed}`);
      await seedPicks(u, specs);
      const ref = reference(specs);
      const s = await summaryOf(u);
      expect({ correct: s.correct, incorrect: s.incorrect, void: s.void }).toEqual({ correct: ref.correct, incorrect: ref.incorrect, void: ref.void });
      expect(s.form).toEqual(ref.form);
      expect(s.current_streak).toEqual(ref.current ? { kind: ref.current.kind, length: ref.current.length } : null);
      expect(s.best_correct_streak).toBe(ref.best);
    }
  }, 120_000);
});

/** The platform week containing `at`, as the product itself reports it (platform_week_bounds: Monday 00:00 to the next Monday 00:00, America/Costa_Rica) — never recomputed here. Epoch ms. */
async function platformWeek(at: Date = new Date()): Promise<{ start: number; end: number }> {
  const { data, error } = await admin.rpc("platform_week_bounds", { p_at: at.toISOString() });
  if (error) throw error;
  const row = (data as Array<{ week_start: string; week_end: string }>)[0];
  return { start: Date.parse(row.week_start), end: Date.parse(row.week_end) };
}

/**
 * Start times for finished Games placed relative to the platform week containing `now`, so a test means the same thing on a Monday morning and on a Sunday night
 * (a fixture like "two days ago" is last week on a Monday and THIS week on a Wednesday, which is how this suite went red on main).
 *   inWeek     — a Game already played, definitely inside this week (midway between the week's start and now; at Monday 00:00 that is the start itself)
 *   atStart    — a Game starting exactly when the week begins (the week is [start, end): it counts)
 *   justBefore — one second before the week began (it does not)
 *   before     — a day and a half before the week began (last week, whatever the weekday)
 */
function weekFixtureTimes(week: { start: number; end: number }, now: number) {
  return { inWeek: week.start + Math.floor((now - week.start) / 2), atStart: week.start, justBefore: week.start - 1000, before: week.start - 36 * 3_600_000 };
}

/** Runs `fn` with the current platform week, again if the week rolled over while it ran (once a week, for a few milliseconds). */
async function inStablePlatformWeek<T>(fn: (week: { start: number; end: number }, now: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const now = Date.now();
    const week = await platformWeek(new Date(now));
    const out = await fn(week, now);
    if ((await platformWeek()).start === week.start || attempt >= 2) return out;
  }
}

describe("this week, sport, season, Confidence", () => {
  it("this week is the platform week the GAME was played in: a Game this week counts, last week's does not, even when it was graded just now", async () => {
    await inStablePlatformWeek(async (week, now) => {
      const t = weekFixtureTimes(week, now);
      const u = await seedUser("m5-week");
      await seedPicks(u, [
        { result: "CORRECT", startDays: 0, startAtMs: t.inWeek, gradedDaysAgo: 0 },
        // Played last week but graded only now (delayed grading): grading time never moves a Game into another week.
        { result: "INCORRECT", startDays: 0, startAtMs: t.before, gradedDaysAgo: 0 },
        // Played this week but graded long ago (a re-grade, a back-fill): still this week, by its own start.
        { result: "CORRECT", startDays: 0, startAtMs: t.inWeek, gradedDaysAgo: 40 },
      ]);
      const s = await summaryOf(u);
      expect(s.this_week).toEqual({ correct: 2, incorrect: 0 });
      expect([s.correct, s.incorrect]).toEqual([2, 1]); // the lifetime record still holds all three
    });
  });

  it("the week boundary is exact: the instant the week begins counts, one second earlier does not", async () => {
    await inStablePlatformWeek(async (week, now) => {
      const t = weekFixtureTimes(week, now);
      const u = await seedUser("m5-weekedge");
      await seedPicks(u, [
        { result: "CORRECT", startDays: 0, startAtMs: t.atStart, gradedDaysAgo: 0 },
        { result: "INCORRECT", startDays: 0, startAtMs: t.justBefore, gradedDaysAgo: 0 },
      ]);
      const s = await summaryOf(u);
      expect(s.this_week).toEqual({ correct: 1, incorrect: 0 });
    });
  });

  it("the fixtures mean the same thing whatever the weekday: checked against the product's own week for a Monday morning, a Wednesday, and a Sunday night", async () => {
    // Costa Rica is UTC-6 all year. Monday 00:00:00 local, Monday 00:00:01, Wednesday midday, Saturday evening, Sunday 23:59:59.
    const instants = ["2026-10-26T06:00:00Z", "2026-10-26T06:00:01Z", "2026-10-28T18:00:00Z", "2026-10-31T23:00:00Z", "2026-11-02T05:59:59Z"].map((x) => new Date(x));
    for (const at of instants) {
      const week = await platformWeek(at);
      const t = weekFixtureTimes(week, at.getTime());
      const startOf = async (ms: number) => (await platformWeek(new Date(ms))).start;
      expect(t.inWeek, at.toISOString()).toBeLessThanOrEqual(at.getTime()); // already played
      expect(await startOf(t.inWeek), `${at.toISOString()} inWeek`).toBe(week.start);
      expect(await startOf(t.atStart), `${at.toISOString()} atStart`).toBe(week.start);
      expect(await startOf(t.justBefore), `${at.toISOString()} justBefore`).toBeLessThan(week.start);
      expect(await startOf(t.before), `${at.toISOString()} before`).toBeLessThan(week.start);
      // A Sunday-night "now" is still in the week that began the Monday before; the next instant belongs to the next week.
      expect(week.end).toBeGreaterThan(at.getTime());
    }
    const sunday = await platformWeek(instants[4]);
    const monday = await platformWeek(new Date(instants[4].getTime() + 1000));
    expect(monday.start).toBe(sunday.end);
  });

  it("breaks down by sport and by sport-season exactly once per pick, and leaves a missing season out (fail closed)", async () => {
    const u = await seedUser("m5-split");
    await seedPicks(u, [
      { result: "CORRECT", startDays: -30, sport: "american_football", season: "2026" },
      { result: "CORRECT", startDays: -29, sport: "american_football", season: "2026" },
      { result: "INCORRECT", startDays: -28, sport: "american_football", season: "2025" },
      { result: "INCORRECT", startDays: -27, sport: "basketball", season: "2026" },
      { result: "VOID", startDays: -26, sport: "basketball", season: "2026" },
      { result: "CORRECT", startDays: -25, sport: "hockey", season: null },
    ]);
    const s = await summaryOf(u);
    const sport = Object.fromEntries((s.by_sport as any[]).map((r) => [r.sport, [r.correct, r.incorrect, r.void]])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(sport).toEqual({ american_football: [2, 1, 0], basketball: [0, 1, 1], hockey: [1, 0, 0] });
    const total = (Object.values(sport) as number[][]).reduce((n, v) => n + v[0] + v[1] + v[2], 0);
    expect(total).toBe(6); // each pick counted once
    const season = (s.by_season as any[]).map((r) => `${r.sport}:${r.season}:${r.correct}-${r.incorrect}`).sort(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(season).toEqual(["american_football:2025:0-1", "american_football:2026:2-0", "basketball:2026:0-1"]); // hockey has no season -> not guessed
  });

  it("counts Confidence-backed picks as a count with their decided record, never an amount", async () => {
    const u = await seedUser("m5-conf");
    await seedPicks(u, [
      { result: "CORRECT", startDays: -5, confidence: true },
      { result: "INCORRECT", startDays: -4, confidence: true },
      { result: "VOID", startDays: -3, confidence: true },
      { result: "CORRECT", startDays: -2 },
    ]);
    const s = await summaryOf(u);
    expect(s.confidence).toEqual({ picks: 3, correct: 1, incorrect: 1 });
  });
});

describe("Call BS opponents", () => {
  it("counts RESOLVED only, one result per (my pick, opponent), in a deterministic order; matches get_call_bs_record", async () => {
    const me = await seedUser("m5-cb");
    const [a, b, c, d] = await Promise.all([seedUser("m5-oppa"), seedUser("m5-oppb"), seedUser("m5-oppc"), seedUser("m5-oppd")]);
    const picks = await seedPicks(me, Array.from({ length: 8 }, (_, i) => ({ result: "CORRECT" as const, startDays: -20 + i })));
    await seedChallenges(me, picks, [
      { pick: 0, opponentId: a, outcome: "WON", resolvedDaysAgo: 9 },
      { pick: 1, opponentId: a, outcome: "LOST", resolvedDaysAgo: 8 },
      { pick: 2, opponentId: a, outcome: "WON", resolvedDaysAgo: 7 },
      { pick: 3, opponentId: b, outcome: "WON", resolvedDaysAgo: 2 },
      { pick: 4, opponentId: b, outcome: "LOST", resolvedDaysAgo: 3 },
      { pick: 5, opponentId: b, outcome: "VOID", resolvedDaysAgo: 4 },
      { pick: 6, opponentId: c, outcome: "WON", resolvedDaysAgo: 1 },
      // Not counted: pending, declined, expired (including a Pick change), accepted-but-unresolved.
      { pick: 7, opponentId: d, outcome: "WON", status: "PENDING" },
      { pick: 7, opponentId: c, outcome: "WON", status: "DECLINED" },
      { pick: 6, opponentId: d, outcome: "WON", status: "EXPIRED", expiryReason: "PICK_CHANGED" },
      { pick: 5, opponentId: d, outcome: "WON", status: "EXPIRED", expiryReason: "NO_RESPONSE" },
      { pick: 4, opponentId: d, outcome: "WON", status: "ACCEPTED" },
    ]);
    const { data, error } = await admin.rpc("member_call_bs_opponents", { p_user_id: me, p_limit: 10 });
    expect(error).toBeNull();
    const rows = data as Array<{ opponent_id: string; wins: number; losses: number; voids: number; matchups: number }>;
    // Most matchups first; a tie (a and b: 3 each) goes to the most recent; d never appears (nothing of theirs resolved).
    expect(rows.map((r) => [r.opponent_id, r.wins, r.losses, r.voids, r.matchups])).toEqual([
      [b, 1, 1, 1, 3], // most recent result 2 days ago
      [a, 2, 1, 0, 3],
      [c, 1, 0, 0, 1],
    ]);
    const record = (await admin.rpc("get_call_bs_record", { p_user_id: me }).single()).data as { wins: number; losses: number; void: number };
    expect([record.wins, record.losses, record.void]).toEqual([rows.reduce((n, r) => n + r.wins, 0), rows.reduce((n, r) => n + r.losses, 0), rows.reduce((n, r) => n + r.voids, 0)]);
    // From the opponent's side the same matchups read as the mirror image.
    const mirror = (await admin.rpc("member_call_bs_opponents", { p_user_id: a, p_limit: 3 })).data as Array<{ opponent_id: string; wins: number; losses: number }>;
    expect(mirror).toHaveLength(1);
    expect([mirror[0].opponent_id, mirror[0].wins, mirror[0].losses]).toEqual([me, 1, 2]);
  });

  it("collapses repeat resolved challenges between the same pick and opponent into one result", async () => {
    const me = await seedUser("m5-dup");
    const opp = await seedUser("m5-dupopp");
    const picks = await seedPicks(me, [{ result: "CORRECT", startDays: -3 }]);
    await seedChallenges(me, picks, [
      { pick: 0, opponentId: opp, outcome: "WON" },
      { pick: 0, opponentId: opp, outcome: "WON", resolvedDaysAgo: 2 },
    ]);
    const rows = (await admin.rpc("member_call_bs_opponents", { p_user_id: me, p_limit: 3 })).data as Array<{ matchups: number; wins: number }>;
    expect([rows[0].matchups, rows[0].wins]).toEqual([1, 1]);
  });
});

describe("the loader", () => {
  it("returns the record and names the opponents, and leaves out a deactivated opponent", async () => {
    const me = await seedUser("m5-load");
    const opp = await seedUser("m5-loadopp");
    const gone = await seedUser("m5-loadgone");
    const picks = await seedPicks(me, [{ result: "CORRECT", startDays: -3 }, { result: "CORRECT", startDays: -2 }]);
    await seedChallenges(me, picks, [{ pick: 0, opponentId: opp, outcome: "WON" }, { pick: 1, opponentId: gone, outcome: "WON" }]);
    await admin.from("user_profiles").update({ is_active: false }).eq("id", gone);
    const record = (await getMemberRecord(me))!;
    expect(record.summary.correct).toBe(2);
    expect(record.opponents.map((o) => o.opponentId)).toEqual([opp]);
    expect(record.opponents[0]).toMatchObject({ name: "m5-loadopp", wins: 1, losses: 0, matchups: 1 });
  });

  it("rejects a malformed summary instead of trusting it", () => {
    expect(parseMemberRecordSummary(null)).toBeNull();
    expect(parseMemberRecordSummary({ correct: -1 })).toBeNull();
    expect(parseMemberRecordSummary({ correct: 1, incorrect: 0, void: 0, best_correct_streak: 1, form: ["X"], this_week: { correct: 0, incorrect: 0 }, confidence: { picks: 0, correct: 0, incorrect: 0 }, current_streak: null })).toBeNull();
  });
});

describe("history pages", () => {
  it("pages through a Member's predictions in a stable order, graded-only on request, never the whole history", async () => {
    const u = await seedUser("m5-page");
    await seedPicks(u, [
      ...Array.from({ length: 25 }, (_, i) => ({ result: "CORRECT" as const, startDays: -40 + i })),
      { result: "PENDING", startDays: 5 },
    ]);
    const first = await listUserPredictionsPage(u, { limit: 10, offset: 0 });
    const second = await listUserPredictionsPage(u, { limit: 10, offset: 10 });
    const third = await listUserPredictionsPage(u, { limit: 10, offset: 20 });
    expect([first.rows.length, first.hasMore, second.rows.length, second.hasMore, third.rows.length, third.hasMore]).toEqual([10, true, 10, true, 6, false]);
    const ids = [...first.rows, ...second.rows, ...third.rows].map((p) => p.id);
    expect(new Set(ids).size).toBe(26); // no pick twice, none missing
    const graded = await listUserPredictionsPage(u, { limit: 100, offset: 0, gradedOnly: true });
    expect(graded.rows).toHaveLength(25);
    expect(graded.rows.every((p) => p.lifecycleState === "GRADED")).toBe(true);
  });
});

describe("privacy and security", () => {
  it("the record functions are service-role only: no anon or signed-in client can call them", async () => {
    const u = await seedUser("m5-priv");
    const anon = getTestAnonClient();
    expect((await anon.rpc("member_record_summary", { p_user_id: u })).error).not.toBeNull();
    expect((await anon.rpc("member_call_bs_opponents", { p_user_id: u })).error).not.toBeNull();

    const { url, anonKey } = getTestSupabaseConfig();
    const email = `m5-priv-${randomUUID()}@test.local`;
    const created = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
    await admin.from("user_profiles").insert({ id: created.data.user!.id, display_name: "m5priv", role: "player", is_active: true });
    const client = createSupabaseClient(url, anonKey);
    await client.auth.signInWithPassword({ email, password: "integration-test-password-123" });
    expect((await client.rpc("member_record_summary", { p_user_id: u })).error).not.toBeNull();
    expect((await client.rpc("member_call_bs_opponents", { p_user_id: u })).error).not.toBeNull();
    await admin.auth.admin.deleteUser(created.data.user!.id);
  });

  it("exposes only aggregates: no pick id, market, opponent pick, email or wallet field is in the summary", async () => {
    const u = await seedUser("m5-shape");
    await seedPicks(u, [{ result: "CORRECT", startDays: -1, confidence: true }]);
    const s = await summaryOf(u);
    expect(Object.keys(s).sort()).toEqual(["best_correct_streak", "by_season", "by_sport", "confidence", "correct", "current_streak", "form", "incorrect", "this_week", "void"]);
    expect(JSON.stringify(s)).not.toMatch(/email|wallet|balance|market_id|prediction_id|amount/i);
  });
});

describe("personas", () => {
  async function persona(label: string, picks: number, challenges: number, seed: number) {
    const rnd = lcg(seed);
    const user = await seedUser(`m5-${label}`);
    const specs: PickSpec[] = Array.from({ length: picks }, (_, i) => {
      const r = rnd();
      return {
        result: r < 0.08 ? "VOID" : r < 0.55 ? "CORRECT" : "INCORRECT",
        startDays: -400 + (i * 390) / Math.max(1, picks),
        gradedDaysAgo: 1 + rnd() * 30,
        sport: ["american_football", "basketball", "hockey"][Math.floor(rnd() * 3)],
        season: i % 2 === 0 ? "2026" : "2025",
        confidence: rnd() < 0.3,
      } as PickSpec;
    });
    const seeded = await seedPicks(user, specs);
    const opponents = await Promise.all(Array.from({ length: Math.min(12, Math.max(1, challenges)) }, (_, i) => seedUser(`m5-${label}-opp${i}`)));
    const cs: ChallengeSpec[] = Array.from({ length: challenges }, (_, i) => ({ pick: i, opponentId: opponents[i % opponents.length], outcome: (["WON", "LOST", "WON", "VOID"] as const)[i % 4], resolvedDaysAgo: i }));
    await seedChallenges(user, seeded, cs);
    return { user, specs, cs };
  }

  it("Newbie: nothing, honestly", async () => {
    const u = await seedUser("m5-newbie");
    const record = (await getMemberRecord(u))!;
    expect(record.summary).toMatchObject({ correct: 0, incorrect: 0, void: 0, form: [], currentStreak: null });
    expect(record.opponents).toEqual([]);
  });

  it("Casual (10 picks, 1 Call BS): exact record and one opponent", async () => {
    const { user, specs } = await persona("casual", 10, 1, 11);
    const ref = reference(specs);
    const record = (await getMemberRecord(user))!;
    expect([record.summary.correct, record.summary.incorrect, record.summary.void]).toEqual([ref.correct, ref.incorrect, ref.void]);
    expect(record.summary.form).toEqual(ref.form);
    expect(record.opponents).toHaveLength(1);
  });

  it("Active (100 picks, 20 Call BS): exact against the reference; at most three opponents, ordered by matchups", async () => {
    const { user, specs } = await persona("active", 100, 20, 23);
    const ref = reference(specs);
    const record = (await getMemberRecord(user))!;
    expect([record.summary.correct, record.summary.incorrect, record.summary.void]).toEqual([ref.correct, ref.incorrect, ref.void]);
    expect(record.summary.form).toEqual(ref.form);
    expect(record.summary.bestCorrectStreak).toBe(ref.best);
    expect(record.opponents.length).toBeLessThanOrEqual(3);
    const m = record.opponents.map((o) => o.matchups);
    expect([...m].sort((x, y) => y - x)).toEqual(m);
  }, 120_000);

  it("Veteran (1,000 picks, 150 Call BS): exact, paged history, and fast enough that a profile does not notice", async () => {
    const { user, specs, cs } = await persona("veteran", 1000, 150, 99);
    const ref = reference(specs);

    const runs: number[] = [];
    let record = null as Awaited<ReturnType<typeof getMemberRecord>>;
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      record = await getMemberRecord(user);
      runs.push(Math.round(performance.now() - t0));
    }
    runs.sort((a, b) => a - b);
    const r = record!;
    expect([r.summary.correct, r.summary.incorrect, r.summary.void]).toEqual([ref.correct, ref.incorrect, ref.void]);
    expect(r.summary.form).toEqual(ref.form);
    expect(r.summary.currentStreak).toEqual(ref.current ? { kind: ref.current.kind, length: ref.current.length } : null);
    expect(r.summary.bestCorrectStreak).toBe(ref.best);
    // sport and season totals add back up to the whole record: every pick counted once.
    expect(r.summary.bySport.reduce((n, s) => n + s.correct + s.incorrect + s.void, 0)).toBe(1000);
    // Call BS: 150 challenges over 12 opponents; 'WON, LOST, WON, VOID' repeating.
    expect(cs).toHaveLength(150);
    const record2 = (await admin.rpc("get_call_bs_record", { p_user_id: user }).single()).data as { wins: number; losses: number; void: number };
    expect([record2.wins, record2.losses, record2.void]).toEqual([75, 38, 37]);

    // History: a page is 20 rows however long the history is.
    const t1 = performance.now();
    const page = await listUserPredictionsPage(user, { limit: 20, offset: 980 });
    const pageMs = Math.round(performance.now() - t1);
    expect(page.rows.length).toBe(20);

    // The database's own time for the summary (the function body, not the network).
    const db = new Client({ connectionString: getTestDatabaseUrl() });
    await db.connect();
    const explain = await db.query(`explain (analyze, timing off, summary on) select public.member_record_summary($1::uuid, 10)`, [user]);
    const execLine = explain.rows.map((x) => x["QUERY PLAN"] as string).find((l) => l.startsWith("Execution Time")) ?? "";
    await db.end();

    if (process.env.MEMBER_RECORD_PERF_OUT) appendFileSync(process.env.MEMBER_RECORD_PERF_OUT, `veteran (1000 picks, 150 Call BS): getMemberRecord median ${runs[2]} ms (min ${runs[0]}, max ${runs[4]}); history page ${pageMs} ms; function ${execLine}\n`);
    expect(runs[2]).toBeLessThan(1500);
  }, 300_000);
});
