/**
 * Brohda 2.1, Milestone 2 in a real browser: the active product is "Game -> one team-winner Market -> pick a team", and it does not depend on a sportsbook price.
 *   - a Game with a priced MONEYLINE and hidden SPREAD/TOTAL shows exactly two team choices: no Spread, no Total, no "See more markets";
 *   - a Game with NO odds still appears, can be Picked (price recorded as NULL), and Confidence can still be added;
 *   - an old SPREAD Pick stays in the Member's history;
 *   - a hidden Market reached directly (an old link) cannot be newly interacted with.
 * Deterministic database fixtures only; no live provider. Local test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
test.describe.configure({ mode: "serial" });
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tag = randomUUID().slice(0, 6);

async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-m2-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${tag}`, username: `m${label}${tag}`.toLowerCase(), role, is_active: true });
  if (profileError) throw profileError;
  await admin.rpc("confidence_bootstrap_member", { p_member_id: data.user.id });
  return { id: data.user.id as string, email };
}
async function loginAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}
async function sql(text: string) {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(text);
    await client.query("commit");
  } finally {
    await client.end();
  }
}
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
const resetPolicy = () => sql("update public.platform_settings set confidence_mandatory_since = null, confidence_optional_picks_enabled = false, confidence_optional_first_enabled_at = null, confidence_two_step_composer_enabled = false where id = true");
const M2_TARGET = { fixture_markets_enabled: true, prediction_require_price: false, prediction_allowed_templates: ["MONEYLINE"], market_ingestion_templates: ["MONEYLINE"] };
const M2_OFF = { fixture_markets_enabled: false, prediction_require_price: true, prediction_allowed_templates: ["MONEYLINE", "SPREAD", "TOTAL"], market_ingestion_templates: ["MONEYLINE", "SPREAD", "TOTAL"] };

/** A Game (an NBA one, so it carries a registered provider) with a Post and whichever Markets are asked for. */
async function seedGame(name: string, markets: Array<"MONEYLINE" | "SPREAD" | "TOTAL" | "NONE_THEN_ENSURE">) {
  const home = `Mhome ${name} ${tag}`;
  const away = `Maway ${name} ${tag}`;
  const external = `e2e-m2-${randomUUID()}`;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ provider: "api_nba", sport: "basketball", external_fixture_id: external, home_team_name: home, away_team_name: away, scheduled_start_utc: new Date(Date.now() + 180 * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const ids: Record<string, string> = {};
  for (const template of markets) {
    if (template === "NONE_THEN_ENSURE") {
      const r = await admin.rpc("ensure_fixture_moneyline_markets", { p_fixture_ids: [fixture.id] });
      expect(r.error, r.error?.message).toBeNull();
      ids.MONEYLINE = (r.data as string[])[0];
      continue;
    }
    const { data: m, error: mErr } = await admin
      .from("markets")
      .insert({
        provider: "api_nba", provider_market_id: `${external}:${template}`, question: `E2E ${template}?`, status: "ACTIVE", fixture_id: fixture.id, market_template: template,
        line_value: template === "MONEYLINE" ? null : template === "SPREAD" ? 3.5 : 220.5, yes_side: template === "TOTAL" ? null : "HOME", yes_price: 0.6, no_price: 0.4,
        last_synced_at: new Date().toISOString(), ingestion_source: "e2e", liquidity: 1000,
      })
      .select("id")
      .single();
    if (mErr || !m) throw mErr ?? new Error("failed to create market");
    ids[template] = m.id;
  }
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  return { home, away, fixtureId: fixture.id as string, postId: post.id as string, ids };
}
const card = (page: Page, g: { home: string; away: string }) => page.locator("article", { hasText: g.home }).filter({ hasText: g.away });
const pickOf = async (userId: string, marketId: string) => ((await admin.from("predictions").select("*").eq("user_id", userId).eq("market_id", marketId).maybeSingle()).data ?? null) as Row | null;
const stakeOf = async (predictionId: string) => ((await admin.from("confidence_prediction_stakes").select("*").eq("prediction_id", predictionId).maybeSingle()).data ?? null) as Row | null;
async function gotoFeedReady(page: Page) {
  await page.goto("/feed");
  await page.waitForLoadState("networkidle");
}

let saved: Row | null = null;
let alice: { id: string; email: string };
let owner: { id: string; email: string };
test.beforeAll(async () => {
  saved = ((await admin.from("platform_settings").select("*").eq("id", true).single()).data ?? null) as Row | null;
  await resetPolicy();
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true, ...M2_OFF });
  alice = await createMember("alice");
  owner = await createMember("owner", "super_admin");
  // production-shaped: mandatory cutover set; optional Picks and the two-step composer on (M1), then M2's target policy
  expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: owner.id, p_config: { confidence_mandatory: true } })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: owner.id, p_enabled: true })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_two_step_composer", { p_admin_id: owner.id, p_enabled: true })).error).toBeNull();
});
test.afterAll(async () => {
  await resetPolicy();
  if (saved) {
    const { id: _id, ...rest } = saved;
    void _id;
    await admin.from("platform_settings").update(rest).eq("id", true);
  }
});

test("with M2 OFF (the defaults) the card is exactly what it was: the Game's other Markets are still offered", async ({ page }) => {
  test.setTimeout(120_000);
  await setSettings(M2_OFF);
  const g = await seedGame("off", ["MONEYLINE", "SPREAD", "TOTAL"]);
  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  await expect(card(page, g).getByRole("button", { name: /^See more markets/i })).toBeVisible();
});

test("M2 target: a Game shows exactly two team choices — no Spread, no Total, no 'See more markets'", async ({ page }) => {
  test.setTimeout(120_000);
  await setSettings(M2_TARGET);
  const g = await seedGame("ml", ["MONEYLINE", "SPREAD", "TOTAL"]);
  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await expect(c.getByRole("button", { name: new RegExp(`^Pick ${g.home}`) })).toBeVisible();
  await expect(c.getByRole("button", { name: new RegExp(`^Pick ${g.away}`) })).toBeVisible();
  // exactly two team-pick buttons on the whole card
  await expect(c.getByRole("button", { name: /^Pick / })).toHaveCount(2);
  await expect(c.getByRole("button", { name: /^See more markets/i })).toHaveCount(0);
  await expect(c.getByText(/\b(Over|Under|Spread|Total)\b/)).toHaveCount(0);
});

test("a Game with NO odds appears, can be Picked (price recorded as NULL), and Confidence can still be added", async ({ page }) => {
  test.setTimeout(240_000);
  await setSettings(M2_TARGET);
  const g = await seedGame("noodds", ["NONE_THEN_ENSURE"]);
  // the Market has no price at all
  const market = ((await admin.from("markets").select("*").eq("id", g.ids.MONEYLINE).single()).data ?? {}) as Row;
  expect([market.yes_price, market.no_price]).toEqual([null, null]);

  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await expect(c.getByRole("button", { name: /^Pick / })).toHaveCount(2);

  // Step 1: a team is a Pick on its own
  await c.getByRole("button", { name: new RegExp(`^Pick ${g.home}`) }).click();
  await expect(c.getByText("You can change your pick until it locks.")).toBeVisible();
  const pick = (await pickOf(alice.id, g.ids.MONEYLINE))!;
  expect(pick.selected_outcome).toBe("YES");
  expect([pick.yes_probability_snapshot, pick.no_probability_snapshot]).toEqual([null, null]); // no price existed: NULL, never invented
  expect(await stakeOf(pick.id)).toBeNull();

  // Step 2: optional Confidence still works and locks the team
  await expect(c.getByText("(optional)")).toBeVisible();
  await c.locator('[data-slot="confidence-choice"][data-amount="2"]').click();
  await expect(c.getByText(/Confidence · Locked/)).toBeVisible();
  const stake = (await stakeOf(pick.id))!;
  expect([stake.amount, stake.state]).toEqual([2, "RESERVED"]);
});

test("an old SPREAD Pick stays in the Member's history", async ({ page }) => {
  test.setTimeout(180_000);
  // made while Spread was still offered, then graded: the shape of a real historical Pick
  await setSettings(M2_OFF);
  const g = await seedGame("history", ["MONEYLINE", "SPREAD"]);
  const made = await admin.rpc("set_pick", { p_user_id: alice.id, p_market_id: g.ids.SPREAD, p_selected_outcome: "YES", p_yes_probability: 0.55, p_no_probability: 0.45, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
  expect(made.error, made.error?.message).toBeNull();
  await sql(`update public.predictions set lifecycle_state = 'GRADED', result = 'CORRECT', graded_at = now(), resolved_outcome_snapshot = 'YES' where user_id = '${alice.id}' and market_id = '${g.ids.SPREAD}'`);
  await sql(`update public.fixtures set internal_status = 'COMPLETED', home_score = 100, away_score = 90 where id = '${g.fixtureId}'`);
  await setSettings(M2_TARGET); // M2 is on now

  await loginAs(page, alice.email);
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(g.home).first()).toBeVisible();
  await expect(page.getByText("Correct").first()).toBeVisible();
});

test("a hidden Market reached directly (an old link) cannot be newly interacted with", async ({ page }) => {
  test.setTimeout(180_000);
  await setSettings(M2_TARGET);
  const g = await seedGame("direct", ["MONEYLINE", "SPREAD"]);
  await loginAs(page, alice.email);
  await page.goto(`/markets/${g.ids.SPREAD}`);
  await page.waitForLoadState("networkidle");
  // the record is readable, but it offers no new Pick
  await expect(page.getByText("This isn't one of the picks open right now. Pick the team you think wins.").first()).toBeVisible();
  expect(await pickOf(alice.id, g.ids.SPREAD)).toBeNull();
  // and the database refuses it even if the page were bypassed
  const direct = await admin.rpc("set_pick", { p_user_id: alice.id, p_market_id: g.ids.SPREAD, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
  expect((direct.data as Row).outcome).toBe("rejected_template_not_allowed");
  expect(await pickOf(alice.id, g.ids.SPREAD)).toBeNull();
});
