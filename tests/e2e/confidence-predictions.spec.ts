/**
 * Confidence is part of the prediction itself, in a real browser: a prediction is a side AND the Confidence behind it. Choosing a side is local (nothing exists); tapping a Confidence level IS the commitment — one atomic step
 * that creates the Pick, the stake, the reserve and the lock, or creates nothing. Covers the composer on the feed (primary, Total and Spread Markets, expanded inline) and on the Market page, zero balance and the Daily Claim path,
 * exactly-once under double taps, the held / failed / refused save, old open picks completed, the sentiment rule, capability OFF, the Super Admin switches, the shell summary, phone width and Sponsor isolation.
 * Local test accounts and a local database only.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";
import { predict } from "./helpers/predict";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
test.describe.configure({ mode: "serial" });
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tag = randomUUID().slice(0, 6);
async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-cp-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${tag}`, username: `p${label}${tag}`.toLowerCase(), role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email };
}
async function createSponsorLogin() {
  const email = `e2e-cp-sponsor-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: org, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: `CP Co ${randomUUID().slice(0, 4)}`, p_contact_name: "E2E", p_website: null, p_country: null, p_phone: null });
  if (accountError) throw accountError;
  await admin.from("sponsors").update({ status: "ACTIVE", logo_path: `${randomUUID()}/logo.webp` }).eq("id", (Array.isArray(org) ? org[0] : org).id);
  return { email };
}
async function loginAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}
async function loginAsSponsor(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/sponsor/login");
  await page.getByLabel("Business email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/sponsor$/);
}

/** A published Game a few hours out (so it sorts at the top of the feed) with a Moneyline, uniquely named so its card can be found. */
async function seedGame(name: string, startsInMinutes = 180) {
  const home = `Phome ${name} ${tag}`;
  const away = `Paway ${name} ${tag}`;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-cp-${randomUUID()}`, home_team_name: home, away_team_name: away, scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const { data: market, error: marketError } = await admin
    .from("markets")
    .insert({
      provider: `e2e_cp_${randomUUID()}`, provider_market_id: `m_${randomUUID()}`, question: "E2E prediction", status: "ACTIVE", fixture_id: fixture.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.62, no_price: 0.38,
      price_outcome_labels: { yes: `${home} wins`, no: `${home} does not win` }, liquidity: 1000, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  return { home, away, fixtureId: fixture.id as string, marketId: market.id as string, postId: post.id as string };
}
async function addMarket(fixtureId: string, template: "TOTAL" | "SPREAD", line: number) {
  const { data: first } = await admin.from("markets").select("provider").eq("fixture_id", fixtureId).limit(1).single();
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider: first!.provider, provider_market_id: `sec_${randomUUID()}`, question: "E2E secondary", status: "ACTIVE", fixture_id: fixtureId, market_template: template, yes_side: template === "TOTAL" ? null : "HOME", line_value: line,
      yes_price: 0.5, no_price: 0.5, price_outcome_labels: { yes: "yes", no: "no" }, liquidity: 500, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to add market");
  return data.id as string;
}
async function fullGame(name: string, startsInMinutes = 180) {
  const g = await seedGame(name, startsInMinutes);
  const spreadId = await addMarket(g.fixtureId, "SPREAD", -2.5);
  const totalId = await addMarket(g.fixtureId, "TOTAL", 224);
  return { ...g, spreadId, totalId, moneylineId: g.marketId };
}
/** An old open pick, made the way picks were made before Confidence was part of every prediction (the generic path, still open). */
async function legacyPick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { error } = await admin.rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() });
  if (error) throw error;
}
const card = (page: Page, g: { home: string; away: string }) => page.locator("article", { hasText: g.home }).filter({ hasText: g.away });
const section = (c: ReturnType<typeof card>, marketId: string) => c.locator(`[data-slot="feed-market"][data-market-id="${marketId}"]`);
const seeMore = (c: ReturnType<typeof card>) => c.locator('button[data-slot="see-more-markets"]');
const balance = (page: Page) => page.locator('[data-slot="shell-confidence"]:visible');
const level = (scope: ReturnType<Page["locator"]>, n: number) => scope.locator(`[data-slot="confidence-choice"][data-amount="${n}"]`);
const side = (scope: Locator | Page, name: string | RegExp) => scope.getByRole("button", { name });
const stakesOf = async (memberId: string) => ((await admin.from("confidence_prediction_stakes").select("amount, state, prediction_id").eq("member_id", memberId)).data ?? []) as Row[];
const picksOf = async (memberId: string, marketId?: string) => {
  let q = admin.from("predictions").select("id, selected_outcome, lock_reason, locked_at").eq("user_id", memberId);
  if (marketId) q = q.eq("market_id", marketId);
  return ((await q).data ?? []) as Row[];
};
async function gotoFeedReady(page: Page) {
  await page.goto("/feed");
  await page.waitForLoadState("networkidle"); // let the client components hydrate before pressing their buttons
}
const SAVE_DELAY_MS = 6_000;
/** Holds (or kills) every prediction server action for a while, so a test can prove what the card shows DURING the save. */
async function holdServerActions(page: Page, ms: number, mode: "delay" | "abort" = "delay") {
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      await new Promise((r) => setTimeout(r, ms));
      if (mode === "abort") return route.abort("failed");
    }
    return route.continue();
  });
}

/** The cutover is one-way on every normal path (even the service role), so a spec that enforced it puts the disposable local database back through the same explicit remediation connection the isolation helper uses. */
async function resetCutover() {
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

let saved: Row | null = null;
let alice: { id: string; email: string };
let owner: { id: string; email: string };
test.beforeAll(async () => {
  const { data } = await admin.from("platform_settings").select("confidence_enabled, confidence_backed_picks_enabled, confidence_mandatory_since, confidence_allowed_stakes, confidence_baseline, confidence_daily_claim_amount, confidence_daily_claim_interval_hours, pick_lock_minutes_before_kickoff, confidence_notify_correct").eq("id", true).single();
  saved = data;
  await resetCutover();
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_daily_claim_amount: 1, confidence_daily_claim_interval_hours: 24, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10 }).eq("id", true);
  alice = await createMember("alice");
  owner = await createMember("owner", "super_admin");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: alice.id });
});
test.afterAll(async () => {
  await resetCutover();
  if (saved) {
    const rest = { ...saved };
    delete rest.confidence_mandatory_since; // never restored through the API: the cutover is one-way, and resetCutover() above already put it back
    await admin.from("platform_settings").update(rest).eq("id", true);
  }
});

test("the composer on the feed: a side alone creates nothing, a level alone creates nothing, tapping a level with a side IS the prediction — one atomic step; it locks, shows the committed amount, and reveals sentiment only now", async ({ page }) => {
  test.setTimeout(240_000);
  const other = await createMember("crowd");
  const g = await seedGame("one");
  const g2 = await seedGame("two");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: other.id });
  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  const composer = c.getByTestId("prediction-actions");

  // The whole composer is there at once: sides, "How confident are you?", the ladder — and NO confirm button.
  await expect(composer).toContainText("Make your prediction");
  await expect(composer).toContainText("How confident are you?");
  await expect(composer).toContainText("You have 🔥50 available");
  await expect(composer.getByRole("button", { name: /confirm/i })).toHaveCount(0);
  // A level alone does nothing (it is waiting for a side).
  await expect(level(c, 3)).toBeDisabled();
  await expect(c).toContainText("Choose a side first");

  // A side alone is local: switch freely, and nothing reaches the database.
  await side(c, new RegExp(`Pick ${g.home} to win`)).click();
  await side(c, new RegExp(`Pick ${g.away} to win`)).click();
  await expect(side(c, new RegExp(`Pick ${g.away} to win`))).toHaveAttribute("aria-pressed", "true");
  await expect(side(c, new RegExp(`Pick ${g.home} to win`))).toHaveAttribute("aria-pressed", "false");
  await expect(c.locator('[data-slot="market-sentiment"]')).toHaveCount(0); // tapping a side reveals no crowd
  await expect(c).toContainText("Make your pick to see how everyone else picked.");
  expect(await picksOf(alice.id, g.marketId)).toEqual([]);
  expect(await stakesOf(alice.id)).toEqual([]);
  await expect(level(c, 3)).toBeEnabled();
  expect((await admin.from("confidence_accounts").select("available, reserved").eq("member_id", alice.id).single()).data).toMatchObject({ available: 50, reserved: 0 });

  // Tapping a level is the commitment: Pick + stake + reserve + lock, together.
  await level(c, 3).click();
  await expect(c.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "3 Confidence, locked");
  await expect(c).toContainText(`You picked ${g.away}`);
  await expect(c.getByRole("button", { name: /^Pick / })).toHaveCount(0); // no "change your prediction" after a commitment
  await expect(c.locator('[data-slot="confidence-choice"]')).toHaveCount(0);
  const picks = await picksOf(alice.id, g.marketId);
  expect(picks).toHaveLength(1);
  expect(picks[0]).toMatchObject({ selected_outcome: "NO", lock_reason: "CONFIDENCE_COMMITTED" });
  expect(picks[0].locked_at).not.toBeNull();
  expect(await stakesOf(alice.id)).toMatchObject([{ amount: 3, state: "RESERVED", prediction_id: picks[0].id }]);
  expect((await admin.from("confidence_ledger_entries").select("id").eq("member_id", alice.id).eq("entry_type", "PREDICTION_RESERVE")).data).toHaveLength(1);
  // Sentiment appears only now that the prediction is final (one pick = one vote; Confidence does not weight it).
  await expect(c.locator('[data-slot="market-sentiment"]')).toContainText("1 predicted", { timeout: 30_000 });
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 50 total, 47 available, 3 reserved behind your picks/);
  expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);

  // The Market page shows the very same final state, and a reload keeps it.
  await page.goto(`/markets/${g.marketId}`);
  await expect(page.getByText(`You picked: ${g.away}`)).toBeVisible();
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "3 Confidence, locked");
  await expect(page.getByRole("button", { name: /^Pick / })).toHaveCount(0);

  // The Post detail agrees too.
  await page.goto(`/post/${g.postId}`);
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "3 Confidence, locked");

  // A second Game: the Market page composes the same way (the one shared composer).
  await page.goto(`/markets/${g2.marketId}`);
  await page.waitForLoadState("networkidle");
  await side(page, new RegExp(`Pick ${g2.home} to win`)).click();
  await level(page.locator("main"), 1).click();
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked", { timeout: 30_000 });
  expect((await stakesOf(alice.id)).map((s) => s.amount).sort()).toEqual([1, 3]);
});

test("exactly once: a double tap, a held save and a dropped connection each leave one Pick, one stake and one reserve; a refused save restores the composer with the side still chosen", async ({ page }) => {
  test.setTimeout(300_000);
  const m = await createMember("once");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  const dbl = await seedGame("dbl");
  const held = await seedGame("held");
  const drop = await seedGame("drop");
  const late = await seedGame("late");
  await loginAs(page, m.email);
  await gotoFeedReady(page);

  // Double tap on a level.
  const c1 = card(page, dbl);
  await side(c1, new RegExp(`Pick ${dbl.away} to win`)).click();
  await level(c1, 2).dblclick();
  await expect(c1.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
  expect(await picksOf(m.id, dbl.marketId)).toHaveLength(1);
  expect((await stakesOf(m.id)).length).toBe(1);

  // A held save: the levels are disabled with a subtle status the whole time, the composer does not blank, and the result is one prediction. (Timing is logged for the record.)
  await holdServerActions(page, SAVE_DELAY_MS);
  const c2 = card(page, held);
  await side(c2, new RegExp(`Pick ${held.home} to win`)).click();
  const t0 = Date.now();
  await level(c2, 1).click();
  await expect(c2.locator('[data-slot="composer-status"]')).toContainText("Saving your", { timeout: 1_000 });
  const toStatus = Date.now() - t0;
  await expect(level(c2, 2)).toBeDisabled();
  await expect(level(c2, 5)).toBeDisabled();
  await expect(c2).toContainText("How confident are you?"); // not blanked
  expect(await picksOf(m.id, held.marketId)).toEqual([]); // nothing reached the database while held
  await expect(c2.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked", { timeout: SAVE_DELAY_MS + 20_000 });
  const toCommitted = Date.now() - t0;
  console.log(`COMPOSER TIMINGS (action held ${SAVE_DELAY_MS}ms): tap→saving status ${toStatus}ms, tap→committed ${toCommitted}ms`);
  expect(toStatus).toBeLessThan(SAVE_DELAY_MS / 2);
  await page.unroute("**/*");

  // A dropped connection: nothing was saved, the composer is back with the side still chosen; the retry works (same attempt, same key).
  await holdServerActions(page, 1_500, "abort");
  const c3 = card(page, drop);
  await side(c3, new RegExp(`Pick ${drop.away} to win`)).click();
  await level(c3, 4).click();
  await expect(c3.getByRole("alert")).toContainText(/couldn.t be submitted/i, { timeout: 15_000 });
  await expect(side(c3, new RegExp(`Pick ${drop.away} to win`))).toHaveAttribute("aria-pressed", "true");
  expect(await picksOf(m.id, drop.marketId)).toEqual([]);
  await page.unroute("**/*");
  await level(c3, 4).click();
  await expect(c3.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "4 Confidence, locked", { timeout: 30_000 });
  expect(await picksOf(m.id, drop.marketId)).toHaveLength(1);

  // The server wins a race with the deadline: the Game enters its lock window after the page loaded; nothing is created and the composer closes.
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", late.fixtureId);
  const c4 = card(page, late);
  await side(c4, new RegExp(`Pick ${late.home} to win`)).click();
  await level(c4, 1).click();
  await expect(c4).toContainText(/locked/i, { timeout: 20_000 });
  await expect(c4.locator('[data-slot="confidence-choice"]')).toHaveCount(0);
  expect(await picksOf(m.id, late.marketId)).toEqual([]);
  const account = (await admin.from("confidence_accounts").select("available, reserved").eq("member_id", m.id).single()).data!;
  expect([Number(account.available), Number(account.reserved)]).toEqual([43, 7]); // 2 + 1 + 4 reserved; the refused one reserved nothing
  expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
});

test("zero Confidence: no prediction is possible and nothing unbacked is offered; the Daily Claim path is shown only when open, and claiming makes a 🔥1 prediction possible", async ({ page }) => {
  test.setTimeout(240_000);
  const m = await createMember("broke");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  await admin.rpc("admin_confidence_adjust", { p_admin_id: owner.id, p_member_id: m.id, p_amount: -50, p_reason_code: "CORRECTION", p_note: "e2e setup", p_idempotency_key: randomUUID() });
  const g = await seedGame("zero");
  await loginAs(page, m.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await expect(c).toContainText("You need Confidence to make a prediction.");
  await expect(c.getByRole("link", { name: "Claim your Daily Confidence" })).toBeVisible();
  await side(c, new RegExp(`Pick ${g.home} to win`)).click();
  for (const n of [1, 2, 3, 4, 5]) await expect(level(c, n)).toBeDisabled();
  await expect(c).not.toContainText(/buy|purchase|checkout|USDT/i);
  expect(await picksOf(m.id, g.marketId)).toEqual([]);

  await c.getByRole("link", { name: "Claim your Daily Confidence" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await page.waitForLoadState("networkidle");
  await page.locator('[data-slot="confidence-claim-button"]').click();
  await expect(page.locator('[data-slot="confidence-total"]')).toContainText("🔥1");
  await gotoFeedReady(page);
  const c2 = card(page, g);
  await side(c2, new RegExp(`Pick ${g.home} to win`)).click();
  await expect(level(c2, 1)).toBeEnabled();
  await expect(level(c2, 2)).toBeDisabled();
  await level(c2, 1).click();
  await expect(c2.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked", { timeout: 30_000 });
  // Once the claim is spent there is no further claim today, so there is no path to a prediction: the message stays plain.
  const g3 = await seedGame("zero2");
  await gotoFeedReady(page);
  await expect(card(page, g3)).toContainText("You need Confidence to make a prediction.");
  await expect(card(page, g3).getByRole("link", { name: /Claim/ })).toHaveCount(0);
});

test("only levels within the available balance can be chosen; the configured ladder decides which levels exist", async ({ page }) => {
  test.setTimeout(180_000);
  const m = await createMember("partial");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  await admin.rpc("admin_confidence_adjust", { p_admin_id: owner.id, p_member_id: m.id, p_amount: -47, p_reason_code: "CORRECTION", p_note: "e2e setup", p_idempotency_key: randomUUID() }); // 3 available
  const g = await seedGame("partial");
  await loginAs(page, m.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await side(c, new RegExp(`Pick ${g.home} to win`)).click();
  for (const n of [1, 2, 3]) await expect(level(c, n)).toBeEnabled();
  for (const n of [4, 5]) await expect(level(c, n)).toBeDisabled();
  // The ladder is configuration: with a different ladder the composer follows it (no code change).
  await admin.from("platform_settings").update({ confidence_allowed_stakes: [2, 3] }).eq("id", true);
  try {
    await gotoFeedReady(page);
    const c2 = card(page, g);
    await side(c2, new RegExp(`Pick ${g.home} to win`)).click();
    await expect(c2.locator('[data-slot="confidence-choice"]')).toHaveCount(2);
    await expect(level(c2, 1)).toHaveCount(0);
    await level(c2, 2).click();
    await expect(c2.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked", { timeout: 30_000 });
  } finally {
    await admin.from("platform_settings").update({ confidence_allowed_stakes: [1, 2, 3, 4, 5] }).eq("id", true);
  }
});

test("every Market of a Game is predicted inline: Total and Spread compose exactly like the Moneyline, each with its own Confidence, and the reserve adds up; collapsing changes nothing; the Market page agrees", async ({ page }) => {
  test.setTimeout(300_000);
  const m = await createMember("inline");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  const single = await seedGame("single");
  const g = await fullGame("full");
  await loginAs(page, m.email);
  await gotoFeedReady(page);
  await expect(seeMore(card(page, single))).toHaveCount(0); // one Market: nothing more to show

  const c = card(page, g);
  await expect(seeMore(c)).toHaveAttribute("aria-expanded", "false");
  await expect(c.locator('[data-slot="more-markets-panel"]')).toBeHidden();
  const urlBefore = page.url();
  await seeMore(c).click();
  await expect(page).toHaveURL(urlBefore); // inline: no navigation
  await expect(c.locator('[data-slot="market-heading"]')).toHaveText(["Game Total 224", "Spread"]);
  await expect(c.locator('[data-slot="more-markets-panel"]').getByText("Make your prediction")).toHaveCount(1);
  const total = section(c, g.totalId);
  const spread = section(c, g.spreadId);
  const money = section(c, g.moneylineId);

  // Each Market has its own composer; a side is local to its Market.
  await side(total, "Pick Over 224 total points").click();
  await expect(side(total, "Pick Over 224 total points")).toHaveAttribute("aria-pressed", "true");
  await expect(side(spread, new RegExp(`Pick ${g.away} plus 2\\.5`))).toHaveAttribute("aria-pressed", "false");
  expect(await picksOf(m.id)).toEqual([]);
  await level(total, 2).click();
  await expect(total.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked", { timeout: 30_000 });
  await expect(total.locator('[data-slot="market-sentiment"]')).toContainText("Over 224 100% · Under 224 0% · 1 predicted", { timeout: 30_000 });
  await expect(spread.locator('[data-slot="market-sentiment"]')).toHaveCount(0); // each Market reveals its own, only after its own prediction

  await predict(spread, new RegExp(`Pick ${g.away} plus 2\\.5`), 1);
  await predict(money, new RegExp(`Pick ${g.home} to win`), 3);
  const stakes = (await stakesOf(m.id)).map((s) => s.amount).sort();
  expect(stakes).toEqual([1, 2, 3]);
  expect(await picksOf(m.id)).toHaveLength(3);
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 50 total, 44 available, 6 reserved behind your picks/, { timeout: 30_000 });
  expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);

  // Collapse and re-expand: nothing removed, changed or unlocked.
  await seeMore(c).click();
  await expect(c.locator('[data-slot="more-markets-panel"]')).toBeHidden();
  expect((await stakesOf(m.id)).length).toBe(3);
  await seeMore(c).click();
  await expect(section(c, g.totalId).locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");

  // The Market page (the same canonical Pick) shows the same state for the Total.
  await page.goto(`/markets/${g.totalId}`);
  await expect(page.getByText("You picked: Over 224")).toBeVisible();
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
});

test("an old open pick (made before Confidence was part of every prediction) comes in with its side chosen and no sentiment; choosing a level completes it — one Pick, now final; an old locked pick stays as the record it is", async ({ page }) => {
  test.setTimeout(240_000);
  const m = await createMember("legacy");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  const crowd = await createMember("legacycrowd");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: crowd.id });
  const open = await seedGame("legacyopen");
  const locked = await seedGame("legacylocked");
  await legacyPick(m.id, open.marketId, "YES");
  await legacyPick(m.id, locked.marketId, "YES");
  await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CHALLENGE_ACCEPTED" }).eq("user_id", m.id).eq("market_id", locked.marketId);
  await loginAs(page, m.email);
  await gotoFeedReady(page);

  const c = card(page, open);
  await expect(c).toContainText(/isn.t final yet/);
  await expect(side(c, new RegExp(`Pick ${open.home} to win`))).toHaveAttribute("aria-pressed", "true");
  await expect(c.locator('[data-slot="market-sentiment"]')).toHaveCount(0); // not final: the crowd stays hidden
  const idBefore = (await picksOf(m.id, open.marketId))[0].id;
  await side(c, new RegExp(`Pick ${open.away} to win`)).click(); // a side can still change before it is final
  await level(c, 2).click();
  await expect(c.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked", { timeout: 30_000 });
  const after = await picksOf(m.id, open.marketId);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: idBefore, selected_outcome: "NO", lock_reason: "CONFIDENCE_COMMITTED" });
  await expect(c.locator('[data-slot="market-sentiment"]')).toBeVisible({ timeout: 30_000 });

  const cl = card(page, locked);
  await expect(cl).toContainText(`You picked ${locked.home} — Picks are locked for this game`);
  await expect(cl.locator('[data-slot="confidence-choice"]')).toHaveCount(0);
  expect((await stakesOf(m.id)).length).toBe(1); // no Confidence was invented for the locked one
});

test("with predictions switched off (or Confidence off) the composer says so and offers nothing, and no sentiment shows; an existing commitment still shows", async ({ page }) => {
  test.setTimeout(240_000);
  const m = await createMember("off");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  const made = await seedGame("made");
  const fresh = await seedGame("fresh");
  await loginAs(page, m.email);
  await gotoFeedReady(page);
  await predict(card(page, made), new RegExp(`Pick ${made.home} to win`), 1);
  await admin.from("platform_settings").update({ confidence_backed_picks_enabled: false }).eq("id", true);
  try {
    await gotoFeedReady(page);
    const c = card(page, fresh);
    await expect(c).toContainText("Predictions are paused right now.");
    await expect(c.locator('[data-slot="confidence-choice"]')).toHaveCount(0);
    await expect(side(c, new RegExp(`Pick ${fresh.home} to win`))).toBeDisabled();
    await expect(card(page, made).locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked");
    await admin.from("platform_settings").update({ confidence_backed_picks_enabled: true, confidence_enabled: false }).eq("id", true);
    await gotoFeedReady(page);
    await expect(card(page, fresh)).toContainText("Predictions are paused right now.");
    await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
  } finally {
    await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true }).eq("id", true);
  }
});

test("the Super Admin switches: predictions on/off and the permanent 'No Pick can exist without Confidence' cutover are audited and take effect; once set it cannot be undone; wording needs {{amount}}", async ({ page }) => {
  test.setTimeout(240_000);
  await loginAs(page, owner.email);
  await page.goto("/admin/settings/brohda");
  const card_ = page.locator('[data-slot="confidence-settings"]');
  await expect(card_).toBeVisible();
  await expect(card_.getByLabel(/Members can make predictions/i)).toBeChecked();
  await expect(card_.locator('[data-slot="confidence-mandatory-since"]')).toContainText("Not enforced yet");
  await expect(card_.locator('[data-slot="confidence-mandatory-locked"]')).toHaveCount(0);
  await card_.getByLabel(/No Pick can exist without Confidence/i).check();
  await card_.getByLabel("When the pick was correct").fill("You won {{amount}} Confidence!");
  await card_.getByRole("button", { name: "Save" }).click();
  await expect(card_.getByRole("status")).toContainText("Members can make predictions");
  await expect.poll(async () => (await admin.from("platform_settings").select("confidence_mandatory_since, confidence_notify_correct").eq("id", true).single()).data!.confidence_notify_correct).toBe("You won {{amount}} Confidence!");
  const since = (await admin.from("platform_settings").select("confidence_mandatory_since").eq("id", true).single()).data!.confidence_mandatory_since;
  expect(since).not.toBeNull();
  await page.reload();
  await expect(card_.locator('[data-slot="confidence-mandatory-since"]')).toContainText("Enforced in the database since");
  // Permanent: the control is a locked, checked block — there is nothing left to uncheck.
  const locked = card_.locator('[data-slot="confidence-mandatory-locked"]');
  await expect(locked).toBeVisible();
  await expect(locked).toContainText("permanent");
  await expect(locked.getByRole("checkbox")).toBeChecked();
  await expect(locked.getByRole("checkbox")).toBeDisabled();
  // Wording without {{amount}} is refused as a whole.
  await card_.getByLabel("When the pick was incorrect").fill("Better luck next time.");
  await card_.getByRole("button", { name: "Save" }).click();
  await expect(card_.getByRole("alert")).toContainText("{{amount}}");
  // With the database enforcement ON, a prediction made through the UI still works (it is the one path that creates Pick + stake together).
  const m = await createMember("enforced");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  const g = await seedGame("enforced");
  await loginAs(page, m.email);
  await gotoFeedReady(page);
  await predict(card(page, g), new RegExp(`Pick ${g.home} to win`), 2);
  expect(await stakesOf(m.id)).toMatchObject([{ amount: 2 }]);
  // The economy page shows the capacity to predict and the earlier picks.
  await loginAs(page, owner.email);
  await page.goto("/admin/confidence");
  await expect(page.locator('[data-slot="prediction-capacity"]')).toContainText("since");
  await expect(page.locator('[data-slot="prediction-capacity"]')).toContainText("Earlier picks without Confidence");
  // Saving settings again (wording back to the default for the other specs) never moves or clears the cutover.
  await page.goto("/admin/settings/brohda");
  await card_.getByLabel("When the pick was correct").fill("+{{amount}}🔥 Confidence.");
  await card_.getByLabel("When the pick was incorrect").fill("−{{amount}}🔥 Confidence.");
  await card_.getByRole("button", { name: "Save" }).click();
  await expect(card_.getByRole("status")).toContainText("Members can make predictions");
  expect((await admin.from("platform_settings").select("confidence_mandatory_since").eq("id", true).single()).data!.confidence_mandatory_since).toBe(since);
  // The suite returns the disposable database to the pre-cutover world so the specs that seed earlier picks keep working.
  await resetCutover();
});

test("the shell summary shows total, available and reserved behind your picks; phone width holds the composer; a Sponsor sees none of it", async ({ page }) => {
  test.setTimeout(240_000);
  const m = await createMember("shell");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  await admin.from("platform_settings").update({ confidence_allowed_stakes: [18] }).eq("id", true); // a meaningful state: 🔥50 total, 🔥32 available, 🔥18 reserved
  const g = await seedGame("shell");
  const g2 = await seedGame("phone");
  await loginAs(page, m.email);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoFeedReady(page);
  await predict(card(page, g), new RegExp(`Pick ${g.home} to win`), 18);
  const rail = page.locator('aside[aria-label="Navigation"]');
  await expect(rail.locator(':scope > a[data-slot="shell-confidence"]')).toHaveCount(0);
  const block = rail.locator('nav[aria-label="Primary"] [data-slot="shell-confidence"]');
  await expect(block).toContainText("50 total");
  await expect(block).toContainText("32 available");
  await expect(block).toContainText("18 reserved behind your picks");
  await expect(block).toHaveAttribute("aria-label", "Confidence: 50 total, 32 available, 18 reserved behind your picks. Open your Confidence history");
  await admin.from("platform_settings").update({ confidence_allowed_stakes: [1, 2, 3, 4, 5] }).eq("id", true);

  // Phone: no overflow, comfortable tap targets, the composer fits inside the card, and a prediction commits.
  await page.setViewportSize({ width: 375, height: 800 });
  await gotoFeedReady(page);
  const c = card(page, g2);
  await side(c, new RegExp(`Pick ${g2.away} to win`)).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const box = (await level(c, 1).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(36);
  expect(box.width).toBeGreaterThanOrEqual(40);
  const cardBox = (await c.boundingBox())!;
  for (const b of await level(c, 1).locator("xpath=..").locator("button").all()) {
    const bb = (await b.boundingBox())!;
    expect(bb.x + bb.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  }
  await level(c, 2).click();
  await expect(c.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked", { timeout: 30_000 });
  await expect(page.locator('header [data-slot="shell-confidence"]:visible')).toHaveAttribute("aria-label", /^Confidence: 50 total, 30 available, 20 reserved behind your picks/, { timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 800 });

  // A Sponsor sees no Member Confidence UI.
  const sponsor = await createSponsorLogin();
  await loginAsSponsor(page, sponsor.email);
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
  await page.goto("/feed").catch(() => undefined);
  await expect(page.locator('[data-slot="confidence-choice"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
});
