/**
 * Brohda 2.1, Milestone 2 (migration 214): the active product depends on the GAME, not on a sportsbook price.
 *   - a Game gets its ONE canonical MONEYLINE Market without odds (no price, never a substituted one); odds that arrive later enrich the SAME row;
 *   - a Pick without a price is allowed and records NULL snapshots; a priced Pick still records the real ones; the price requirement is a setting;
 *   - Members start new Picks / Call BS only on the allowed templates, enforced in the DATABASE (direct RPC calls cannot bypass it); commitments that already exist are finished;
 *   - grading, Confidence settlement and Call BS resolution never read a price; history and the settings default (= pre-M2 behaviour) are intact.
 * Real local Supabase; only the NFL odds provider module is mocked (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedUser, setFixture } from "./helpers/game-seed";
import type { NormalizedNflFixtureOdds } from "@/lib/sports-data/types";
import { checkMarketEligibility, priceSnapshotFor } from "@/lib/predictions/policy";
import { getPredictionPolicy } from "@/lib/predictions/policy";
import { getMarketPolicy } from "@/lib/prediction-markets/market-policy";
import { getMarketById, listDisplayableMarketsForFixture, upsertMarket } from "@/lib/prediction-markets/repository";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { ensureAndPublishPostForFixture } from "@/lib/posts/publication";
import { getSportConfig } from "@/lib/sports-data/sport-registry";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const getFixtureRawOddsMock = vi.fn<(externalFixtureId: string) => Promise<NormalizedNflFixtureOdds | null>>();
vi.mock("@/lib/sports-data/api-nfl-provider", () => ({
  apiNflProvider: { name: "api_nfl", isEnabled: () => true, getFixtureRawOdds: (...args: [string]) => getFixtureRawOddsMock(...args) },
}));
const { ingestMarketsForFixture } = await import("@/lib/prediction-markets/ingestion/sports");
const { ensureFixtureMarkets } = await import("@/lib/prediction-markets/ingestion/fixture-markets");

const NBA_ENV = { API_NBA_ENABLED: "true" };
const ALL = ["MONEYLINE", "SPREAD", "TOTAL"];

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
const settingsRow = async () => ((await admin.from("platform_settings").select("*").eq("id", true).single()).data as Row);

let staffId: string | null = null;
async function superAdmin() {
  if (!staffId) {
    staffId = await seedUser("m2-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
}
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await admin.rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
}

/** The world M2 is built for: Confidence on, Call BS on, and the M2 policy at its TARGET values. */
async function m2On() {
  await setSettings({
    confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true,
    fixture_markets_enabled: true, prediction_require_price: false, prediction_allowed_templates: ["MONEYLINE"], market_ingestion_templates: ["MONEYLINE"],
  });
}
async function m2Off() {
  await setSettings({ fixture_markets_enabled: false, prediction_require_price: true, prediction_allowed_templates: ALL, market_ingestion_templates: ALL });
}
async function confidenceWorld() {
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true });
}
/** The production-shaped M1 world: the mandatory cutover is set and optional (unstaked) Picks are ON. */
async function optionalWorld() {
  await ok("admin_set_confidence_config", { p_admin_id: await superAdmin(), p_config: { confidence_mandatory: true } });
  await ok("admin_set_confidence_optional_picks", { p_admin_id: await superAdmin(), p_enabled: true });
}

/** Statements run with triggers off — the explicit reset path a real connection has — to put the one-way Confidence cutover and the write-once first-enabled stamp back to a pristine world between tests. */
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

beforeEach(async () => {
  getFixtureRawOddsMock.mockReset();
  await resetConfidencePolicy();
  await m2Off();
  await confidenceWorld();
});
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});

async function member(label = "m2") {
  const id = await seedUser(label);
  await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
const account = async (id: string) => (await admin.from("confidence_accounts").select("*").eq("member_id", id).single()).data as Row;
const pickOf = async (userId: string, marketId: string) => ((await admin.from("predictions").select("*").eq("user_id", userId).eq("market_id", marketId).maybeSingle()).data ?? null) as Row | null;
const stakeOf = async (predictionId: string) => ((await admin.from("confidence_prediction_stakes").select("*").eq("prediction_id", predictionId).maybeSingle()).data ?? null) as Row | null;
const marketsOf = async (fixtureId: string) => ((await admin.from("markets").select("*").eq("fixture_id", fixtureId)).data ?? []) as Row[];

/** A Game with NO Market yet (an NBA Game by default: a plain 48-hour window). */
async function fixtureOnly(opts: { sport?: string; startsInMinutes?: number; homeName?: string; awayName?: string } = {}) {
  const sport = opts.sport ?? "basketball";
  const provider = getSportConfig(sport)!.provider;
  const external = `m2-${randomUUID()}`;
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider, external_fixture_id: external, sport, home_team_name: opts.homeName ?? "M2 Home", away_team_name: opts.awayName ?? "M2 Away",
      scheduled_start_utc: new Date(Date.now() + (opts.startsInMinutes ?? 6 * 60) * 60_000).toISOString(), internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  return { fixtureId: data.id as string, external, provider };
}
async function ensure(fixtureIds: string[]): Promise<string[]> {
  const r = await admin.rpc("ensure_fixture_moneyline_markets", { p_fixture_ids: fixtureIds });
  expect(r.error, r.error?.message).toBeNull();
  return (r.data ?? []) as string[];
}
/** A Game with its price-less canonical MONEYLINE Market, made the way production makes it. */
async function pricelessGame(opts: Parameters<typeof fixtureOnly>[0] = {}) {
  const f = await fixtureOnly(opts);
  const [marketId] = await ensure([f.fixtureId]);
  expect(marketId).toBeTruthy();
  return { ...f, marketId };
}

type PickArgs = { yes?: number | null; no?: number | null; key?: string };
async function rpcSetPick(userId: string, marketId: string, side: "YES" | "NO", a: PickArgs = {}) {
  return admin
    .rpc("set_pick", {
      p_user_id: userId, p_market_id: marketId, p_selected_outcome: side, p_yes_probability: a.yes === undefined ? null : a.yes, p_no_probability: a.no === undefined ? null : a.no,
      p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: a.key ?? randomUUID(),
    })
    .single();
}
async function setPick(userId: string, marketId: string, side: "YES" | "NO", a: PickArgs = {}) {
  const r = await rpcSetPick(userId, marketId, side, a);
  expect(r.error, `set_pick: ${r.error?.message}`).toBeNull();
  return r.data as { prediction: Row | null; outcome: string; cancelled_challenge_ids: string[] | null };
}
async function attach(memberId: string, predictionId: string, amount: number) {
  const r = await admin.rpc("confidence_attach_stake", { p_member_id: memberId, p_prediction_id: predictionId, p_amount: amount, p_idempotency_key: randomUUID() });
  expect(r.error, `attach: ${r.error?.message}`).toBeNull();
  return r.data as Row;
}
const callBs = (challengerId: string, recipientPredictionId: string) => admin.rpc("call_bs", { p_challenger_user_id: challengerId, p_recipient_prediction_id: recipientPredictionId });
async function accept(challengeId: string, recipientId: string) {
  const r = await admin.rpc("accept_call_bs", { p_challenge_id: challengeId, p_recipient_user_id: recipientId }).single();
  expect(r.error, `accept_call_bs: ${r.error?.message}`).toBeNull();
  return r.data as { challenge: Row; outcome: string };
}
async function grade(fixtureId: string, home: number, away: number) {
  await setFixture(fixtureId, { internal_status: "COMPLETED", home_score: home, away_score: away });
  const summary = await runGradingJob(recordGradedPredictionResult);
  expect(summary.failures).toEqual([]);
}
async function expectReconciled() {
  expect((await ok("confidence_reconcile")) as unknown).toEqual([]);
  expect((await ok("confidence_reconcile_stakes", { p_grace_minutes: 0 })) as unknown).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the settings: defaults preserve pre-M2 behaviour, and migration 214 changes nothing by itself", () => {
  it("defaults: fixture markets OFF, price REQUIRED, every template allowed, every template ingested", async () => {
    const s = await settingsRow();
    expect(s.fixture_markets_enabled).toBe(false);
    expect(s.prediction_require_price).toBe(true);
    expect([...s.prediction_allowed_templates].sort()).toEqual([...ALL].sort());
    expect([...s.market_ingestion_templates].sort()).toEqual([...ALL].sort());
    expect(await getMarketPolicy()).toMatchObject({ fixtureMarketsEnabled: false, requirePrice: true });
    expect((await getPredictionPolicy()).requirePrice).toBe(true);
  });

  it("with the flag OFF (the default) nothing is created, even when asked", async () => {
    const f = await fixtureOnly();
    expect(await ensure([f.fixtureId])).toEqual([]);
    expect(await marketsOf(f.fixtureId)).toHaveLength(0);
    const summary = await ensureFixtureMarkets(NBA_ENV);
    expect(summary).toMatchObject({ enabled: false, created: 0 });
    expect(await marketsOf(f.fixtureId)).toHaveLength(0);
  });

  it("the data layer is fail-closed: only real templates, never a NULL element", async () => {
    for (const bad of [["FOO"], ["MONEYLINE", "FOO"], ["MONEYLINE", null]]) {
      const r = await admin.from("platform_settings").update({ prediction_allowed_templates: bad as string[] }).eq("id", true);
      expect(r.error, `allowed ${JSON.stringify(bad)}`).not.toBeNull();
      const i = await admin.from("platform_settings").update({ market_ingestion_templates: bad as string[] }).eq("id", true);
      expect(i.error, `ingestion ${JSON.stringify(bad)}`).not.toBeNull();
    }
    expect((await admin.from("platform_settings").update({ prediction_allowed_templates: [] }).eq("id", true)).error).toBeNull(); // empty = nothing offered, legal
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("a Game gets exactly one canonical MONEYLINE Market, without odds and without a fake price", () => {
  it("creates the Market from the Game: HOME side, ACTIVE, no price, ingestion's own identity", async () => {
    await m2On();
    const f = await fixtureOnly({ homeName: "Home Hawks", awayName: "Away Owls" });
    const created = await ensure([f.fixtureId]);
    expect(created).toHaveLength(1);
    const [m] = await marketsOf(f.fixtureId);
    expect(m).toMatchObject({
      id: created[0], market_template: "MONEYLINE", yes_side: "HOME", line_value: null, status: "ACTIVE", provider: f.provider, provider_market_id: `${f.external}:MONEYLINE`,
      provider_event_id: f.external, question: "Will the Home Hawks win?", ingestion_source: "fixture",
    });
    // Never a substituted value: not null-ish zeros, not 0.5, not -110.
    expect(m.yes_price).toBeNull();
    expect(m.no_price).toBeNull();
    expect(m.price_outcome_labels).toBeNull();
  });

  it("is idempotent and one-per-Game: asking again creates nothing and there is still exactly one", async () => {
    await m2On();
    const f = await fixtureOnly();
    expect(await ensure([f.fixtureId])).toHaveLength(1);
    expect(await ensure([f.fixtureId])).toEqual([]);
    expect(await ensure([f.fixtureId, f.fixtureId])).toEqual([]);
    expect((await marketsOf(f.fixtureId)).filter((m) => m.market_template === "MONEYLINE")).toHaveLength(1);
  });

  it("a second MONEYLINE for the same Game is impossible at the database, on either side and in any state", async () => {
    await m2On();
    const f = await pricelessGame();
    const base = { provider: f.provider, question: "dup", status: "ACTIVE", last_synced_at: new Date().toISOString(), ingestion_source: "test", fixture_id: f.fixtureId, market_template: "MONEYLINE", line_value: null };
    const sameSide = await admin.from("markets").insert({ ...base, provider_market_id: `dup-${randomUUID()}`, yes_side: "HOME" });
    const otherSide = await admin.from("markets").insert({ ...base, provider_market_id: `dup-${randomUUID()}`, yes_side: "AWAY" });
    expect(sameSide.error).not.toBeNull();
    expect(otherSide.error?.message ?? "").toMatch(/markets_one_moneyline_per_fixture|duplicate/);
    // Even once the first row is closed, a Game never gets a second MONEYLINE.
    await admin.from("markets").update({ status: "CLOSED" }).eq("fixture_id", f.fixtureId);
    expect(await ensure([f.fixtureId])).toEqual([]);
    expect((await marketsOf(f.fixtureId)).filter((m) => m.market_template === "MONEYLINE")).toHaveLength(1);
  });

  it("only a Game that can still be Picked qualifies: not started, in the future", async () => {
    await m2On();
    const started = await fixtureOnly();
    await setFixture(started.fixtureId, { internal_status: "LIVE" });
    const past = await fixtureOnly({ startsInMinutes: -30 });
    expect(await ensure([started.fixtureId, past.fixtureId])).toEqual([]);
  });

  it("the market job creates them in one pass for the sport's window, and never outside it", async () => {
    await m2On();
    const inWindow = await fixtureOnly({ startsInMinutes: 6 * 60 });
    const outside = await fixtureOnly({ startsInMinutes: 6 * 24 * 60 }); // far beyond the NBA's 48 h window
    const summary = await ensureFixtureMarkets(NBA_ENV);
    expect(summary.enabled).toBe(true);
    expect(summary.failures).toEqual([]);
    expect(summary.created).toBeGreaterThanOrEqual(1);
    expect(await marketsOf(inWindow.fixtureId)).toHaveLength(1);
    expect(await marketsOf(outside.fixtureId)).toHaveLength(0);
    // Re-running is a no-op (nothing missing any more).
    expect((await ensureFixtureMarkets(NBA_ENV)).created).toBe(0);
  });

  it("a Game without odds can be published as a Post (a canonical Game post does not wait for a price)", async () => {
    await m2On();
    const g = await pricelessGame();
    const published = await ensureAndPublishPostForFixture(g.fixtureId, true);
    expect(published.outcome).toBe("published");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("odds arrive later (or disappear): the same Market, never a second one, and history is never rewritten", () => {
  const nflOdds = (external: string): NormalizedNflFixtureOdds => ({
    externalFixtureId: external,
    providerUpdatedAt: new Date().toISOString(),
    bookmakers: [1, 2].map((i) => ({
      bookmakerId: i, bookmakerName: `book-${i}`, moneyline: [{ value: "Home", odd: 1.5 + i * 0.02 }, { value: "Away", odd: 2.7 - i * 0.02 }], asianHandicap: [],
      gameTotal: [{ value: "Over 44.5", odd: 1.91 }, { value: "Under 44.5", odd: 1.91 }], homeTeamTotal: [], awayTeamTotal: [],
    })),
  });
  const nfl = getSportConfig("american_football")!;
  const asEligible = (f: { fixtureId: string; external: string }) => ({ id: f.fixtureId, externalFixtureId: f.external, homeTeamName: "M2 Home", awayTeamName: "M2 Away" });

  it("enriches the same row: updated, not inserted; a Pick made before the price keeps its NULL snapshot; a later Pick records the real one", async () => {
    await m2On();
    const f = await fixtureOnly({ sport: "american_football" });
    const [marketId] = await ensure([f.fixtureId]);
    const early = await member("early");
    const earlyPick = (await setPick(early, marketId, "YES")).prediction!;
    expect([earlyPick.yes_probability_snapshot, earlyPick.no_probability_snapshot]).toEqual([null, null]);

    getFixtureRawOddsMock.mockResolvedValue(nflOdds(f.external));
    const outcome = await ingestMarketsForFixture(nfl, asEligible(f), 2, ["MONEYLINE"]);
    expect(outcome.moneyline).toBe("updated");
    const rows = (await marketsOf(f.fixtureId)).filter((m) => m.market_template === "MONEYLINE");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(marketId);
    expect(rows[0].yes_price).not.toBeNull();

    // The earlier Pick stays attached and its snapshot stays NULL (Pick-time reality: no price existed).
    expect(await pickOf(early, marketId)).toMatchObject({ id: earlyPick.id, yes_probability_snapshot: null, no_probability_snapshot: null });
    // A Pick made now records the real snapshot, exactly as a pre-M2 Pick did.
    const market = (await getMarketById(marketId))!;
    const snap = priceSnapshotFor(market.yesPrice, market.noPrice, "FRESH", false);
    const late = await member("late");
    const latePick = (await setPick(late, marketId, "NO", { yes: snap.yes, no: snap.no })).prediction!;
    expect(Number(latePick.yes_probability_snapshot)).toBeCloseTo(market.yesPrice!, 6);
    expect(Number(latePick.no_probability_snapshot)).toBeCloseTo(market.noPrice!, 6);
  });

  it("when odds disappear the Market and its last price stay, and Picks stay available (price is enrichment only)", async () => {
    await m2On();
    const f = await fixtureOnly({ sport: "american_football" });
    const [marketId] = await ensure([f.fixtureId]);
    getFixtureRawOddsMock.mockResolvedValue(nflOdds(f.external));
    await ingestMarketsForFixture(nfl, asEligible(f), 2, ["MONEYLINE"]);
    const before = await marketsOf(f.fixtureId);
    getFixtureRawOddsMock.mockResolvedValue(null); // coverage vanishes
    const outcome = await ingestMarketsForFixture(nfl, asEligible(f), 2, ["MONEYLINE"]);
    expect(outcome.moneyline).toBe("skipped-no-data");
    expect(await marketsOf(f.fixtureId)).toEqual(before); // untouched: no deletion, no deactivation, no price overwrite
    // Still pickable with no usable price (policy: require_price = false), recording NULL because none can be trusted as current.
    const m = await member("vanish");
    const pick = (await setPick(m, marketId, "YES")).prediction!;
    expect(pick.id).toBeTruthy();
  });

  it("a price-less Market does not hide its Game from odds requests (the refresh filter only counts priced Markets)", async () => {
    await m2On();
    const { listEligibleFixtures } = await import("@/lib/prediction-markets/ingestion/sports");
    const f = await fixtureOnly({ sport: "basketball", startsInMinutes: 6 * 60 });
    await ensure([f.fixtureId]);
    const cfg = getSportConfig("basketball")!;
    expect(cfg.oddsMinRefreshMinutes).toBeGreaterThan(0);
    const eligible = await listEligibleFixtures(cfg);
    expect(eligible.map((e) => e.id)).toContain(f.fixtureId);
    // Once it carries a fresh price, it is (correctly) skipped for the refresh interval.
    await admin.from("markets").update({ yes_price: 0.6, no_price: 0.4, last_synced_at: new Date().toISOString() }).eq("fixture_id", f.fixtureId);
    expect((await listEligibleFixtures(cfg)).map((e) => e.id)).not.toContain(f.fixtureId);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("ingestion allow-list: the odds request exists only to feed a wanted template", () => {
  const nfl = getSportConfig("american_football")!;
  const odds = (external: string): NormalizedNflFixtureOdds => ({
    externalFixtureId: external,
    providerUpdatedAt: new Date().toISOString(),
    bookmakers: [1, 2].map((i) => ({
      bookmakerId: i, bookmakerName: `book-${i}`, moneyline: [{ value: "Home", odd: 1.5 + i * 0.02 }, { value: "Away", odd: 2.7 - i * 0.02 }], asianHandicap: [],
      gameTotal: [{ value: "Over 44.5", odd: 1.91 }, { value: "Under 44.5", odd: 1.91 }], homeTeamTotal: [], awayTeamTotal: [],
    })),
  });
  const eligible = (f: { fixtureId: string; external: string }) => ({ id: f.fixtureId, externalFixtureId: f.external, homeTeamName: "H", awayTeamName: "A" });

  it("MONEYLINE-only: writes the MONEYLINE, skips TOTAL, deletes nothing", async () => {
    const f = await fixtureOnly({ sport: "american_football" });
    getFixtureRawOddsMock.mockResolvedValue(odds(f.external));
    const out = await ingestMarketsForFixture(nfl, eligible(f), 2, ["MONEYLINE"]);
    expect(out).toMatchObject({ moneyline: "inserted", total: "skipped-template-disabled" });
    const rows = await marketsOf(f.fixtureId);
    expect(rows.map((m) => m.market_template)).toEqual(["MONEYLINE"]);
  });

  it("default (all templates) is today's behaviour: MONEYLINE and TOTAL are written", async () => {
    const f = await fixtureOnly({ sport: "american_football" });
    getFixtureRawOddsMock.mockResolvedValue(odds(f.external));
    const out = await ingestMarketsForFixture(nfl, eligible(f), 2);
    expect(out).toMatchObject({ moneyline: "inserted", total: "inserted" });
    expect((await marketsOf(f.fixtureId)).map((m) => m.market_template).sort()).toEqual(["MONEYLINE", "TOTAL"]);
  });

  it("an empty allow-list makes no provider request at all", async () => {
    const f = await fixtureOnly({ sport: "american_football" });
    const out = await ingestMarketsForFixture(nfl, eligible(f), 2, []);
    expect(out).toMatchObject({ moneyline: "skipped-template-disabled", total: "skipped-template-disabled" });
    expect(getFixtureRawOddsMock).not.toHaveBeenCalled();
    expect(await marketsOf(f.fixtureId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("Picks without a price", () => {
  it("a free Pick without odds is created with NULL snapshots, and the price pair is both-null or both-set", async () => {
    await m2On();
    const g = await pricelessGame();
    const m = await member();
    const r = await setPick(m, g.marketId, "YES");
    expect(r.outcome).toBe("created");
    expect(r.prediction).toMatchObject({ yes_probability_snapshot: null, no_probability_snapshot: null });
    // A half-priced pair is refused (one side NULL, the other not).
    const m2 = await member("half");
    const half = await rpcSetPick(m2, g.marketId, "YES", { yes: 0.6, no: null });
    expect(half.error?.message ?? "").toMatch(/invalid_probability_pair/);
  });

  it("a priced Pick still records the real snapshot", async () => {
    await m2On();
    const g = await pricelessGame();
    const m = await member();
    const r = await setPick(m, g.marketId, "NO", { yes: 0.62, no: 0.38 });
    expect(Number(r.prediction!.yes_probability_snapshot)).toBeCloseTo(0.62, 6);
    expect(Number(r.prediction!.no_probability_snapshot)).toBeCloseTo(0.38, 6);
  });

  it("price required ON (the default): a price-less Pick is refused by the database, as it was before M2", async () => {
    await m2Off();
    const g = await seedGame({ sport: "basketball" });
    const m = await member();
    const r = await setPick(m, g.marketId, "YES");
    expect(r.outcome).toBe("rejected_price_required");
    expect(await pickOf(m, g.marketId)).toBeNull();
    // ...and a priced Pick is exactly as before.
    expect((await setPick(m, g.marketId, "YES", { yes: 0.6, no: 0.4 })).outcome).toBe("created");
  });

  it("price required OFF: the same price-less Pick is accepted", async () => {
    await m2On();
    const g = await seedGame({ sport: "basketball" });
    const m = await member();
    expect((await setPick(m, g.marketId, "YES")).outcome).toBe("created");
  });

  it("the TypeScript eligibility follows the same two policy values", async () => {
    const base = { consumerStatus: "ACTIVE" as const, marketTemplate: "MONEYLINE", closesAt: null, now: new Date() };
    const policy = { allowRepeat: false, cutoffMinutesBeforeClose: 0, allowStalePrice: true, allowUnavailablePrice: false, allowClosedMarket: false, requirePrice: true, allowedTemplates: ["MONEYLINE"] };
    for (const [freshness, yesPrice, noPrice] of [["UNAVAILABLE", null, null], ["UNAVAILABLE", 0.5, 0.5], ["FRESH", null, null]] as const) {
      expect(checkMarketEligibility({ ...base, freshness, yesPrice, noPrice }, policy)).toEqual({ eligible: false, reason: "PRICE_UNAVAILABLE" });
      expect(checkMarketEligibility({ ...base, freshness, yesPrice, noPrice }, { ...policy, requirePrice: false })).toEqual({ eligible: true });
    }
    expect(checkMarketEligibility({ ...base, marketTemplate: "SPREAD", freshness: "FRESH", yesPrice: 0.5, noPrice: 0.5 }, { ...policy, requirePrice: false })).toEqual({ eligible: false, reason: "TEMPLATE_NOT_ALLOWED" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("M1 keeps working on a price-less Market (none of it depends on a price)", () => {
  it("an unstaked Pick is editable until T-10; the edit records a revision with NULL snapshots; still no stake and no ledger movement", async () => {
    await m2On();
    await optionalWorld();
    const g = await pricelessGame();
    const m = await member();
    const created = (await setPick(m, g.marketId, "YES")).prediction!;
    expect(await stakeOf(created.id)).toBeNull();
    const changed = await setPick(m, g.marketId, "NO");
    expect(changed.outcome).toBe("updated");
    const revisions = ((await admin.from("prediction_revisions").select("*").eq("prediction_id", created.id)).data ?? []) as Row[];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ previous_selected_outcome: "YES", new_selected_outcome: "NO", previous_probability_snapshot: null, new_probability_snapshot: null });
    expect(await stakeOf(created.id)).toBeNull();
    expect(((await admin.from("confidence_ledger_entries").select("*").eq("member_id", m).eq("entry_type", "PREDICTION_RESERVE")).data ?? []).length).toBe(0);
  });

  it("T-10 is unchanged: inside the window a price-less Market refuses a new Pick", async () => {
    await m2On();
    await optionalWorld();
    const g = await pricelessGame({ startsInMinutes: 5 });
    const m = await member();
    expect((await setPick(m, g.marketId, "YES")).outcome).toBe("rejected_cutoff");
  });

  it("attaching Confidence reserves exactly the stake, locks the team and fixes the amount", async () => {
    await m2On();
    await optionalWorld();
    const g = await pricelessGame();
    const m = await member();
    const pick = (await setPick(m, g.marketId, "YES")).prediction!;
    expect((await attach(m, pick.id, 2)).outcome).toBe("attached");
    const a = await account(m);
    expect([Number(a.available), Number(a.reserved)]).toEqual([48, 2]);
    expect(await stakeOf(pick.id)).toMatchObject({ amount: 2, state: "RESERVED" });
    expect((await setPick(m, g.marketId, "NO")).outcome).toBe("rejected_locked");
    await expectReconciled();
  });

  it("the one-step composer (Confidence with the Pick) works with no price", async () => {
    await m2On();
    await optionalWorld();
    const g = await pricelessGame();
    const m = await member();
    const r = await admin.rpc("create_confidence_prediction", {
      p_user_id: m, p_market_id: g.marketId, p_selected_outcome: "YES", p_amount: 3, p_yes_probability: null, p_no_probability: null,
      p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID(),
    });
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data).toMatchObject({ outcome: "created", amount: 3 });
    await expectReconciled();
  });

  it("Call BS works with no price: create, exclusivity, accept, lock, and a pending one expires when a Pick changes", async () => {
    await m2On();
    await optionalWorld();
    const g = await pricelessGame();
    const a = await member("a");
    const b = await member("b");
    const aPick = (await setPick(a, g.marketId, "YES")).prediction!;
    const bPick = (await setPick(b, g.marketId, "NO")).prediction!;
    const created = await callBs(a, bPick.id);
    expect(created.error, created.error?.message).toBeNull();
    const challenge = created.data as Row;
    // Exclusivity: a second pending challenge between the same Picks is refused.
    expect((await callBs(a, bPick.id)).error?.message ?? "").toMatch(/duplicate_pending_challenge/);
    // Pick change cancels the pending challenge (M1 semantics) — still with no price.
    expect((await setPick(a, g.marketId, "NO")).outcome).toBe("updated");
    expect(((await admin.from("challenges").select("*").eq("id", challenge.id).single()).data as Row)).toMatchObject({ status: "EXPIRED", expiry_reason: "PICK_CHANGED" });
    // A fresh challenge on opposing Picks is accepted and locks both Picks.
    expect((await setPick(a, g.marketId, "YES")).outcome).toBe("updated");
    const second = (await callBs(a, bPick.id)).data as Row;
    expect((await accept(second.id, b)).outcome).toBe("accepted");
    expect((await setPick(a, g.marketId, "NO")).outcome).toBe("rejected_locked");
    // Confidence can still be attached after acceptance, before T-10.
    expect((await attach(a, aPick.id, 1)).outcome).toBe("attached");
    await expectReconciled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("grading and settlement never read a price", () => {
  it("home win / away win grade a price-less MONEYLINE from the Game result", async () => {
    await m2On();
    const home = await pricelessGame();
    const away = await pricelessGame();
    const m = await member();
    const pHome = (await setPick(m, home.marketId, "YES")).prediction!; // YES = HOME
    const pAway = (await setPick(m, away.marketId, "YES")).prediction!;
    await grade(home.fixtureId, 7, 3); // home wins -> YES correct
    await grade(away.fixtureId, 3, 7); // away wins -> YES incorrect
    expect(await pickOf(m, home.marketId)).toMatchObject({ id: pHome.id, lifecycle_state: "GRADED", result: "CORRECT" });
    expect(await pickOf(m, away.marketId)).toMatchObject({ id: pAway.id, lifecycle_state: "GRADED", result: "INCORRECT" });
  });

  it("a tied game and a cancelled game resolve VOID (the existing rule), with no price involved", async () => {
    await m2On();
    const tie = await pricelessGame({ sport: "american_football" });
    const cancelled = await pricelessGame();
    const m = await member();
    await setPick(m, tie.marketId, "YES");
    await setPick(m, cancelled.marketId, "NO");
    await grade(tie.fixtureId, 20, 20);
    await setFixture(cancelled.fixtureId, { internal_status: "CANCELLED" });
    expect((await runGradingJob(recordGradedPredictionResult)).failures).toEqual([]);
    expect(await pickOf(m, tie.marketId)).toMatchObject({ lifecycle_state: "GRADED", result: "VOID" });
    expect(await pickOf(m, cancelled.marketId)).toMatchObject({ lifecycle_state: "GRADED", result: "VOID" });
  });

  it("Confidence settlement on a price-less Pick has the same accounting as a priced one: net +N correct, −N incorrect, no price in the math", async () => {
    await m2On();
    await optionalWorld();
    const win = await pricelessGame();
    const lose = await pricelessGame();
    const m = await member();
    const pWin = (await setPick(m, win.marketId, "YES")).prediction!;
    const pLose = (await setPick(m, lose.marketId, "NO")).prediction!;
    await attach(m, pWin.id, 4);
    await attach(m, pLose.id, 2);
    await grade(win.fixtureId, 7, 3);
    await grade(lose.fixtureId, 7, 3); // NO but the home team won
    expect(await stakeOf(pWin.id)).toMatchObject({ state: "SETTLED_CORRECT" });
    expect(await stakeOf(pLose.id)).toMatchObject({ state: "SETTLED_INCORRECT" });
    const a = await account(m);
    expect([Number(a.available), Number(a.reserved)]).toEqual([50 + 4 - 2, 0]); // +4 on the win, −2 on the loss
    await expectReconciled();
  });

  it("an accepted Call BS on a price-less Market resolves from the Game result", async () => {
    await m2On();
    await optionalWorld();
    const g = await pricelessGame();
    const a = await member("a");
    const b = await member("b");
    await setPick(a, g.marketId, "YES");
    const bPick = (await setPick(b, g.marketId, "NO")).prediction!;
    const ch = (await callBs(a, bPick.id)).data as Row;
    await accept(ch.id, b);
    await grade(g.fixtureId, 7, 3); // a (YES = home) wins
    expect((await resolveAcceptedChallenges()).failures).toEqual([]);
    expect(((await admin.from("challenges").select("*").eq("id", ch.id).single()).data as Row).status).toBe("RESOLVED");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("template enforcement lives in the database (React is not the guard)", () => {
  it("NEW Picks on SPREAD and TOTAL are refused, including by a direct RPC call", async () => {
    await m2On();
    const m = await member();
    for (const template of ["SPREAD", "TOTAL"] as const) {
      const g = await seedGame({ template, sport: "basketball" });
      const r = await setPick(m, g.marketId, "YES", { yes: 0.5, no: 0.5 });
      expect(r.outcome, template).toBe("rejected_template_not_allowed");
      expect(await pickOf(m, g.marketId), template).toBeNull();
      // The atomic composer path refuses too, before any stake or ledger row exists.
      const c = await admin.rpc("create_confidence_prediction", {
        p_user_id: m, p_market_id: g.marketId, p_selected_outcome: "YES", p_amount: 2, p_yes_probability: 0.5, p_no_probability: 0.5,
        p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID(),
      });
      expect(c.data, template).toMatchObject({ outcome: "template_not_allowed" });
    }
    expect(((await admin.from("confidence_ledger_entries").select("*").eq("member_id", m).eq("entry_type", "PREDICTION_RESERVE")).data ?? []).length).toBe(0);
    expect((await admin.from("confidence_prediction_stakes").select("*").eq("member_id", m)).data ?? []).toHaveLength(0);
  });

  it("the allow-list is a setting: allow TOTAL and the same Pick succeeds; empty allows nothing", async () => {
    await m2On();
    const g = await seedGame({ template: "TOTAL", sport: "basketball" });
    const m = await member();
    expect((await setPick(m, g.marketId, "YES", { yes: 0.5, no: 0.5 })).outcome).toBe("rejected_template_not_allowed");
    await setSettings({ prediction_allowed_templates: ["MONEYLINE", "TOTAL"] });
    expect((await setPick(m, g.marketId, "YES", { yes: 0.5, no: 0.5 })).outcome).toBe("created");
    await setSettings({ prediction_allowed_templates: [] });
    const g2 = await seedGame({ template: "MONEYLINE", sport: "basketball" });
    expect((await setPick(m, g2.marketId, "YES", { yes: 0.5, no: 0.5 })).outcome).toBe("rejected_template_not_allowed");
  });

  it("a NEW Call BS on a disallowed template is refused; one that already exists is still finished (accepted)", async () => {
    await confidenceWorld();
    const g = await seedGame({ template: "SPREAD", sport: "basketball" });
    const a = await member("a");
    const b = await member("b");
    const aPick = (await setPick(a, g.marketId, "YES", { yes: 0.5, no: 0.5 })).prediction!;
    const bPick = (await setPick(b, g.marketId, "NO", { yes: 0.5, no: 0.5 })).prediction!;
    const pending = (await callBs(a, bPick.id)).data as Row; // created while SPREAD is still offered (pre-M2)
    await m2On(); // M2: MONEYLINE only
    const another = await callBs(b, aPick.id);
    expect(another.error?.message ?? "").toMatch(/market_template_not_allowed/);
    expect((await accept(pending.id, b)).outcome).toBe("accepted"); // the commitment that already exists is finished
  });

  it("commitments that already exist on a now-hidden template still work: edit and Confidence", async () => {
    await confidenceWorld();
    const g = await seedGame({ template: "TOTAL", sport: "basketball" });
    const m = await member();
    const pick = (await setPick(m, g.marketId, "YES", { yes: 0.5, no: 0.5 })).prediction!;
    await m2On();
    expect((await setPick(m, g.marketId, "NO", { yes: 0.5, no: 0.5 })).outcome).toBe("updated");
    expect((await attach(m, pick.id, 1)).outcome).toBe("attached");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("history is preserved byte for byte, and historical SPREAD/TOTAL still read and grade", () => {
  it("activating M2 does not change a single existing Market, Pick or revision; the hidden Markets stay readable", async () => {
    await confidenceWorld();
    const spread = await seedGame({ template: "SPREAD", lineValue: 3.5, sport: "basketball" });
    const total = await seedGame({ template: "TOTAL", lineValue: 220.5, sport: "basketball" });
    const m = await member();
    await setPick(m, spread.marketId, "YES", { yes: 0.55, no: 0.45 });
    await setPick(m, total.marketId, "NO", { yes: 0.5, no: 0.5 });
    const checksum = async () => (await sql(`select
      (select md5(coalesce(string_agg(x::text,'|' order by x::text),'')) from public.markets x where x.id = any($1)) as markets,
      (select md5(coalesce(string_agg(x::text,'|' order by x::text),'')) from public.predictions x where x.market_id = any($1)) as picks,
      (select md5(coalesce(string_agg(x::text,'|' order by x::text),'')) from public.prediction_revisions x where x.prediction_id in (select id from public.predictions where market_id = any($1))) as revisions`,
      [[spread.marketId, total.marketId]]))[0];
    const before = await checksum();
    await m2On();
    await ensureFixtureMarkets(NBA_ENV);
    expect(await checksum()).toEqual(before);
    // Still readable through the repository (the profile / history / Call BS history surfaces use these).
    expect((await getMarketById(spread.marketId))?.marketTemplate).toBe("SPREAD");
    expect((await getMarketById(total.marketId))?.marketTemplate).toBe("TOTAL");
    expect((await listDisplayableMarketsForFixture(spread.fixtureId)).map((x) => x.marketTemplate)).toContain("SPREAD");
  });

  it("historical SPREAD and TOTAL Picks still grade from the Game result after M2 is on", async () => {
    await confidenceWorld();
    const spread = await seedGame({ template: "SPREAD", lineValue: 3.5, sport: "basketball" }); // YES = HOME covers +3.5
    const total = await seedGame({ template: "TOTAL", lineValue: 200.5, sport: "basketball" }); // YES = OVER
    const m = await member();
    await setPick(m, spread.marketId, "YES", { yes: 0.55, no: 0.45 });
    await setPick(m, total.marketId, "YES", { yes: 0.5, no: 0.5 });
    await m2On();
    await grade(spread.fixtureId, 100, 110); // home 100+3.5 = 103.5 < 110 -> NO
    await grade(total.fixtureId, 110, 100); // 210 > 200.5 -> OVER -> YES
    expect(await pickOf(m, spread.marketId)).toMatchObject({ lifecycle_state: "GRADED", result: "INCORRECT" });
    expect(await pickOf(m, total.marketId)).toMatchObject({ lifecycle_state: "GRADED", result: "CORRECT" });
  });

  it("existing priced Picks keep their real snapshots after the relaxation", async () => {
    await confidenceWorld();
    const g = await seedGame({ sport: "basketball" });
    const m = await member();
    const pick = (await setPick(m, g.marketId, "YES", { yes: 0.6, no: 0.4 })).prediction!;
    await m2On();
    expect(Number((await pickOf(m, g.marketId))!.yes_probability_snapshot)).toBeCloseTo(0.6, 6);
    expect(pick.id).toBe((await pickOf(m, g.marketId))!.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the audited Super Admin switch", () => {
  it("is partial, validated, idempotent and audited; nothing changes for a no-op", async () => {
    const adminId = await superAdmin();
    const first = await ok("admin_set_market_policy", { p_admin_id: adminId, p_allowed_templates: ["MONEYLINE"] });
    expect(first.prediction_allowed_templates).toEqual(["MONEYLINE"]);
    expect(first.fixture_markets_enabled).toBe(false); // untouched
    expect(first.prediction_require_price).toBe(true); // untouched
    const audits = async () => ((await admin.from("audit_logs").select("*").eq("action", "settings.market_policy_updated").eq("actor_id", adminId).order("created_at", { ascending: true })).data ?? []) as Row[];
    expect(await audits()).toHaveLength(1);
    await ok("admin_set_market_policy", { p_admin_id: adminId, p_allowed_templates: ["MONEYLINE"] }); // no-op
    expect(await audits()).toHaveLength(1);
    await ok("admin_set_market_policy", { p_admin_id: adminId, p_fixture_markets_enabled: true, p_require_price: false, p_ingestion_templates: ["MONEYLINE"] });
    const a = await audits();
    expect(a).toHaveLength(2);
    expect(a.at(-1)!.before).toMatchObject({ fixture_markets_enabled: false, prediction_require_price: true });
    expect(a.at(-1)!.after).toMatchObject({ fixture_markets_enabled: true, prediction_require_price: false, market_ingestion_templates: ["MONEYLINE"] });
    const bad = await admin.rpc("admin_set_market_policy", { p_admin_id: adminId, p_allowed_templates: ["MONEYLINE", "NOPE"] });
    expect(bad.error?.message ?? "").toMatch(/invalid_templates/);
  });

  it("requires a Super Admin", async () => {
    const plain = await seedUser("plain");
    const r = await admin.rpc("admin_set_market_policy", { p_admin_id: plain, p_require_price: false });
    expect(r.error).not.toBeNull();
    expect((await settingsRow()).prediction_require_price).toBe(true);
  });

  it("rolls back by value: restoring the previous settings restores pre-M2 behaviour; M2-era price-less Picks stay valid", async () => {
    await m2On();
    const g = await pricelessGame();
    const m = await member();
    const pick = (await setPick(m, g.marketId, "YES")).prediction!;
    const other = await pricelessGame(); // a price-less Market that exists from the M2 era
    await m2Off();
    // Pre-M2 behaviour is back: a price-less Pick is refused, SPREAD is offered again.
    expect((await setPick(await member("late"), other.marketId, "YES")).outcome).toBe("rejected_price_required");
    expect((await setPick(await member("spread"), (await seedGame({ template: "SPREAD", sport: "basketball" })).marketId, "YES", { yes: 0.5, no: 0.5 })).outcome).toBe("created");
    // The Pick made during the M2 era is untouched, still valid, still price-less.
    expect(await pickOf(m, g.marketId)).toMatchObject({ id: pick.id, yes_probability_snapshot: null, no_probability_snapshot: null });
    expect(await marketsOf(g.fixtureId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("privileges (S1/S2 hardening is not weakened)", () => {
  const FUNCTIONS: Array<[string, Record<string, unknown>]> = [
    ["market_template_allowed", { p_market_id: randomUUID() }],
    ["ensure_fixture_moneyline_markets", { p_fixture_ids: [randomUUID()] }],
    ["admin_set_market_policy", { p_admin_id: randomUUID(), p_require_price: false }],
  ];

  it("the new functions are not executable by clients", async () => {
    for (const [fn] of FUNCTIONS) {
      const rows = await sql<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') svc
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [fn]);
      expect(rows, fn).toHaveLength(1);
      expect(rows[0], fn).toEqual({ anon: false, auth: false, svc: true });
    }
  });

  it("an anonymous client cannot call them, cannot read platform_settings, and cannot write the new columns", async () => {
    const anon = getTestAnonClient();
    for (const [fn, args] of FUNCTIONS) expect((await anon.rpc(fn, args)).error, fn).not.toBeNull();
    expect((await anon.from("platform_settings").select("fixture_markets_enabled")).error).not.toBeNull();
    expect((await anon.from("platform_settings").update({ prediction_require_price: false }).eq("id", true)).error).not.toBeNull();
    expect((await settingsRow()).prediction_require_price).toBe(true);
  });

  it("the Pick path no longer needs a price column: the snapshots are nullable, the revision columns too", async () => {
    const cols = await sql<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable from information_schema.columns where table_schema='public' and
       ((table_name='predictions' and column_name in ('yes_probability_snapshot','no_probability_snapshot')) or (table_name='prediction_revisions' and column_name in ('previous_probability_snapshot','new_probability_snapshot')))`);
    expect(cols).toHaveLength(4);
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true);
  });
});

// A real-money-free sanity check that an upserted priced Market (the ingestion path) is untouched by the new guard columns.
describe("the existing ingestion upsert is unchanged", () => {
  it("upsertMarket still creates and updates a priced Market", async () => {
    const f = await fixtureOnly({ sport: "american_football" });
    const base = {
      provider: f.provider, providerMarketId: `${f.external}:MONEYLINE`, providerEventId: f.external, question: "Will the M2 Home win?", description: null, status: "ACTIVE" as const,
      fixtureId: f.fixtureId, marketTemplate: "MONEYLINE" as const, lineValue: null, yesSide: "HOME" as const,
      price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "a", no: "b" } }, volume24hr: null, liquidity: null, resolutionStatus: null, resolvedBy: null, resolvedOutcome: null, opensAt: null,
      closesAt: null, closedAt: null, ingestionSource: "test", providerMetadata: {},
    };
    const first = await upsertMarket(base);
    const second = await upsertMarket({ ...base, price: { ...base.price, yes: 0.7, no: 0.3 } });
    expect(first.outcome).toBe("inserted");
    expect(second).toEqual({ id: first.id, outcome: "updated" });
  });
});
