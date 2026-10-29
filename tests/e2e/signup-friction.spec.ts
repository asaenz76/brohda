/**
 * E2E: Brohda 2.1 M8 — account creation in one screen, with the M7 Game intent intact.
 *   A. signed-out visitor taps a side -> ONE sign-up submission -> back on the Game "You chose X" -> no Pick exists -> explicit Confirm -> exactly one Pick (375 px and desktop);
 *   B. direct sign-up (no Game, no side) still works and lands in the feed;
 *   C. an email that already has an account: clear way to log in that keeps the Game, and the Game's side survives the login;
 *   D. a taken username keeps every other field (password included), names the field, moves focus there, and the Game intent survives the retry;
 *   E. validation: each invalid field gets its own message; nothing else is wiped; no account is created;
 *   F. double submit / simultaneous submit of the same details: exactly one auth account and one profile; one Pick after the explicit confirm;
 *   G. back / reload around sign-up: no phantom account, no automatic Pick;
 *   plus: the auth pages are one <main> landmark, password-manager attributes, axe, and the interaction count of the whole journey.
 * Free, nonmonetary, no AI. Own Playwright project (chained after M7's): it needs registration open and the production-shaped Pick policy, which is global state.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 6);
const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[], posts: [] as string[] };

interface Game { fixtureId: string; marketId: string; postId: string; home: string; away: string }

async function seedGame(key: string, minutesAhead = 40): Promise<Game> {
  const home = `${key}Home${suffix}`;
  const away = `${key}Away${suffix}`;
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-m8-${randomUUID()}`, sport: "american_football", home_team_name: home, away_team_name: away, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + minutesAhead * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  seeded.fixtures.push(fixture!.id);
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "e2e_m8", provider_market_id: `m8_${randomUUID()}`, question: `Will ${home} win?`, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, price_outcome_labels: { yes: "Home win", no: "Home do not win" } })
    .select("id")
    .single();
  seeded.markets.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  seeded.posts.push(post!.id);
  return { fixtureId: fixture!.id, marketId: market!.id, postId: post!.id, home, away };
}

function who(label: string) {
  const clean = label.replace(/[^a-z0-9]/gi, "");
  return { email: `m8-${clean}-${suffix}@test.local`, username: `m8${clean}${suffix}`.toLowerCase() };
}

async function fillSignup(page: Page, person: { email: string; username: string }, opts: { terms?: boolean } = {}) {
  await page.locator("#email").fill(person.email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#username").fill(person.username);
  if (opts.terms !== false) await page.getByRole("checkbox").check();
}

async function profileFor(username: string) {
  const { data } = await admin.from("user_profiles").select("id, display_name, username").eq("username", username).maybeSingle();
  if (data) seeded.users.push(data.id);
  return data;
}

/** The auth logins with this email, straight from the database (the admin list API pages through thousands of local test users and can miss a new one). */
async function authUsersWithEmail(email: string): Promise<{ id: string }[]> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query("select id from auth.users where email = $1", [email]);
    return rows;
  } finally {
    await client.end();
  }
}

async function pickRows(userId: string, marketId: string) {
  const { data } = await admin.from("predictions").select("selected_outcome, lifecycle_state").eq("user_id", userId).eq("market_id", marketId);
  return data ?? [];
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(iw);
}

async function sqlReplica(text: string) {
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
const resetPolicy = () => sqlReplica("update public.platform_settings set confidence_mandatory_since = null, confidence_optional_picks_enabled = false, confidence_optional_first_enabled_at = null, confidence_two_step_composer_enabled = false where id = true");

let saved: Record<string, unknown> | null = null;
test.beforeAll(async () => {
  saved = (await admin.from("platform_settings").select("confidence_enabled, confidence_backed_picks_enabled, confidence_allowed_stakes, confidence_baseline, pick_lock_minutes_before_kickoff, call_bs_enabled, registration_enabled, social_prediction_enabled").eq("id", true).single()).data;
  await resetPolicy();
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true, registration_enabled: true, social_prediction_enabled: true }).eq("id", true);
  const { data: owner } = await admin.auth.admin.createUser({ email: `m8-owner-${suffix}@test.local`, password: PASSWORD, email_confirm: true });
  seeded.users.push(owner.user!.id);
  await admin.from("user_profiles").insert({ id: owner.user!.id, display_name: `M8 owner ${suffix}`, username: `m8owner${suffix}`, role: "super_admin", is_active: true });
  await admin.rpc("confidence_bootstrap_member", { p_member_id: owner.user!.id });
  expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: owner.user!.id, p_config: { confidence_mandatory: true } })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: owner.user!.id, p_enabled: true })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_two_step_composer", { p_admin_id: owner.user!.id, p_enabled: true })).error).toBeNull();
});

test.afterAll(async () => {
  await resetPolicy();
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
  for (const id of new Set(seeded.users)) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  await admin.from("predictions").delete().in("market_id", seeded.markets);
  await admin.from("posts").delete().in("id", seeded.posts);
  await admin.from("markets").delete().in("id", seeded.markets);
  await admin.from("fixtures").delete().in("id", seeded.fixtures);
});

test.describe("One-screen sign-up keeps the Game intent (M7) and still needs an explicit Pick", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  for (const viewport of [{ name: "phone (375 px)", width: 375, height: 812 }, { name: "desktop", width: 1280, height: 900 }]) {
    test(`A. signed-out intent on ${viewport.name}: tap a side -> one sign-up -> back on the Game -> confirm -> one Pick`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const game = await seedGame(`a${viewport.width}`);
      const person = who(`a${viewport.width}`);
      await page.context().clearCookies();
      await page.goto("/");
      const card = page.locator("article").filter({ hasText: game.home }).first();
      await expect(card).toBeVisible();

      const startedAt = Date.now();
      let interactions = 0; // every tap / typed field / key the person must do, counted by the test itself
      await card.getByRole("link", { name: new RegExp(`^Pick ${game.home}.*create an account`) }).click();
      interactions += 1; // 1: tap the side
      await expect(page).toHaveURL(new RegExp(`/register\\?next=%2Fpost%2F${game.postId}%3Fpick%3DYES$`));
      const banner = page.locator('[data-slot="auth-game-context"]');
      await expect(banner).toContainText(`${game.away} @ ${game.home}`);
      await expect(page.locator('[data-slot="auth-game-choice"]')).toHaveText(`You chose ${game.home}.`);
      await expect(banner).toContainText("Create your account, then confirm your pick.");
      await expectNoHorizontalScroll(page, "register with intent");
      // The whole form, including the submit button, is on the first screen of a phone (no scrolling to find it).
      const join = page.getByRole("button", { name: /^join/i });
      await expect(join).toBeInViewport();

      await fillSignup(page, person);
      interactions += 4; // email, password, username, terms
      // No Pick can exist while signed out, and a signed-out visit created nothing.
      expect(await profileFor(person.username)).toBeNull();
      await join.click();
      interactions += 1; // submit
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}\\?pick=YES$`));
      const signedUpAt = Date.now();

      const profile = await profileFor(person.username);
      expect(profile, "the account exists after the one submission").not.toBeNull();
      // No name was asked for: the display name starts as the username (editable later in Profile).
      expect(profile!.display_name).toBe(person.username);
      // Nothing was saved by getting here: intent is not a Pick.
      expect(await pickRows(profile!.id, game.marketId)).toEqual([]);
      await expect(page.locator('[data-slot="pick-intent"]')).toContainText(`You chose ${game.home}.`);
      await expectNoHorizontalScroll(page, "post with intent");

      await page.getByRole("button", { name: `Confirm your pick: ${game.home}` }).click();
      interactions += 1; // confirm
      await expect(page.locator('[data-slot="post-pick"] [data-slot="pick-made"]')).toContainText("Pick made.");
      const confirmedAt = Date.now();
      expect(await pickRows(profile!.id, game.marketId)).toEqual([{ selected_outcome: "YES", lifecycle_state: "PENDING" }]);
      // Ergonomic evidence only (scripted, not human): interactions, and machine time for the two legs.
      console.log(`[m8-journey] ${viewport.name}: ${interactions} interactions (4 fields + 1 submit + side tap + confirm); submit->Game ${signedUpAt - startedAt - 0} ms incl. fill; tap->confirmed Pick ${confirmedAt - startedAt} ms`);
    });
  }

  test("B. direct sign-up without a Game still creates the account and lands in the feed", async ({ page }) => {
    const person = who("b");
    await page.context().clearCookies();
    await page.goto("/register");
    await expect(page.locator('[data-slot="auth-game-context"]')).toHaveCount(0);
    await fillSignup(page, person);
    await page.getByRole("button", { name: /^join/i }).click();
    await expect(page).toHaveURL(/\/feed$/);
    expect(await profileFor(person.username)).not.toBeNull();
    expect(await authUsersWithEmail(person.email)).toHaveLength(1);
  });

  test("C. an email that already has an account: a clear way to log in that keeps the Game, and the side survives the login", async ({ page }) => {
    const game = await seedGame("c");
    const existing = who("c");
    const { data: created } = await admin.auth.admin.createUser({ email: existing.email, password: PASSWORD, email_confirm: true });
    seeded.users.push(created.user!.id);
    await admin.from("user_profiles").insert({ id: created.user!.id, display_name: existing.username, username: existing.username, role: "player", is_active: true });
    await admin.rpc("confidence_bootstrap_member", { p_member_id: created.user!.id });

    await page.context().clearCookies();
    await page.goto(`/register?next=${encodeURIComponent(`/post/${game.postId}?pick=NO`)}`);
    await expect(page.locator('[data-slot="auth-game-choice"]')).toHaveText(`You chose ${game.away}.`);
    await fillSignup(page, { email: existing.email, username: who("c2").username });
    await page.getByRole("button", { name: /^join/i }).click();
    // The same sentence as before for an existing email (no new account-enumeration signal), now next to the field, with the way out.
    await expect(page.locator("#email-error")).toContainText("An account with this email already exists.");
    await expect(page).toHaveURL(/\/register/);
    expect(await profileFor(who("c2").username)).toBeNull();
    const logIn = page.locator("#email-error").getByRole("link", { name: "Log in instead" });
    await expect(logIn).toHaveAttribute("href", `/login?next=${encodeURIComponent(`/post/${game.postId}?pick=NO`)}`);
    // The email is not put in the address, and the rest of what they typed is still there.
    await expect(page.locator("#email")).toHaveValue(existing.email);
    await logIn.click();
    await expect(page.locator('[data-slot="auth-game-choice"]')).toHaveText(`You chose ${game.away}.`);
    await expect(page.locator('[data-slot="auth-game-context"]')).toContainText("Log in, then confirm your pick.");
    await page.getByLabel("Email").fill(existing.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${game.postId}\\?pick=NO$`));
    await expect(page.locator('[data-slot="pick-intent"]')).toContainText(`You chose ${game.away}.`);
    expect(await pickRows(created.user!.id, game.marketId)).toEqual([]);
  });

  test("D. a taken username: field-level error, focus on the field, nothing else wiped, Game intent kept, then success and one explicit Pick", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const game = await seedGame("d");
    const holder = who("dholder");
    const { data: other } = await admin.auth.admin.createUser({ email: `m8-dholder-${suffix}@test.local`, password: PASSWORD, email_confirm: true });
    seeded.users.push(other.user!.id);
    await admin.from("user_profiles").insert({ id: other.user!.id, display_name: holder.username, username: holder.username, role: "player", is_active: true });

    const person = who("d");
    await page.context().clearCookies();
    await page.goto(`/register?next=${encodeURIComponent(`/post/${game.postId}?pick=YES`)}`);
    await fillSignup(page, { email: person.email, username: holder.username.toUpperCase() });
    await page.getByRole("button", { name: /^join/i }).click();
    await expect(page.locator("#username-error")).toHaveText("That username is taken. Try another.");
    await expect(page.locator("#username")).toBeFocused();
    await expect(page.locator("#username")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#username")).toHaveAttribute("aria-describedby", /username-error/);
    // Nothing else was reset: not the email, not the password, not the Terms, not the Game.
    await expect(page.locator("#email")).toHaveValue(person.email);
    await expect(page.locator("#password")).toHaveValue(PASSWORD);
    await expect(page.getByRole("checkbox")).toBeChecked();
    await expect(page.locator('[data-slot="auth-game-choice"]')).toHaveText(`You chose ${game.home}.`);
    // The rejected attempt created no login at all (the handle was checked BEFORE the login was made).
    expect(await authUsersWithEmail(person.email)).toHaveLength(0);

    await page.locator("#username").fill(person.username);
    await page.getByRole("button", { name: /^join/i }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${game.postId}\\?pick=YES$`));
    const profile = await profileFor(person.username);
    expect(await pickRows(profile!.id, game.marketId)).toEqual([]);
    await page.getByRole("button", { name: `Confirm your pick: ${game.home}` }).click();
    await expect(page.locator('[data-slot="pick-made"]')).toBeVisible();
    expect(await pickRows(profile!.id, game.marketId)).toHaveLength(1);
  });

  test("E. validation: each invalid field says what is wrong, unrelated values survive, no account is created", async ({ page }) => {
    const game = await seedGame("e");
    const next = `/post/${game.postId}?pick=YES`;
    await page.context().clearCookies();
    await page.goto(`/register?next=${encodeURIComponent(next)}`);
    // The browser's own checks would stop most of these before they are sent; switch them off to see what the SERVER (the authority) answers.
    await page.evaluate(() => document.querySelector("form")!.setAttribute("novalidate", ""));
    const person = who("e");
    await page.locator("#email").fill("not-an-email");
    await page.locator("#password").fill("short");
    await page.locator("#username").fill("no spaces!");
    await page.getByRole("button", { name: /^join/i }).click();
    await expect(page.locator("#email-error")).toHaveText("Enter a valid email address.");
    await expect(page.locator("#password-error")).toHaveText("Use 8 to 72 characters.");
    await expect(page.locator("#username-error")).toHaveText("Use 3 to 24 letters, numbers or underscores.");
    await expect(page.locator("#acceptedTerms-error")).toHaveText("Agree to the Terms and Policy to create your account.");
    await expect(page.locator("#email")).toBeFocused(); // first invalid field, in reading order
    // The invalid values are still there to correct (not wiped), and the Game is still named.
    await expect(page.locator("#email")).toHaveValue("not-an-email");
    await expect(page.locator("#username")).toHaveValue("no spaces!");
    await expect(page.locator('[data-slot="auth-game-context"]')).toContainText(game.home);

    // Fix everything but the Terms: only the Terms message remains, and the good values are untouched.
    await page.locator("#email").fill(person.email);
    await page.locator("#password").fill(PASSWORD);
    await page.locator("#username").fill(person.username);
    await page.getByRole("button", { name: /^join/i }).click();
    await expect(page.locator("#acceptedTerms-error")).toBeVisible();
    await expect(page.locator("#email-error, #password-error, #username-error")).toHaveCount(0);
    await expect(page.locator("#email")).toHaveValue(person.email);
    await expect(page.locator("#password")).toHaveValue(PASSWORD);
    expect(await profileFor(person.username)).toBeNull();
    expect(await authUsersWithEmail(person.email)).toHaveLength(0);

    // Accept, submit: the same form, never reloaded, now creates the account and returns to the Game.
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /^join/i }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${game.postId}\\?pick=YES$`));
    expect(await profileFor(person.username)).not.toBeNull();
  });

  test("F. double submit and simultaneous submit: exactly one account and one profile; one Pick after the explicit confirm", async ({ browser, page }) => {
    const game = await seedGame("f");
    const person = who("f");
    // Slow the server action down so a second click has every chance to land while the first is in flight.
    let posts = 0;
    await page.route("**/register**", async (route) => {
      if (route.request().method() === "POST") {
        posts += 1;
        await new Promise((r) => setTimeout(r, 800));
      }
      await route.continue();
    });
    await page.context().clearCookies();
    await page.goto(`/register?next=${encodeURIComponent(`/post/${game.postId}?pick=YES`)}`);
    await fillSignup(page, person);
    const join = page.getByRole("button", { name: /^join/i });
    await join.dblclick();
    await page.locator("#username").press("Enter").catch(() => undefined); // Enter while it is already pending
    await expect(page).toHaveURL(new RegExp(`/post/${game.postId}\\?pick=YES$`));
    expect(posts, "the second click / Enter must not send a second sign-up").toBe(1);
    expect(await authUsersWithEmail(person.email)).toHaveLength(1);
    const { data: profiles } = await admin.from("user_profiles").select("id").eq("username", person.username);
    expect(profiles).toHaveLength(1);
    seeded.users.push(profiles![0].id);
    await page.getByRole("button", { name: `Confirm your pick: ${game.home}` }).dblclick();
    await expect(page.locator('[data-slot="pick-made"]')).toBeVisible();
    expect(await pickRows(profiles![0].id, game.marketId)).toHaveLength(1);

    // Two browsers send the SAME sign-up at the same moment: the database admits one.
    const twin = who("ftwin");
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    await Promise.all(pages.map(async (p) => {
      await p.goto("/register");
      await fillSignup(p, twin);
    }));
    await Promise.all(pages.map((p) => p.getByRole("button", { name: /^join/i }).click()));
    // Each browser ends either signed in (the one that won) or on the form with a message (the one that lost); wait for both to settle.
    await Promise.all(pages.map((p) => Promise.race([p.waitForURL(/\/feed$/), p.locator("#email-error, #username-error, form p[role=alert]").first().waitFor()])));
    expect(await authUsersWithEmail(twin.email)).toHaveLength(1);
    const { data: twinProfiles } = await admin.from("user_profiles").select("id").eq("username", twin.username);
    expect(twinProfiles).toHaveLength(1);
    seeded.users.push(twinProfiles![0].id);
    await Promise.all(contexts.map((c) => c.close()));
  });

  test("G. back and reload around sign-up: no phantom account, no automatic Pick, intent kept where it lives in the address", async ({ page }) => {
    const game = await seedGame("g");
    const person = who("g");
    const next = `/post/${game.postId}?pick=NO`;
    await page.context().clearCookies();
    await page.goto(`/register?next=${encodeURIComponent(next)}`);
    // A reload of the sign-up page keeps the Game and the side (they live in the address), and creates nothing.
    await fillSignup(page, person);
    await page.reload();
    await expect(page.locator('[data-slot="auth-game-choice"]')).toHaveText(`You chose ${game.away}.`);
    expect(await profileFor(person.username)).toBeNull();
    expect(await authUsersWithEmail(person.email)).toHaveLength(0);
    // Going to the Log in page and back keeps the Game too.
    await page.getByRole("link", { name: "Log in" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/login\\?next=`));
    await page.goBack();
    await expect(page).toHaveURL(/\/register\?next=/);
    await expect(page.locator('[data-slot="auth-game-choice"]')).toHaveText(`You chose ${game.away}.`);

    await fillSignup(page, person);
    await page.getByRole("button", { name: /^join/i }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${game.postId}\\?pick=NO$`));
    const profile = await profileFor(person.username);
    // Back to the sign-up page after signing up, then reload: still exactly one account, never a Pick.
    await page.goBack();
    await page.reload();
    expect(await authUsersWithEmail(person.email)).toHaveLength(1);
    expect(await pickRows(profile!.id, game.marketId)).toEqual([]);
    // Reloading the Game with the hint still asks, and still saves nothing.
    await page.goto(next);
    await expect(page.locator('[data-slot="pick-intent"]')).toContainText(`You chose ${game.away}.`);
    expect(await pickRows(profile!.id, game.marketId)).toEqual([]);
  });

  test("an external or hostile next never leaves the site and never shows a Game", async ({ page }) => {
    await page.context().clearCookies();
    for (const hostile of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/register", "/post/x?pick=YES"]) {
      await page.goto(`/register?next=${encodeURIComponent(hostile)}`);
      await expect(page.locator('input[name="next"]')).toHaveCount(hostile === "/post/x?pick=YES" ? 1 : 0);
      await expect(page.locator('[data-slot="auth-game-context"]')).toHaveCount(0);
    }
  });

  test.describe("accessibility", () => {
    // axe is injected into the page, which the app's Content-Security-Policy (rightly) refuses; this context alone opts out of it.
    test.use({ bypassCSP: true });

    test("the auth pages are one <main> landmark; the form is password-manager friendly; axe finds no violations", async ({ page }) => {
      const game = await seedGame("ax");
      await page.context().clearCookies();
      for (const path of ["/register", `/register?next=${encodeURIComponent(`/post/${game.postId}?pick=YES`)}`, "/login", "/reset-password"]) {
        await page.goto(path);
        await expect(page.getByRole("main")).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      }
      await page.goto("/register");
      await expect(page.locator("#email")).toHaveAttribute("autocomplete", "email");
      await expect(page.locator("#email")).toHaveAttribute("type", "email");
      await expect(page.locator("#password")).toHaveAttribute("autocomplete", "new-password");
      await expect(page.locator("#password")).toHaveAttribute("type", "password");
      await expect(page.locator("#username")).toHaveAttribute("autocomplete", "nickname");
      // The password reveal is a real, named button that works from the keyboard and does not submit the form.
      const reveal = page.getByRole("button", { name: "Show password" });
      await page.locator("#password").fill(PASSWORD);
      await reveal.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#password")).toHaveAttribute("type", "text");
      await expect(page.getByRole("button", { name: "Hide password" })).toBeVisible();
      await expect(page).toHaveURL(/\/register$/);
      // Every field has a programmatic label; the Terms link text is real links.
      for (const id of ["email", "password", "username"]) await expect(page.locator(`label[for="${id}"]`)).toHaveCount(1);
      await expect(page.getByRole("checkbox", { name: /i have read and agree to the terms and policy/i })).toBeVisible();
      await expect(page.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
      await expect(page.getByRole("link", { name: "Policy" })).toHaveAttribute("href", "/privacy");

      const axePath = require.resolve("axe-core/axe.min.js");
      for (const path of ["/register", `/register?next=${encodeURIComponent(`/post/${game.postId}?pick=YES`)}`, "/login"]) {
        await page.goto(path);
        await page.addScriptTag({ content: readFileSync(axePath, "utf8") });
        const results = await page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return r.violations.map((v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(" ")).join(" | ")}`);
        });
        expect(results, `axe on ${path}`).toEqual([]);
      }
      // Same again with the errors showing.
      await page.goto("/register");
      await page.evaluate(() => document.querySelector("form")!.setAttribute("novalidate", ""));
      await page.getByRole("button", { name: /^join/i }).click();
      await expect(page.locator("#email-error")).toBeVisible();
      await page.addScriptTag({ content: readFileSync(axePath, "utf8") });
      const errored = await page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return r.violations.map((v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(" ")).join(" | ")}`);
      });
      expect(errored, "axe on /register with errors").toEqual([]);
    });
  });
});
