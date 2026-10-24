// Brohda 2.1 M1 — migration rehearsal on a LOCAL database shaped like production.
//
//   1. supabase db reset --local --version 20260101000210     (the production schema: migrations 1..210)
//   2. node scripts/m1-migration-rehearsal.mjs seed           (production-shaped data: legacy unstaked Picks, the mandatory cutover, backed Picks, challenges, grading, settlement)
//   3. node scripts/m1-migration-rehearsal.mjs snapshot > before.json
//   4. supabase migration up --local                           (applies migration 211 only)
//   5. node scripts/m1-migration-rehearsal.mjs verify before.json   (defaults unchanged, no historical row changed, switch on/off, ledger reconciles, rollback needs no down migration)
//
// Local Supabase only (it refuses any other target). Nothing here talks to production: the data is synthetic, in the SHAPE production has (91 Picks: 43 unstaked/legacy + 48 backed, 8 challenges, 9 revisions, 67 accounts).
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
async function snapshot() {
  const out = {};
  for (const t of TABLES) out[t] = (await sql(`select count(*)::int n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') h from public.${t} t`))[0];
  // challenges gain a new allowed reason value only; their rows must be identical
  out.settings = (await sql("select md5((to_jsonb(s) - 'confidence_optional_picks_enabled' - 'confidence_optional_first_enabled_at' - 'confidence_two_step_composer_enabled')::text) h, confidence_mandatory_since from public.platform_settings s where id = true"))[0];
  out.predictionIds = (await sql("select id from public.predictions order by id")).map((r) => r.id);
  out.reconcile = (await sql("select count(*)::int n from public.confidence_reconcile_stakes()"))[0].n;
  out.ledgerVsAccounts = (await sql("select count(*)::int n from public.confidence_accounts a where (a.available, a.reserved) is distinct from ((select coalesce(sum(available_delta),0) from public.confidence_ledger_entries where member_id = a.member_id), (select coalesce(sum(reserved_delta),0) from public.confidence_ledger_entries where member_id = a.member_id))"))[0].n;
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

  // (1) no historical row changed by applying the migration
  for (const t of TABLES) check(`unchanged after migration: ${t}`, JSON.stringify(before[t]) === JSON.stringify(after[t]), `${after[t].n} rows`);
  check("unchanged after migration: platform_settings (all pre-existing columns)", before.settings.h === after.settings.h);
  check("confidence_mandatory_since untouched", new Date(before.settings.confidence_mandatory_since).toISOString() === new Date(after.settings.confidence_mandatory_since).toISOString());
  check("ledger reconciles and the account totals equal the ledger", after.reconcile === 0 && after.ledgerVsAccounts === 0);

  // (2) defaults: today's behaviour holds
  const s = (await sql("select confidence_optional_picks_enabled o, confidence_optional_first_enabled_at f, confidence_two_step_composer_enabled t from public.platform_settings where id = true"))[0];
  check("switch defaults: optional OFF, first-enabled empty, two-step flag OFF", s.o === false && s.f === null && s.t === false);
  const g = await game();
  const u = (await sql("select id from public.user_profiles where role = 'player' limit 1"))[0].id;
  const refused = await setPick(u, g.markets.MONEYLINE, "YES");
  check("mandatory contract intact with the switch OFF: set_pick refuses an unbacked Pick", refused.data.outcome === "rejected_backing_required");
  const retired = await rpc("confidence_attach_stake", { p_member_id: u, p_prediction_id: uuid(), p_amount: 1, p_idempotency_key: uuid() });
  check("the separate attach is still retired with the switch OFF", retired.outcome === "retired");
  const made = await compose(u, g.markets.MONEYLINE, "YES", 2);
  check("the one-step Pick + Confidence still works with the switch OFF", made.data?.outcome === "created");
  const c0 = (await rpc("confidence_prediction_capacity", {}));
  // legacy = the 43 unstaked Picks + the 12 Picks inside the six Call BS pairs, all made before the cutover; mandatory era = the 48 backed Picks + the one made just above
  check("era split before activation: 55 legacy (all unstaked), mandatory era 49 all backed, optional era empty", c0.eras.legacy.picks === 55 && c0.eras.legacy.unstaked === 55 && c0.eras.mandatory.picks === 49 && c0.eras.mandatory.unstaked === 0 && c0.eras.optional.picks === 0, JSON.stringify(c0.eras));

  // (3) the switch turns behaviour on
  const owner = (await sql("select id from public.user_profiles where role = 'super_admin' limit 1"))[0].id;
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: true });
  const g2 = await game();
  const a = (await sql("select id from public.user_profiles where role = 'player' order by id limit 2 offset 5")).map((r) => r.id);
  const p1 = await setPick(a[0], g2.markets.MONEYLINE, "YES");
  check("switch ON: an unstaked Pick is created, unlocked, no stake", p1.data.outcome === "created" && p1.data.prediction.locked_at === null);
  const p2 = await setPick(a[1], g2.markets.MONEYLINE, "NO");
  const ch = await rpc("call_bs", { p_challenger_user_id: a[0], p_recipient_prediction_id: p2.data.prediction.id });
  const edit = await setPick(a[0], g2.markets.MONEYLINE, "NO");
  const ended = (await sql("select status, expiry_reason from public.challenges where id = $1", [ch.id]))[0];
  check("switch ON: editing the Pick cancels the pending Call BS (EXPIRED / PICK_CHANGED) and reports it", edit.data.outcome === "updated" && ended.status === "EXPIRED" && ended.expiry_reason === "PICK_CHANGED" && edit.data.cancelled_challenge_ids?.[0] === ch.id);
  const att = await rpc("confidence_attach_stake", { p_member_id: a[0], p_prediction_id: p1.data.prediction.id, p_amount: 3, p_idempotency_key: uuid() });
  check("switch ON: Confidence attaches, locks the team and fixes the amount", att.outcome === "attached" && (await setPick(a[0], g2.markets.MONEYLINE, "YES")).data.outcome === "rejected_locked");
  const eras = (await rpc("confidence_prediction_capacity", {})).eras;
  check("era split with optional Picks on: the new Picks are the optional era, history unchanged", eras.optional.picks === 2 && eras.legacy.unstaked === 55 && eras.mandatory.picks === 49 && eras.mandatory.unstaked === 0, JSON.stringify(eras));
  check("reconciliation clean with optional Picks on", (await snapshot()).reconcile === 0);

  // (4) rollback: switch OFF, no down migration
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: false });
  const first = (await sql("select confidence_optional_first_enabled_at f from public.platform_settings where id = true"))[0].f;
  check("rollback: switch OFF keeps the first-enabled instant (nothing cleared, nothing rewritten)", first !== null);
  const g3 = await game();
  check("rollback: new Picks need Confidence again", (await setPick(a[0], g3.markets.MONEYLINE, "YES")).data.outcome === "rejected_backing_required");
  const openUnstaked = await game();
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: true });
  const un = await setPick(a[1], openUnstaked.markets.MONEYLINE, "YES");
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: false });
  check("rollback: an open unstaked Pick stays a valid row", (await sql("select count(*)::int n from public.predictions where id = $1", [un.data.prediction.id]))[0].n === 1);
  check("rollback: it can no longer be edited on its own (rejected_backing_required) …", (await setPick(a[1], openUnstaked.markets.MONEYLINE, "NO")).data.outcome === "rejected_backing_required");
  const done = await compose(a[1], openUnstaked.markets.MONEYLINE, "YES", 1);
  check("rollback: … and is completed by the composer exactly like an earlier open Pick (same row, now backed)", done.data?.outcome === "created" && done.data.predictionId === un.data.prediction.id);

  // (5) after the whole cycle, every HISTORICAL row is still byte-identical
  const end = await snapshot();
  for (const t of ["prediction_revisions", "confidence_accounts"]) void t;
  const historicalPreds = await sql("select md5(string_agg(p::text, '|' order by p::text)) h, count(*)::int n from public.predictions p where p.id = any($1::uuid[])", [before.predictionIds]);
  check("after a full on / activity / off cycle: every historical Pick row is byte-identical", historicalPreds[0].n === before.predictions.n && historicalPreds[0].h === before.predictions.h, `${historicalPreds[0].n} rows`);
  const histRevs = await sql("select md5(coalesce(string_agg(r::text, '|' order by r::text), '')) h, count(*)::int n from public.prediction_revisions r where r.prediction_id = any($1::uuid[])", [before.predictionIds]);
  check("after the cycle: historical revisions are byte-identical", histRevs[0].n === before.prediction_revisions.n && histRevs[0].h === before.prediction_revisions.h);
  check("after the cycle: ledger reconciles", end.reconcile === 0 && end.ledgerVsAccounts === 0);
  const failed = log.filter((l) => !l.ok);
  console.log(JSON.stringify({ rehearsal: failed.length === 0 ? "PASS" : "FAIL", checks: log.length, failed: failed.map((f) => f.name) }));
  process.exit(failed.length ? 1 : 0);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "seed") await doSeed();
else if (cmd === "snapshot") console.log(JSON.stringify(await snapshot()));
else if (cmd === "verify") await verify(arg);
else throw new Error("usage: seed | snapshot | verify <before.json>");
