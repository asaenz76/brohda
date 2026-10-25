// Brohda 2.1 M3 — migration rehearsal on a LOCAL database shaped like production (head 215, M1 and M2 active).
//
//   1. supabase db reset --local --version 20260101000215      (the production schema: migrations 1..215)
//   2. node scripts/m3-migration-rehearsal.mjs seed            (production-shaped data: members with Confidence, Games with Posts, Picks, backed Picks, Call BS, a legacy Game Preview)
//   3. node scripts/m3-migration-rehearsal.mjs snapshot > before.json   (row count + checksum of EVERY existing table, over the columns that exist at 215)
//   4. supabase migration up --local                            (applies migration 216 only)
//   5. node scripts/m3-migration-rehearsal.mjs verify before.json       (nothing existing changed; generation and publishing are OFF; the new tables are empty and not client-readable)
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


const NEW_TABLES = ["game_story_config", "game_story_runs", "game_story_evidence", "game_story_claims", "game_story_claim_evidence", "game_story_revisions"];
/** Volatile by nature (job locks, rate limiting, job history): excluded from the checksum comparison. */
const VOLATILE = new Set(["background_jobs", "cron_job_locks", "rate_limits", "provider_request_log", "schema_migrations"]);

async function doSeed() {
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, call_bs_enabled: true }).eq("id", true);
  const users = [];
  for (let i = 0; i < 12; i++) users.push(await user(i));
  const owner = users[0];
  await rpc("admin_set_confidence_config", { p_admin_id: owner, p_config: { confidence_mandatory: true } });
  await rpc("admin_set_confidence_optional_picks", { p_admin_id: owner, p_enabled: true });
  // M2 as in production: Members MONEYLINE-only, fixture Markets on, price not required, ingestion MONEYLINE-only
  await rpc("admin_set_market_policy", { p_admin_id: owner, p_fixture_markets_enabled: true, p_require_price: false, p_allowed_templates: ["MONEYLINE"], p_ingestion_templates: ["MONEYLINE"] });
  const games = [];
  for (let i = 0; i < 10; i++) games.push(await game({ templates: i % 3 === 0 ? ["MONEYLINE", "SPREAD", "TOTAL"] : ["MONEYLINE"], startsInMinutes: 6 * 60 + i * 30 }));
  for (let i = 0; i < games.length; i++) {
    const u = users[1 + (i % 10)];
    const made = await setPick(u, games[i].markets.MONEYLINE, i === 0 ? "NO" : pick(["YES", "NO"]));
    if (i % 2 === 0 && made.data?.prediction?.id) await rpc("confidence_attach_stake", { p_member_id: u, p_prediction_id: made.data.prediction.id, p_amount: 1 + (i % 3), p_idempotency_key: uuid() });
  }
  // an accepted Call BS
  const g = games[0];
  const a = users[11];
  await setPick(a, g.markets.MONEYLINE, "YES");
  const rec = (await admin.from("predictions").select("id, user_id").eq("market_id", g.markets.MONEYLINE).neq("user_id", a).limit(1).single()).data;
  if (rec) {
    const c = await rpc("call_bs", { p_challenger_user_id: a, p_recipient_prediction_id: rec.id });
    await rpc("accept_call_bs", { p_challenge_id: c.id, p_recipient_user_id: rec.user_id });
  }
  // published Posts for every Game, comments, and one legacy Game Preview (the dormant engine's data must be untouched)
  for (const gm of games) await admin.from("posts").insert({ fixture_id: gm.fixtureId, published_at: new Date().toISOString() });
  await admin.rpc("upsert_game_preview", { p_fixture_id: games[1].fixtureId, p_hook: "Legacy preview hook for the rehearsal.", p_body: "A legacy preview body written by the dormant engine before M3 existed.", p_generated_by: "rehearsal", p_reason: "MISSING",
    p_sources: [{ url: "https://www.nfl.com/news/rehearsal", provider: "NFL.com", title: "Rehearsal", published_at: null, retrieved_at: new Date().toISOString(), supports: null }] });
  console.error("seeded", { users: users.length, games: games.length });
}

async function tables() {
  return (await sql("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")).map((r) => r.table_name).filter((t) => !NEW_TABLES.includes(t) && !VOLATILE.has(t));
}
async function hashTable(table, cols) {
  const list = cols.map((c) => `"${c}"`).join(", ");
  const r = await sql(`select count(*)::int as n, coalesce(md5(string_agg(md5(row(${list})::text), '' order by md5(row(${list})::text))), 'empty') as h from public."${table}"`);
  return r[0];
}
async function doSnapshot() {
  const out = { head: (await sql("select max(version) as v from supabase_migrations.schema_migrations"))[0].v, tables: {} };
  for (const t of await tables()) {
    const cols = (await sql("select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position", [t])).map((r) => r.column_name);
    out.tables[t] = { cols, ...(await hashTable(t, cols)) };
  }
  console.log(JSON.stringify(out));
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function doVerify(file) {
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  const head = (await sql("select max(version) as v from supabase_migrations.schema_migrations"))[0].v;
  check("migration head advanced from 215 to 216 (and only that)", before.head === "20260101000215" && head === "20260101000216", `${before.head} → ${head}`);

  // nothing that existed changed
  const changed = [];
  let compared = 0;
  for (const [t, was] of Object.entries(before.tables)) {
    const now = await hashTable(t, was.cols);
    compared++;
    if (now.n !== was.n || now.h !== was.h) changed.push(`${t} (${was.n}→${now.n})`);
  }
  check(`every existing table is identical before and after (${compared} tables, row count + checksum over the original columns)`, changed.length === 0, changed.join(", "));
  const counts = Object.fromEntries(await Promise.all(["predictions", "prediction_revisions", "confidence_prediction_stakes", "confidence_ledger_entries", "confidence_accounts", "challenges", "markets", "fixtures", "posts", "game_previews"].map(async (t) => [t, (await sql(`select count(*)::int as n from public."${t}"`))[0].n])));
  console.log("      counts", JSON.stringify(counts));
  check("the seed was production-shaped (Picks, stakes, ledger, an accepted Call BS, Posts, a legacy Preview all exist)", counts.predictions >= 10 && counts.confidence_prediction_stakes >= 4 && counts.confidence_ledger_entries >= 4 && counts.challenges >= 1 && counts.posts >= 10 && counts.game_previews >= 1);

  // the new objects are inert
  const cfg = (await sql("select generation_enabled, auto_publish_enabled, max_chars, min_score from public.game_story_config where id"))[0];
  check("generation OFF, auto-publish OFF, 300 characters, 80 points", cfg.generation_enabled === false && cfg.auto_publish_enabled === false && cfg.max_chars === 300 && cfg.min_score === 80, JSON.stringify(cfg));
  const empties = await Promise.all(["game_story_runs", "game_story_evidence", "game_story_claims", "game_story_claim_evidence", "game_story_revisions"].map(async (t) => (await sql(`select count(*)::int as n from public.${t}`))[0].n));
  check("the new tables are empty: the migration generated and published nothing", empties.every((n) => n === 0), empties.join(","));
  check("no Post points at a story", (await sql("select count(*)::int as n from public.posts where story_revision_id is not null"))[0].n === 0);
  check("auto-publish is locked off by a CHECK constraint", (await sql("select count(*)::int as n from pg_constraint where conname = 'game_story_auto_publish_locked'"))[0].n === 1);
  check("the one-approved-story and one-active-run unique indexes exist", (await sql("select count(*)::int as n from pg_indexes where indexname in ('game_story_revisions_one_approved','game_story_runs_one_active')"))[0].n === 2);

  // behaviour with everything at its default
  const g = (await sql("select f.id from public.fixtures f join public.posts p on p.fixture_id = f.id limit 1"))[0].id;
  const start = await admin.rpc("start_game_story_run", { p_fixture_id: g, p_trigger: "SCHEDULED", p_admin_id: null });
  check("a run cannot start while generation is off", start.data?.[0]?.outcome === "disabled", JSON.stringify(start.data ?? start.error?.message));
  check("no candidates are offered while generation is off", ((await admin.rpc("game_story_candidates", { p_limit: 10 })).data ?? []).length === 0);

  // privileges
  const priv = await sql(`select
    bool_or(has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'insert')
      or has_table_privilege('authenticated', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'delete')) as client_access
    from unnest(array['game_story_config','game_story_runs','game_story_evidence','game_story_claims','game_story_claim_evidence','game_story_revisions']) as t`);
  check("no client role has any privilege on a story table", priv[0].client_access === false);
  const fn = await sql(`select bool_or(has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) as client_exec,
                               bool_and(has_function_privilege('service_role', p.oid, 'execute')) as service_exec
                        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('start_game_story_run','save_game_story_run_result','approve_game_story_revision','reject_game_story_revision','withdraw_game_story','admin_edit_game_story_revision','complete_game_story_reverification','admin_set_game_story_config','game_story_candidates','game_story_metrics')`);
  check("every story function is service-role only", fn[0].client_exec === false && fn[0].service_exec === true);

  // M1 + M2 behaviour is unchanged
  const policy = (await sql("select fixture_markets_enabled, prediction_require_price, prediction_allowed_templates, market_ingestion_templates, confidence_optional_picks_enabled from public.platform_settings where id"))[0];
  check("M1 and M2 settings are exactly as seeded", policy.fixture_markets_enabled === true && policy.prediction_require_price === false && policy.confidence_optional_picks_enabled === true && JSON.stringify(policy.prediction_allowed_templates) === '["MONEYLINE"]');
  const recon = await rpc("confidence_reconcile", {});
  check("Confidence reconciles", recon.length === 0);
  // Picks still work with the story tables present
  const fresh = await game({ startsInMinutes: 30 * 60 });
  const u = await user(99);
  const made = await setPick(u, fresh.markets.MONEYLINE, "YES");
  check("a new Pick still works", made.data?.outcome === "created");
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ checks: results.length, failed: failed.map((f) => f.name) }));
  process.exit(failed.length ? 1 : 0);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "seed") await doSeed();
else if (cmd === "snapshot") await doSnapshot();
else if (cmd === "verify") await doVerify(arg);
else throw new Error("usage: seed | snapshot | verify <before.json>");
