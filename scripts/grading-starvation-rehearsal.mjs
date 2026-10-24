// Grading starvation fix — rehearsal on a LOCAL database shaped like production, with a starvation backlog.
//
//   scripts/grading-starvation-rehearsal.sh orchestrates:  supabase db reset --local --version 20260101000214 (production schema)  ->  seed  ->  backlog  ->  snapshot
//     -> grade with the FIXED code BEFORE migration 215 (must fall back loudly to the old selection: starved, but not broken)  ->  supabase migration up --local (215 only)
//     -> grade + resolve  ->  verify
// Local Supabase only (refuses any other target). Nothing here talks to production; the data is synthetic, in the SHAPE production has, plus a 600-Pick backlog of Picks on
// unfinished Games that are OLDER than every gradeable Pick, at the real default batch of 200.
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import fs from "node:fs";
import crypto from "node:crypto";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.test.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
for (const k of ["TEST_SUPABASE_URL", "TEST_DATABASE_URL"]) {
  if (!/127\.0\.0\.1|localhost/.test(env[k] ?? "")) throw new Error(`refusing to run: ${k} is not the local Supabase`);
}
const admin = createClient(env.TEST_SUPABASE_URL, env.TEST_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const uuid = () => crypto.randomUUID();
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];

async function sql(text, params = []) {
  const c = new pg.Client({ connectionString: env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}
async function sqlReplica(text, params = []) {
  const c = new pg.Client({ connectionString: env.TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    const r = await c.query(text, params);
    await c.query("commit");
    return r.rows;
  } finally {
    await c.end();
  }
}
async function rpc(name, args) {
  const r = await admin.rpc(name, args);
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return r.data;
}

async function user(i) {
  const { data, error } = await admin.auth.admin.createUser({ email: `rehearsal-${i}-${uuid()}@test.local`, password: "rehearsal-password-123", email_confirm: true });
  if (error) throw error;
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: `rehearsal${i}`, role: i === 0 ? "super_admin" : "player", is_active: true });
  await admin.rpc("confidence_bootstrap_member", { p_member_id: data.user.id });
  return data.user.id;
}
async function game({ startsInMinutes = 24 * 60, templates = ["MONEYLINE"] } = {}) {
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ provider: "api_nfl", external_fixture_id: `rehearsal-${uuid()}`, sport: "american_football", home_team_name: "Rehearsal Home", away_team_name: "Rehearsal Away", scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error) throw error;
  const markets = {};
  for (const t of templates) {
    const { data, error: e } = await admin
      .from("markets")
      .insert({ provider: "api_nfl", provider_market_id: `rh_${uuid()}`, question: "Rehearsal?", status: "ACTIVE", fixture_id: fixture.id, market_template: t, yes_side: t === "TOTAL" ? null : "HOME", line_value: t === "MONEYLINE" ? null : t === "TOTAL" ? 47.5 : -2.5, yes_price: 0.6, no_price: 0.4, price_outcome_labels: { yes: "yes", no: "no" }, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "rehearsal" })
      .select("id")
      .single();
    if (e) throw e;
    markets[t] = data.id;
  }
  return { fixtureId: fixture.id, markets };
}
const setPick = (u, m, side) => admin.rpc("set_pick", { p_user_id: u, p_market_id: m, p_selected_outcome: side, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: uuid() }).single();
const compose = (u, m, side, amt) => admin.rpc("create_confidence_prediction", { p_user_id: u, p_market_id: m, p_selected_outcome: side, p_amount: amt, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: uuid() });

async function doSeed() {
  // production's settings (read-only look on 2026-10-23): Confidence and backed Picks on, baseline 50, ladder 1..5, T-10, Call BS on, monetary off
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_daily_claim_amount: 1, confidence_daily_claim_interval_hours: 24, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true, monetary_p2p_enabled: false }).eq("id", true);
  const users = [];
  for (let i = 0; i < 67; i++) users.push(await user(i));
  const owner = users[0];
  const templatesFor = (i) => (i % 4 === 0 ? ["MONEYLINE", "SPREAD", "TOTAL"] : ["MONEYLINE"]);

  // ---- before the mandatory cutover: 43 unstaked (legacy) Picks, some edited, some in Call BS
  const legacyGames = [];
  for (let i = 0; i < 43; i++) legacyGames.push(await game({ templates: templatesFor(i) }));
  let revisions = 0;
  for (let i = 0; i < legacyGames.length; i++) {
    const g = legacyGames[i];
    const mkt = i % 3 === 0 && g.markets.TOTAL ? g.markets.TOTAL : g.markets.MONEYLINE;
    const u = users[1 + (i % 60)];
    const side = pick(["YES", "NO"]);
    await setPick(u, mkt, side);
    if (revisions < 9 && i % 5 === 0) {
      await setPick(u, mkt, side === "YES" ? "NO" : "YES");
      revisions++;
    }
  }
  // 6 Call BS: 4 accepted, 1 pending, 1 expired
  const challengeIds = [];
  for (let k = 0; k < 6; k++) {
    const g = await game();
    const a = users[61 + (k % 3)];
    const b = users[1 + k];
    await setPick(a, g.markets.MONEYLINE, "YES");
    const bp = await setPick(b, g.markets.MONEYLINE, "NO");
    const c = await rpc("call_bs", { p_challenger_user_id: a, p_recipient_prediction_id: bp.data.prediction.id });
    challengeIds.push({ id: c.id, b, g });
    if (k < 4) await rpc("accept_call_bs", { p_challenge_id: c.id, p_recipient_user_id: b });
  }
  await sql("update public.fixtures set scheduled_start_utc = now() + interval '5 minutes' where id = $1", [challengeIds[5].g.fixtureId]);
  await admin.rpc("expire_stale_challenges", { p_limit: 50 });

  // ---- the mandatory cutover (production: 2026-10-17)
  await rpc("admin_set_confidence_config", { p_admin_id: owner, p_config: { confidence_mandatory: true } });

  // ---- production switched optional Picks on after the cutover (M1 activation): a few optional-era Picks, unstaked and staked
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: true });
  for (let i = 0; i < 4; i++) {
    const g = await game();
    const u = users[40 + i];
    const made = await setPick(u, g.markets.MONEYLINE, pick(["YES", "NO"]));
    if (i % 2 === 0) await rpc("confidence_attach_stake", { p_member_id: u, p_prediction_id: made.data.prediction.id, p_amount: 1 + i, p_idempotency_key: uuid() });
  }
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: false });

  // ---- after it: 48 backed Picks
  const backedGames = [];
  for (let i = 0; i < 48; i++) {
    const g = await game({ templates: templatesFor(i) });
    backedGames.push(g);
    const u = users[1 + ((i * 7) % 65)];
    const r = await compose(u, g.markets.MONEYLINE, pick(["YES", "NO"]), 1 + Math.floor(rand() * 5));
    if (r.error || r.data.outcome !== "created") throw new Error(`seed compose failed: ${r.error?.message ?? JSON.stringify(r.data)}`);
  }

  // ---- results: complete a number of Games and grade their Picks the way the grading job does (PENDING -> GRADED; the settlement trigger settles any stake)
  const toGrade = [...legacyGames.slice(0, 20), ...backedGames.slice(0, 30)];
  let voided = 0;
  for (const g of toGrade) {
    await sqlReplica("update public.fixtures set internal_status = 'COMPLETED', home_score = 24, away_score = 20 where id = $1", [g.fixtureId]);
    const resolved = pick(["YES", "NO"]);
    for (const mid of Object.values(g.markets)) {
      const preds = await sql("select id, selected_outcome from public.predictions where market_id = $1 and lifecycle_state = 'PENDING'", [mid]);
      for (const p of preds) {
        if (voided < 1 && p.selected_outcome) {
          voided++;
          await sql("update public.predictions set lifecycle_state = 'GRADED', result = 'VOID', resolved_outcome_snapshot = null, graded_at = now() where id = $1", [p.id]);
        } else {
          await sql("update public.predictions set lifecycle_state = 'GRADED', result = $2, resolved_outcome_snapshot = $3, graded_at = now() where id = $1", [p.id, p.selected_outcome === resolved ? "CORRECT" : "INCORRECT", resolved]);
        }
      }
    }
  }
  // two accepted challenges resolved (the shape the resolver leaves)
  const accepted = await sql("select id from public.challenges where status = 'ACCEPTED' order by id limit 2");
  for (const c of accepted) await sqlReplica("update public.challenges set status = 'RESOLVED', result = 'CHALLENGER_WON', resolved_at = now() where id = $1", [c.id]);

  const counts = await sql(
    "select (select count(*) from predictions) predictions, (select count(*) from confidence_prediction_stakes) stakes, (select count(*) from challenges) challenges, (select count(*) from prediction_revisions) revisions, (select count(*) from confidence_accounts) accounts, (select count(*) from confidence_prediction_stakes where state <> 'RESERVED') settled",
  );
  console.log(JSON.stringify({ seeded: counts[0] }));
}



const TABLES = ["predictions", "prediction_revisions", "confidence_accounts", "confidence_ledger_entries", "confidence_prediction_stakes", "challenges", "markets", "fixtures"];
async function snapshot() {
  const out = {};
  for (const t of TABLES) out[t] = (await sql(`select count(*)::int n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') h from public.${t} t`))[0];
  out.pending = (await sql("select count(*)::int n from public.predictions where lifecycle_state = 'PENDING'"))[0].n;
  out.accepted = (await sql("select count(*)::int n from public.challenges where status = 'ACCEPTED'"))[0].n;
  out.gradedIds = (await sql("select id from public.predictions where lifecycle_state = 'GRADED' order by id")).map((r) => r.id);
  out.reconcile = (await sql("select count(*)::int n from public.confidence_reconcile_stakes()"))[0].n;
  return out;
}
const TARGETS = "/tmp/grading-rehearsal-targets.json";

/** 600 pending Picks on 30 unfinished Games (OLDER than everything else) + a set of newer Picks on finished Games of every kind the grader handles. */
async function doBacklog() {
  await admin.from("platform_settings").update({ grading_batch_size: 200, challenge_resolution_batch_size: 200 }).eq("id", true);
  const users = (await sql("select id from public.user_profiles where role = 'player' order by id limit 20")).map((r) => r.id);
  const games = [];
  for (let i = 0; i < 30; i++) games.push(await game({ startsInMinutes: 6000 + i }));
  for (const g of games) {
    await sqlReplica(
      `insert into public.predictions (user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, market_question_snapshot, market_status_snapshot, idempotency_key, created_at)
       select u, $2::uuid, 'YES', 0.6, 0.4, 'q', 'ACTIVE', gen_random_uuid()::text, now() - interval '2 days' from unnest($1::uuid[]) u`,
      [users, g.markets.MONEYLINE],
    );
  }
  // gradeable Picks, created AFTER the backlog
  const owner = (await sql("select id from public.user_profiles where role = 'super_admin' limit 1"))[0].id;
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: true });
  const players = (await sql("select id from public.user_profiles where role = 'player' order by id offset 30 limit 20")).map((r) => r.id);
  const targets = { moneyline: [], spread: [], total: [], confidence: [], cancelled: [], challenges: [] };
  const complete = (fixtureId, h, a) => sqlReplica("update public.fixtures set internal_status = 'COMPLETED', home_score = $2, away_score = $3 where id = $1", [fixtureId, h, a]);
  let pi = 0;
  for (let i = 0; i < 6; i++) { const g = await game({ templates: ["MONEYLINE"] }); const p = await setPick(players[pi++], g.markets.MONEYLINE, "YES"); targets.moneyline.push(p.data.prediction.id); await complete(g.fixtureId, 24, 17); }
  for (let i = 0; i < 2; i++) { const g = await game({ templates: ["MONEYLINE", "SPREAD"] }); const p = await setPick(players[pi++], g.markets.SPREAD, "YES"); targets.spread.push(p.data.prediction.id); await complete(g.fixtureId, 24, 17); }
  for (let i = 0; i < 2; i++) { const g = await game({ templates: ["MONEYLINE", "TOTAL"] }); const p = await setPick(players[pi++], g.markets.TOTAL, "NO"); targets.total.push(p.data.prediction.id); await complete(g.fixtureId, 24, 17); }
  for (let i = 0; i < 2; i++) {
    const g = await game({ templates: ["MONEYLINE"] }); const u = players[pi++];
    const p = await setPick(u, g.markets.MONEYLINE, "YES");
    const att = await rpc("confidence_attach_stake", { p_member_id: u, p_prediction_id: p.data.prediction.id, p_amount: 2, p_idempotency_key: uuid() });
    if (att.outcome !== "attached") throw new Error("attach failed");
    targets.confidence.push({ id: p.data.prediction.id, member: u });
    await complete(g.fixtureId, 24, 17);
  }
  { const g = await game({ templates: ["MONEYLINE"] }); const p = await setPick(players[pi++], g.markets.MONEYLINE, "NO"); targets.cancelled.push(p.data.prediction.id); await sqlReplica("update public.fixtures set internal_status = 'CANCELLED' where id = $1", [g.fixtureId]); }
  for (let i = 0; i < 2; i++) {
    const g = await game({ templates: ["MONEYLINE"] }); const a = players[pi++], b = players[pi++];
    await setPick(a, g.markets.MONEYLINE, "YES"); const bp = await setPick(b, g.markets.MONEYLINE, "NO");
    const c = await rpc("call_bs", { p_challenger_user_id: a, p_recipient_prediction_id: bp.data.prediction.id });
    await rpc("accept_call_bs", { p_challenge_id: c.id, p_recipient_user_id: b });
    targets.challenges.push(c.id);
    await complete(g.fixtureId, 24, 17);
  }
  fs.writeFileSync(TARGETS, JSON.stringify(targets));
  const gradeable = targets.moneyline.length + targets.spread.length + targets.total.length + targets.confidence.length + targets.cancelled.length + targets.challenges.length * 2;
  console.log(JSON.stringify({ backlogPending: 600, gradeableTargets: gradeable, pendingTotal: (await sql("select count(*)::int n from public.predictions where lifecycle_state = 'PENDING'"))[0].n }));
}

async function verify(beforePath, stage) {
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const t = JSON.parse(fs.readFileSync(TARGETS, "utf8"));
  const log = [];
  const check = (name, ok, detail = "") => { log.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
  const state = async (id) => (await sql("select lifecycle_state, result from public.predictions where id = $1", [id]))[0];
  const targetIds = [...t.moneyline, ...t.spread, ...t.total, ...t.confidence.map((c) => c.id), ...t.cancelled];
  const now = await snapshot();
  if (stage === "fallback") {
    // fixed code, migration 215 NOT applied yet: grading must keep running on the old selection (starved, loudly), never fail
    const graded = (await Promise.all(targetIds.map(state))).filter((s) => s.lifecycle_state === "GRADED").length;
    check("before 215 the fixed code falls back to the old selection: still starved (the old behaviour), and nothing broke", graded === 0 && now.pending === before.pending);
  } else {
    for (const id of targetIds) { const s = await state(id); if (s.lifecycle_state !== "GRADED") { check(`target ${id} graded`, false, JSON.stringify(s)); } }
    const states = await Promise.all(targetIds.map(state));
    check(`all ${targetIds.length} gradeable Picks (priced MONEYLINE, SPREAD, TOTAL, Confidence-backed, cancelled) graded at once through the 600-Pick backlog`, states.every((s) => s.lifecycle_state === "GRADED"));
    const voids = states.filter((s) => s.result === "VOID").length;
    check("results are right: home-win MONEYLINE / SPREAD (+line) / Confidence-backed YES correct, the cancelled Game VOID and nothing else VOID, every other Pick has a real result", t.moneyline.every((_, i) => states[i].result === "CORRECT") && t.spread.every((_, i) => states[t.moneyline.length + i].result === "CORRECT") && states[states.length - 1].result === "VOID" && voids === 1 && states.every((s) => ["CORRECT", "INCORRECT", "VOID"].includes(s.result)), `${voids} void`);
    const gradeableCount = targetIds.length + t.challenges.length * 2;
    const backlog = (await sql("select count(*)::int n from public.predictions p join public.markets m on m.id = p.market_id join public.fixtures f on f.id = m.fixture_id where p.lifecycle_state = 'PENDING' and f.internal_status = 'NOT_STARTED'"))[0].n;
    check("every Pick on an unfinished Game (the 600 backlog + the seed's own) is untouched: skipped without consuming capacity", backlog === before.pending - gradeableCount, `${backlog} still pending = ${before.pending} - ${gradeableCount}`);
    for (const c of t.confidence) {
      const wins = (await sql("select count(*)::int n from public.confidence_ledger_entries l join public.confidence_prediction_stakes s on s.id = l.stake_id where s.prediction_id = $1 and l.entry_type = 'PREDICTION_WIN'", [c.id]))[0].n;
      const st = (await sql("select state from public.confidence_prediction_stakes where prediction_id = $1", [c.id]))[0].state;
      check("Confidence-backed Pick: stake SETTLED_CORRECT with exactly one settlement entry for that stake", wins === 1 && st === "SETTLED_CORRECT", `${st}, ${wins} entry`);
    }
    const ch = await sql("select status from public.challenges where id = any($1::uuid[])", [t.challenges]);
    check("both accepted Call BS challenges resolved", ch.length === 2 && ch.every((c) => c.status === "RESOLVED"));
    check("ledger reconciles", now.reconcile === 0);
    const hist = await sql("select md5(string_agg(p::text, '|' order by p::text)) h, count(*)::int n from public.predictions p where p.id = any($1::uuid[])", [before.gradedIds]);
    check("every row that was already GRADED before is byte-identical", hist[0].n === before.gradedIds.length && hist[0].h === before.gradedHash, `${hist[0].n} rows`);
  }
  const failed = log.filter((l) => !l.ok);
  console.log(JSON.stringify({ rehearsal: failed.length === 0 ? "PASS" : "FAIL", stage, checks: log.length, failed: failed.map((f) => f.name) }));
  process.exit(failed.length ? 1 : 0);
}
async function doSnapshot() {
  const s = await snapshot();
  s.gradedHash = (await sql("select coalesce(md5(string_agg(p::text, '|' order by p::text)), '') h from public.predictions p where p.lifecycle_state = 'GRADED'"))[0].h;
  console.log(JSON.stringify(s));
}
const priceSetPick = null; void priceSetPick;

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === "seed") await doSeed();
else if (cmd === "backlog") await doBacklog();
else if (cmd === "snapshot") await doSnapshot();
else if (cmd === "verify") await verify(a1, a2);
else throw new Error("usage: seed | backlog | snapshot | verify <before.json> <fallback|fixed>");
