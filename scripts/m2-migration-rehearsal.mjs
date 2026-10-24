// Brohda 2.1 M2 — migration rehearsal on a LOCAL database shaped like production.
//
//   1. supabase db reset --local --version 20260101000213     (the production schema: migrations 1..213)
//   2. node scripts/m2-migration-rehearsal.mjs seed           (production-shaped data: legacy unstaked Picks, the mandatory cutover, backed Picks, optional-era Picks, challenges, grading, settlement, SPREAD/TOTAL history)
//   3. node scripts/m2-migration-rehearsal.mjs snapshot > before.json
//   4. supabase migration up --local                           (applies migration 214 only)
//   5. node scripts/m2-migration-rehearsal.mjs verify before.json   (defaults preserve behaviour, no historical row changed, M2 target works, rollback needs no down migration)
//
// Local Supabase only (it refuses any other target). Nothing here talks to production: the data is synthetic, in the SHAPE production has.
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


const TABLES = ["predictions", "prediction_revisions", "confidence_accounts", "confidence_ledger_entries", "confidence_prediction_stakes", "challenges", "markets", "fixtures", "audit_logs"];
const NEW_SETTINGS = ["fixture_markets_enabled", "prediction_require_price", "prediction_allowed_templates", "market_ingestion_templates"];
async function snapshot() {
  const out = {};
  for (const t of TABLES) out[t] = (await sql(`select count(*)::int n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') h from public.${t} t`))[0];
  out.settings = (await sql(`select md5((to_jsonb(s)${NEW_SETTINGS.map((c) => ` - '${c}'`).join("")} - 'updated_at' - 'updated_by')::text) h from public.platform_settings s where id = true`))[0].h;
  out.predictionIds = (await sql("select id from public.predictions order by id")).map((r) => r.id);
  out.marketIds = (await sql("select id from public.markets order by id")).map((r) => r.id);
  out.reconcile = (await sql("select count(*)::int n from public.confidence_reconcile_stakes()"))[0].n;
  out.templates = (await sql("select market_template::text t, count(*)::int n from public.markets group by 1 order by 1"));
  out.nullSnapshots = (await sql("select count(*)::int n from public.predictions where yes_probability_snapshot is null"))[0].n;
  return out;
}

async function verify(beforePath) {
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const log = [];
  const check = (name, ok, detail = "") => {
    log.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  };
  const after = await snapshot();

  // (1) applying the migration changed no historical row, and none of the pre-existing settings
  for (const t of TABLES) check(`unchanged after migration: ${t}`, JSON.stringify(before[t]) === JSON.stringify(after[t]), `${after[t].n} rows`);
  check("unchanged after migration: platform_settings (every pre-existing column)", before.settings === after.settings);
  check("no Pick snapshot was nulled by the relaxation", after.nullSnapshots === before.nullSnapshots && after.nullSnapshots === 0, `${after.nullSnapshots} NULL snapshots`);
  check("ledger reconciles", after.reconcile === 0);

  // (2) defaults preserve pre-M2 behaviour exactly
  const s = (await sql("select fixture_markets_enabled f, prediction_require_price r, prediction_allowed_templates a, market_ingestion_templates i from public.platform_settings where id = true"))[0];
  check("defaults: fixture Markets OFF, price required, every template allowed and ingested", s.f === false && s.r === true && s.a.length === 3 && s.i.length === 3);
  const f0 = await fixtureOnly();
  const none = await rpc("ensure_fixture_moneyline_markets", { p_fixture_ids: [f0] });
  check("defaults: asking for a fixture Market creates nothing", none.length === 0 && (await sql("select count(*)::int n from public.markets where fixture_id = $1", [f0]))[0].n === 0);
  const u = (await sql("select id from public.user_profiles where role = 'player' order by id limit 1"))[0].id;
  const owner = (await sql("select id from public.user_profiles where role = 'super_admin' limit 1"))[0].id;
  const g = await game({ templates: ["MONEYLINE", "SPREAD", "TOTAL"] });
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: true }); // production state: optional Picks ON
  const priceless = await priceSetPick(u, g.markets.MONEYLINE, "YES", null, null);
  check("defaults: a price-less Pick is refused exactly as before (the price is required)", priceless.data.outcome === "rejected_price_required");
  const spread = await setPick(u, g.markets.SPREAD, "YES");
  check("defaults: a Pick on SPREAD is still allowed (every template offered)", spread.data.outcome === "created");

  // (3) the M2 target
  await rpc("admin_set_market_policy", { p_admin_id: owner, p_fixture_markets_enabled: true, p_require_price: false, p_allowed_templates: ["MONEYLINE"], p_ingestion_templates: ["MONEYLINE"] });
  const created = await rpc("ensure_fixture_moneyline_markets", { p_fixture_ids: [f0] });
  const row = (await sql("select * from public.markets where fixture_id = $1", [f0]))[0];
  check("M2: the Game gets exactly one canonical MONEYLINE with no price and ingestion's own identity", created.length === 1 && row.yes_price === null && row.no_price === null && row.yes_side === "HOME" && row.market_template === "MONEYLINE");
  check("M2: asking again creates nothing (one per Game)", (await rpc("ensure_fixture_moneyline_markets", { p_fixture_ids: [f0] })).length === 0);
  const free = await priceSetPick(u, row.id, "YES", null, null);
  check("M2: a free Pick without odds is created with NULL snapshots", free.data.outcome === "created" && free.data.prediction.yes_probability_snapshot === null && free.data.prediction.no_probability_snapshot === null);
  const att = await rpc("confidence_attach_stake", { p_member_id: u, p_prediction_id: free.data.prediction.id, p_amount: 2, p_idempotency_key: uuid() });
  check("M2: Confidence attaches to a price-less Pick and locks the team", att.outcome === "attached" && (await setPick(u, row.id, "NO")).data.outcome === "rejected_locked");
  const g2 = await game({ templates: ["MONEYLINE", "SPREAD", "TOTAL"] });
  check("M2: a NEW Pick on SPREAD and on TOTAL is refused by the database", (await setPick(u, g2.markets.SPREAD, "YES")).data.outcome === "rejected_template_not_allowed" && (await setPick(u, g2.markets.TOTAL, "YES")).data.outcome === "rejected_template_not_allowed");
  const histSpread = await sql("select count(*)::int n from public.predictions p join public.markets m on m.id = p.market_id where m.market_template in ('SPREAD','TOTAL') and p.id = any($1::uuid[])", [before.predictionIds]);
  check("M2: historical SPREAD/TOTAL Picks are still there and still read", histSpread[0].n > 0, `${histSpread[0].n} Picks`);

  // (4) rollback is a settings change only
  await rpc("admin_set_market_policy", { p_admin_id: owner, p_fixture_markets_enabled: false, p_require_price: true, p_allowed_templates: ["MONEYLINE", "SPREAD", "TOTAL"], p_ingestion_templates: ["MONEYLINE", "SPREAD", "TOTAL"] });
  const g3 = await game({ templates: ["MONEYLINE", "SPREAD"] });
  check("rollback: SPREAD is offered again and a price-less Pick is refused again", (await setPick(u, g3.markets.SPREAD, "YES")).data.outcome === "created" && (await priceSetPick(u, g3.markets.MONEYLINE, "YES", null, null)).data.outcome === "rejected_price_required");
  check("rollback: the M2-era price-less Pick is untouched and valid", (await sql("select count(*)::int n from public.predictions where id = $1 and yes_probability_snapshot is null", [free.data.prediction.id]))[0].n === 1);

  // (5) after the whole cycle every HISTORICAL row is byte-identical
  const historicalPreds = await sql("select md5(string_agg(p::text, '|' order by p::text)) h, count(*)::int n from public.predictions p where p.id = any($1::uuid[])", [before.predictionIds]);
  check("after the cycle: every historical Pick row is byte-identical", historicalPreds[0].n === before.predictions.n && historicalPreds[0].h === before.predictions.h, `${historicalPreds[0].n} rows`);
  const historicalMarkets = await sql("select md5(string_agg(m::text, '|' order by m::text)) h, count(*)::int n from public.markets m where m.id = any($1::uuid[])", [before.marketIds]);
  check("after the cycle: every historical Market row is byte-identical", historicalMarkets[0].n === before.markets.n && historicalMarkets[0].h === before.markets.h, `${historicalMarkets[0].n} rows`);
  check("after the cycle: ledger reconciles", (await snapshot()).reconcile === 0);
  const failed = log.filter((l) => !l.ok);
  console.log(JSON.stringify({ rehearsal: failed.length === 0 ? "PASS" : "FAIL", checks: log.length, failed: failed.map((f) => f.name) }));
  process.exit(failed.length ? 1 : 0);
}

async function fixtureOnly() {
  const { data, error } = await admin
    .from("fixtures")
    .insert({ provider: "api_nba", external_fixture_id: `rehearsal-${uuid()}`, sport: "basketball", home_team_name: "Rehearsal Home", away_team_name: "Rehearsal Away", scheduled_start_utc: new Date(Date.now() + 6 * 3_600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}
const priceSetPick = (u, m, side, yes, no) => admin.rpc("set_pick", { p_user_id: u, p_market_id: m, p_selected_outcome: side, p_yes_probability: yes, p_no_probability: no, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: uuid() }).single();

const [cmd, arg] = process.argv.slice(2);
if (cmd === "seed") await doSeed();
else if (cmd === "snapshot") console.log(JSON.stringify(await snapshot()));
else if (cmd === "verify") await verify(arg);
else throw new Error("usage: seed | snapshot | verify <before.json>");
