/**
 * Grading starvation fix (migration 215): the batch is chosen from the Picks (and accepted Call BS challenges) that can be processed NOW — filter first, order, then limit.
 *   Before: the oldest `grading_batch_size` PENDING Picks were taken whatever their Game was doing, so Picks on unfinished Games filled the batch and Picks on finished Games
 *   behind them were never reached (reproduced on staging: 200 examined, 0 graded).
 * The batch-size setting stays the throughput control; none of the grading, settlement or resolution SEMANTICS changed — only which rows are candidates.
 * Real local Supabase.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedUser, setFixture } from "./helpers/game-seed";
import { listGradeablePendingPredictions, listPendingPredictions } from "@/lib/predictions/repository";
import { listResolvableAcceptedChallenges } from "@/lib/challenges/repository";
import { resetIntegrationWorld } from "./helpers/isolation";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";

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
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
const batch = (n: number) => setSettings({ grading_batch_size: n });
const grade = async () => {
  const s = await runGradingJob(recordGradedPredictionResult);
  return s;
};
const lifecycle = async (predictionId: string) => ((await admin.from("predictions").select("*").eq("id", predictionId).single()).data as Row);

let staffId: string | null = null;
async function superAdmin() {
  if (!staffId) {
    staffId = await seedUser("gcs-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
}
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await admin.rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
}
async function resetConfidencePolicy() {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.platform_settings set confidence_mandatory_since = null, confidence_optional_picks_enabled = false, confidence_optional_first_enabled_at = null where id = true");
    await client.query("commit");
  } finally {
    await client.end();
  }
}
const optionalWorld = async () => {
  await ok("admin_set_confidence_config", { p_admin_id: await superAdmin(), p_config: { confidence_mandatory: true } });
  await ok("admin_set_confidence_optional_picks", { p_admin_id: await superAdmin(), p_enabled: true });
};

beforeEach(async () => {
  // Candidate selection looks at EVERY pending Pick in the database, so each test starts from an empty world (the harness only purges between files).
  await resetIntegrationWorld();
  staffId = null;
  await resetConfidencePolicy();
  await setSettings({
    grading_batch_size: 200, challenge_resolution_batch_size: 200, confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5],
    pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true, fixture_markets_enabled: false, prediction_require_price: true, prediction_allowed_templates: ["MONEYLINE", "SPREAD", "TOTAL"],
  });
});
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});

async function member(label = "g") {
  const id = await seedUser(label);
  await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
async function setPick(userId: string, marketId: string, side: "YES" | "NO", prices: [number | null, number | null] = [0.6, 0.4]) {
  const r = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: side, p_yes_probability: prices[0], p_no_probability: prices[1], p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  expect(r.error, `set_pick: ${r.error?.message}`).toBeNull();
  const d = r.data as { prediction: Row | null; outcome: string };
  expect(d.outcome, "pick outcome").toBe("created");
  return d.prediction!;
}
/** A Game (NBA by default) with a priced MONEYLINE Market and one Pick on it: the unit the starvation scenarios are built from. */
async function pickedGame(opts: { startsInMinutes?: number; template?: "MONEYLINE" | "SPREAD" | "TOTAL"; side?: "YES" | "NO"; sport?: string; lineValue?: number | null } = {}) {
  const g = await seedGame({ sport: opts.sport ?? "basketball", startsInMinutes: opts.startsInMinutes ?? 24 * 60, template: opts.template ?? "MONEYLINE", lineValue: opts.lineValue });
  const m = await member();
  const p = await setPick(m, g.marketId, opts.side ?? "YES");
  return { ...g, memberId: m, predictionId: p.id as string };
}
const complete = (fixtureId: string, home: number, away: number) => setFixture(fixtureId, { internal_status: "COMPLETED", home_score: home, away_score: away });
async function expectReconciled() {
  expect((await ok("confidence_reconcile")) as unknown).toEqual([]);
  expect((await ok("confidence_reconcile_stakes", { p_grace_minutes: 0 })) as unknown).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the starvation, reproduced and fixed", () => {
  it("unfinished Games can no longer consume the batch: a later Pick on a finished Game is graded through a backlog larger than the batch", async () => {
    await batch(3);
    const backlog = [];
    for (let i = 0; i < 6; i++) backlog.push(await pickedGame({ startsInMinutes: 5000 + i }));
    const target = await pickedGame();
    await complete(target.fixtureId, 101, 99); // home wins; YES = HOME -> CORRECT

    // THE OLD SELECTION: the oldest `batch` pending Picks — none of them gradeable. This is the bug.
    const old = await listPendingPredictions(3);
    expect(old.map((p) => p.id)).toEqual(backlog.slice(0, 3).map((b) => b.predictionId));
    expect(old.map((p) => p.id)).not.toContain(target.predictionId);

    // THE NEW SELECTION: only what can be processed, so the target is the candidate.
    expect((await listGradeablePendingPredictions(3)).map((p) => p.id)).toEqual([target.predictionId]);
    const summary = await grade();
    expect(summary).toMatchObject({ examined: 1, graded: 1, failures: [] });
    expect(await lifecycle(target.predictionId)).toMatchObject({ lifecycle_state: "GRADED", result: "CORRECT" });
    // the unfinished Games' Picks were neither touched nor counted against the batch
    for (const b of backlog) expect((await lifecycle(b.predictionId)).lifecycle_state).toBe("PENDING");
  });

  it("a batch of 1 selects one PROCESSABLE Pick, not one arbitrary pending Pick", async () => {
    await batch(1);
    const oldest = await pickedGame({ startsInMinutes: 5000 }); // oldest pending Pick, Game not started
    const target = await pickedGame();
    await complete(target.fixtureId, 90, 100); // away wins -> YES INCORRECT
    expect((await listPendingPredictions(1)).map((p) => p.id)).toEqual([oldest.predictionId]); // old: wasted
    expect((await listGradeablePendingPredictions(1)).map((p) => p.id)).toEqual([target.predictionId]);
    expect(await grade()).toMatchObject({ examined: 1, graded: 1, incorrect: 1 });
    expect((await lifecycle(oldest.predictionId)).lifecycle_state).toBe("PENDING");
  });

  it("the batch size is still the throughput control: with more processable Picks than the batch, exactly the batch is processed per run, in deterministic order, and the next run takes the next", async () => {
    await batch(2);
    // five finished Games whose kickoffs are 100..500 minutes ahead at creation, created OUT of order, so the order we expect is the Game's, not the creation order
    const order = [300, 100, 500, 200, 400];
    const games = [];
    for (const start of order) games.push({ start, ...(await pickedGame({ startsInMinutes: start })) });
    for (const g of games) await complete(g.fixtureId, 100, 90);
    const byStart = [...games].sort((a, b) => a.start - b.start);

    expect((await listGradeablePendingPredictions(2)).map((p) => p.id)).toEqual(byStart.slice(0, 2).map((g) => g.predictionId));
    const r1 = await grade();
    expect([r1.examined, r1.graded]).toEqual([2, 2]);
    const r2 = await grade();
    expect([r2.examined, r2.graded]).toEqual([2, 2]);
    const r3 = await grade();
    expect([r3.examined, r3.graded]).toEqual([1, 1]);
    const r4 = await grade();
    expect([r4.examined, r4.graded]).toEqual([0, 0]); // nothing left: idempotent
    for (const g of games) expect((await lifecycle(g.predictionId)).lifecycle_state).toBe("GRADED");
  });

  it("only actionable terminal states are candidates: scheduled, live, postponed, suspended, abandoned and awarded are not; completed, cancelled and an archived Market are", async () => {
    const statuses = ["NOT_STARTED", "LIVE", "POSTPONED", "SUSPENDED", "ABANDONED", "AWARDED", "COMPLETED", "CANCELLED"] as const;
    const picks: Record<string, string> = {};
    for (const status of statuses) {
      const g = await pickedGame({ startsInMinutes: 24 * 60 });
      if (status === "COMPLETED") await complete(g.fixtureId, 80, 70);
      else if (status !== "NOT_STARTED") await setFixture(g.fixtureId, { internal_status: status, ...(status === "AWARDED" ? { home_score: 3, away_score: 0 } : {}) });
      picks[status] = g.predictionId;
    }
    const archived = await pickedGame({ startsInMinutes: 24 * 60 }); // Game NOT started, Market archived: graded VOID whatever the Game does
    await admin.from("markets").update({ status: "ARCHIVED" }).eq("id", archived.marketId);
    picks.ARCHIVED = archived.predictionId;

    const candidates = (await listGradeablePendingPredictions(50)).map((p) => p.id).sort();
    expect(candidates).toEqual([picks.COMPLETED, picks.CANCELLED, picks.ARCHIVED].sort());
    const summary = await grade();
    expect(summary).toMatchObject({ examined: 3, graded: 3, correct: 1, voided: 2, failures: [] });
    expect(await lifecycle(picks.COMPLETED)).toMatchObject({ result: "CORRECT" });
    expect(await lifecycle(picks.CANCELLED)).toMatchObject({ result: "VOID" });
    expect(await lifecycle(picks.ARCHIVED)).toMatchObject({ result: "VOID" });
    for (const s of ["NOT_STARTED", "LIVE", "POSTPONED", "SUSPENDED", "ABANDONED", "AWARDED"]) expect((await lifecycle(picks[s])).lifecycle_state, s).toBe("PENDING");
  });

  it("an unsafe final (finished with no score, or level in a sport that cannot end level) is not graded, is reported once per Game, and cannot starve ordinary Picks", async () => {
    await batch(1);
    // three OLDER Picks on a finished basketball Game recorded level (an inconsistent provider result): never graded
    const level = await pickedGame({ startsInMinutes: 60, sport: "basketball" });
    await complete(level.fixtureId, 100, 100);
    const noScore = await pickedGame({ startsInMinutes: 70 });
    await setFixture(noScore.fixtureId, { internal_status: "COMPLETED", home_score: null, away_score: null });
    const ordinary = await pickedGame({ startsInMinutes: 24 * 60 });
    await complete(ordinary.fixtureId, 99, 98);

    // with a batch of 1 the ordinary Pick comes first, even though the unsafe ones are older and their Games started earlier
    expect((await listGradeablePendingPredictions(1)).map((p) => p.id)).toEqual([ordinary.predictionId]);
    expect(await grade()).toMatchObject({ graded: 1 });
    expect((await lifecycle(ordinary.predictionId)).lifecycle_state).toBe("GRADED");

    // with spare capacity the unsafe ones ARE still examined, so the operator report still fires; they stay PENDING
    await batch(10);
    const again = await grade();
    expect(again).toMatchObject({ examined: 2, graded: 0, stillPending: 2 });
    expect(again.failures.some((f) => /level/i.test(f.error))).toBe(true);
    expect((await lifecycle(level.predictionId)).lifecycle_state).toBe("PENDING");
    expect((await lifecycle(noScore.predictionId)).lifecycle_state).toBe("PENDING");
  });

  it("a tie in a sport that CAN end level (NFL) is a normal candidate and resolves VOID, as before", async () => {
    const tie = await pickedGame({ sport: "american_football" });
    await complete(tie.fixtureId, 20, 20);
    expect((await listGradeablePendingPredictions(5)).map((p) => p.id)).toEqual([tie.predictionId]);
    expect(await grade()).toMatchObject({ graded: 1, voided: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("production-shaped scale: a real batch of 200 behind a 600-Pick backlog", () => {
  it("600 pending Picks on unfinished Games sit ahead of a handful on finished ones; the default batch grades the finished ones at once", async () => {
    await batch(200);
    // 600 Picks (20 Members x 30 unstarted Games) created with a bulk statement the way a busy week would, all OLDER than the target
    const users: string[] = [];
    for (let i = 0; i < 20; i++) users.push(await member(`bulk${i}`));
    const games: Array<{ fixtureId: string; marketId: string }> = [];
    for (let i = 0; i < 30; i++) games.push(await seedGame({ sport: "basketball", startsInMinutes: 3000 + i }));
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      for (const g of games) {
        await client.query(
          `insert into public.predictions (user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, market_question_snapshot, market_status_snapshot, idempotency_key, created_at)
           select u, $2::uuid, 'YES', 0.6, 0.4, 'q', 'ACTIVE', gen_random_uuid()::text, now() - interval '1 day' from unnest($1::uuid[]) u`,
          [users, g.marketId],
        );
      }
      await client.query("commit");
    } finally {
      await client.end();
    }
    expect((await sql("select count(*)::int n from public.predictions where lifecycle_state = 'PENDING'"))[0].n).toBe(600);

    const finished = [await pickedGame(), await pickedGame(), await pickedGame()];
    for (const f of finished) await complete(f.fixtureId, 77, 70);

    const old = await listPendingPredictions(200);
    expect(old).toHaveLength(200);
    expect(old.filter((p) => finished.some((f) => f.predictionId === p.id))).toHaveLength(0); // the old selection never reaches them

    const candidates = await listGradeablePendingPredictions(200);
    expect(candidates).toHaveLength(3);
    const summary = await grade();
    expect(summary).toMatchObject({ examined: 3, graded: 3, failures: [] });
    expect((await sql("select count(*)::int n from public.predictions where lifecycle_state = 'PENDING'"))[0].n).toBe(600); // the backlog is untouched
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("compatibility: M2, Confidence, Call BS, history", () => {
  it("a price-less MONEYLINE (M2) Pick grades through a backlog, with no price anywhere", async () => {
    await batch(2);
    await setSettings({ fixture_markets_enabled: true, prediction_require_price: false, prediction_allowed_templates: ["MONEYLINE"] });
    const backlog = [await pickedGame({ startsInMinutes: 6000 }), await pickedGame({ startsInMinutes: 6001 }), await pickedGame({ startsInMinutes: 6002 })];
    const { data: fx } = await admin.from("fixtures").insert({ provider: "api_nba", external_fixture_id: `gcs-${randomUUID()}`, sport: "basketball", home_team_name: "H", away_team_name: "A", scheduled_start_utc: new Date(Date.now() + 6 * 3_600_000).toISOString(), internal_status: "NOT_STARTED" }).select("id").single();
    const created = await ok("ensure_fixture_moneyline_markets", { p_fixture_ids: [fx!.id] });
    const marketId = (created as unknown as string[])[0];
    const m = await member();
    const pick = await setPick(m, marketId, "NO", [null, null]);
    expect([pick.yes_probability_snapshot, pick.no_probability_snapshot]).toEqual([null, null]);
    await complete(fx!.id, 90, 100); // away wins; NO correct
    const summary = await grade();
    expect(summary).toMatchObject({ examined: 1, graded: 1, correct: 1 });
    expect(await lifecycle(pick.id)).toMatchObject({ result: "CORRECT", yes_probability_snapshot: null });
    for (const b of backlog) expect((await lifecycle(b.predictionId)).lifecycle_state).toBe("PENDING");
  });

  it("a Confidence-backed Pick settles exactly once through a backlog; the ledger reconciles; a re-run changes nothing", async () => {
    await batch(2);
    await optionalWorld();
    const backlog = [await pickedGame({ startsInMinutes: 7000 }), await pickedGame({ startsInMinutes: 7001 }), await pickedGame({ startsInMinutes: 7002 })];
    const g = await seedGame({ sport: "basketball" });
    const m = await member();
    const pick = await setPick(m, g.marketId, "YES");
    const attach = await ok("confidence_attach_stake", { p_member_id: m, p_prediction_id: pick.id, p_amount: 3, p_idempotency_key: randomUUID() });
    expect(attach.outcome).toBe("attached");
    await complete(g.fixtureId, 110, 100); // YES correct
    const before = (await sql("select count(*)::int n from public.confidence_ledger_entries"))[0].n;
    expect(await grade()).toMatchObject({ examined: 1, graded: 1, correct: 1 });
    const settled = await sql("select entry_type, available_delta, reserved_delta from public.confidence_ledger_entries where member_id = $1 and entry_type = 'PREDICTION_WIN'", [m]);
    expect(settled).toHaveLength(1);
    expect([Number(settled[0].available_delta), Number(settled[0].reserved_delta)]).toEqual([6, -3]); // pg returns bigint as text
    expect((await admin.from("confidence_prediction_stakes").select("*").eq("prediction_id", pick.id).single()).data).toMatchObject({ state: "SETTLED_CORRECT" });
    await expectReconciled();
    // idempotency: nothing graded again, nothing settled twice, no ledger movement
    expect(await grade()).toMatchObject({ examined: 0, graded: 0 });
    expect((await sql("select count(*)::int n from public.confidence_ledger_entries"))[0].n).toBe(before + 1);
    expect((await sql("select count(*)::int n from public.confidence_ledger_entries where member_id = $1 and entry_type in ('PREDICTION_WIN','PREDICTION_LOSS','PREDICTION_RELEASE')", [m]))[0].n).toBe(1);
    for (const b of backlog) expect((await lifecycle(b.predictionId)).lifecycle_state).toBe("PENDING");
    await expectReconciled();
  });

  it("Call BS: an accepted challenge on a finished Game resolves through a backlog of accepted challenges on unfinished Games (grading AND resolution)", async () => {
    await batch(2);
    await setSettings({ challenge_resolution_batch_size: 2 });
    async function acceptedChallenge(startsInMinutes: number) {
      const g = await seedGame({ sport: "basketball", startsInMinutes });
      const a = await member("ca");
      const b = await member("cb");
      const pa = await setPick(a, g.marketId, "YES");
      const pb = await setPick(b, g.marketId, "NO");
      const c = await admin.rpc("call_bs", { p_challenger_user_id: a, p_recipient_prediction_id: pb.id });
      expect(c.error, c.error?.message).toBeNull();
      const acc = await admin.rpc("accept_call_bs", { p_challenge_id: (c.data as Row).id, p_recipient_user_id: b }).single();
      expect(acc.error, acc.error?.message).toBeNull();
      return { ...g, challengeId: (c.data as Row).id as string, pa, pb };
    }
    const backlog = [await acceptedChallenge(6000), await acceptedChallenge(6001), await acceptedChallenge(6002)];
    const target = await acceptedChallenge(24 * 60);
    await complete(target.fixtureId, 100, 90); // YES wins: challenger (a) correct

    // the old resolver selection: the 2 oldest accepted challenges, neither resolvable
    const unresolvable = (await sql("select id from public.challenges where status = 'ACCEPTED' order by accepted_at limit 2")).map((r) => r.id);
    expect(unresolvable).not.toContain(target.challengeId);

    await grade(); // grading first: the target's two Picks are graded despite the backlog (batch 2 > the 2 candidate Picks)
    expect((await listResolvableAcceptedChallenges(2)).map((c) => c.id)).toEqual([target.challengeId]);
    const res = await resolveAcceptedChallenges();
    expect(res).toMatchObject({ examined: 1, resolved: 1, challengerWon: 1, failures: [] });
    expect((await admin.from("challenges").select("*").eq("id", target.challengeId).single()).data).toMatchObject({ status: "RESOLVED", result: "CHALLENGER_WON" });
    for (const b of backlog) expect(((await admin.from("challenges").select("*").eq("id", b.challengeId).single()).data as Row).status).toBe("ACCEPTED");
    // idempotent
    expect(await resolveAcceptedChallenges()).toMatchObject({ examined: 0, resolved: 0 });
  });

  it("historical SPREAD and TOTAL Picks grade from the Game result through a backlog, exactly as before", async () => {
    await batch(2);
    const backlog = [await pickedGame({ startsInMinutes: 8000 }), await pickedGame({ startsInMinutes: 8001 }), await pickedGame({ startsInMinutes: 8002 })];
    const spread = await pickedGame({ template: "SPREAD", lineValue: 3.5, side: "YES" }); // YES = HOME covers +3.5
    const total = await pickedGame({ template: "TOTAL", lineValue: 200.5, side: "YES" }); // YES = OVER
    await complete(spread.fixtureId, 100, 110); // 103.5 < 110 -> NO -> INCORRECT
    await complete(total.fixtureId, 110, 100); // 210 > 200.5 -> YES -> CORRECT
    const summary = await grade();
    expect(summary).toMatchObject({ examined: 2, graded: 2, correct: 1, incorrect: 1 });
    expect(await lifecycle(spread.predictionId)).toMatchObject({ result: "INCORRECT" });
    expect(await lifecycle(total.predictionId)).toMatchObject({ result: "CORRECT" });
    for (const b of backlog) expect((await lifecycle(b.predictionId)).lifecycle_state).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the new selection functions: access and shape", () => {
  it("are executable by the service role only", async () => {
    const rows = await sql<{ fn: string; anon: boolean; auth: boolean; svc: boolean }>(
      `select p.proname fn, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') svc
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('list_gradeable_pending_predictions','list_resolvable_accepted_challenges') order by 1`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r, r.fn).toMatchObject({ anon: false, auth: false, svc: true });
    const anon = getTestAnonClient();
    expect((await anon.rpc("list_gradeable_pending_predictions", { p_limit: 5, p_resolvable_status: "COMPLETED", p_void_status: "CANCELLED", p_level_final_sports: [] })).error).not.toBeNull();
    expect((await anon.rpc("list_resolvable_accepted_challenges", { p_limit: 5 })).error).not.toBeNull();
  });

  it("a limit of 0 or less selects nothing, and a missing level-final list is treated as none", async () => {
    const g = await pickedGame();
    await complete(g.fixtureId, 50, 40);
    expect(await listGradeablePendingPredictions(0)).toEqual([]);
    const r = await admin.rpc("list_gradeable_pending_predictions", { p_limit: -3, p_resolvable_status: "COMPLETED", p_void_status: "CANCELLED" });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([]);
    const r2 = await admin.rpc("list_gradeable_pending_predictions", { p_limit: 5, p_resolvable_status: "COMPLETED", p_void_status: "CANCELLED" });
    expect((r2.data as Row[]).map((x) => x.id)).toEqual([g.predictionId]);
  });
});
