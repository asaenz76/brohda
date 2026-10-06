/**
 * E2E for the cleanup + policy-hardening milestone (everything that does not need to flip a platform setting; the re-consent flow does and
 * lives in legal-reconsent.spec.ts, in its own serial project):
 *   - login returns to the page you were sent from, and can never be turned into an open redirect;
 *   - registration records acceptance of the current Terms and Privacy Policy;
 *   - sport-aware Game headers (Away @ Home for American football, Home vs Away for football);
 *   - Pick-first sentiment: nothing before a Pick, and for logged-out visitors never;
 *   - the admin Predictions filters (server-side, URL-driven, usable at phone width).
 * Seeded through the app's own tables; all accounts are local test accounts.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { LEGAL_DOCUMENTS } from "../../lib/legal/documents";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);

const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[], posts: [] as string[] };

async function createUser(prefix: string, role: "player" | "super_admin" = "player") {
  const email = `cph-${prefix}-${suffix}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const username = `cph${prefix}${suffix}`.slice(0, 24);
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `CPH ${prefix} ${suffix}`, username, role, is_active: true });
  if (profileError) throw profileError;
  seeded.users.push(data.user.id);
  return { id: data.user.id as string, email, username };
}

async function seedGame(key: string, sport: "american_football" | "football", minutesAhead = 24 * 60) {
  const home = `${key} Home ${suffix}`;
  const away = `${key} Away ${suffix}`;
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-cph-${randomUUID()}`, sport, home_team_name: home, away_team_name: away, competition_name: "E2E League", scheduled_start_utc: new Date(Date.now() + minutesAhead * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "e2e_cph", provider_market_id: `cph_${randomUUID()}`, question: `Will ${home} win?`, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {} })
    .select("id")
    .single();
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  seeded.fixtures.push(fixture!.id);
  seeded.markets.push(market!.id);
  seeded.posts.push(post!.id);
  return { fixtureId: fixture!.id as string, marketId: market!.id as string, postId: post!.id as string, home, away };
}

async function pick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { error } = await admin.rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
  if (error) throw error;
}

async function logIn(page: Page, email: string, from = "/login") {
  await page.context().clearCookies();
  await page.goto(from);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
}

let member: Awaited<ReturnType<typeof createUser>>;
let rival: Awaited<ReturnType<typeof createUser>>;
let operator: Awaited<ReturnType<typeof createUser>>;
let nfl: Awaited<ReturnType<typeof seedGame>>;
let soccer: Awaited<ReturnType<typeof seedGame>>;
const registered: string[] = [];

test.beforeAll(async () => {
  member = await createUser("mem");
  rival = await createUser("riv");
  operator = await createUser("op", "super_admin");
  nfl = await seedGame("Gridiron", "american_football");
  soccer = await seedGame("Pitch", "football", 25 * 60);
  await pick(rival.id, nfl.marketId, "YES");
});

test.afterAll(async () => {
  await admin.from("predictions").delete().in("market_id", seeded.markets);
  await admin.from("posts").delete().in("fixture_id", seeded.fixtures);
  await admin.from("markets").delete().in("id", seeded.markets);
  await admin.from("fixtures").delete().in("id", seeded.fixtures);
  for (const id of [...seeded.users, ...registered]) await admin.auth.admin.deleteUser(id);
});

test.describe("login returns where you were going — and only there", () => {
  test("a logged-out visit to a member page goes to /login?next=… and comes back after login", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/login\?next=%2Fprofile$/);
    await page.getByLabel("Email").fill(member.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(/\/profile$/);
  });

  test("the query string of the page you were sent from survives", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`/post/${nfl.postId}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fpost%2F${nfl.postId}$`));
    await page.getByLabel("Email").fill(member.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${nfl.postId}$`));
  });

  const hostile = [
    "https://evil.example/phish",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/\r\nLocation: https://evil.example",
  ];
  for (const next of hostile) {
    test(`an unsafe next (${next.slice(0, 28).replace(/\s/g, " ")}) is ignored: login lands on /feed on this origin`, async ({ page, baseURL }) => {
      // A fresh member each time: sign-in attempts are rate-limited per account, which is itself behaviour worth leaving alone.
      const fresh = await createUser(`h${hostile.indexOf(next)}`);
      await logIn(page, fresh.email, `/login?next=${encodeURIComponent(next)}`);
      await expect(page).toHaveURL(/\/feed$/);
      expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    });
  }

  test("an auth page is never a destination (no loop back to /login)", async ({ page }) => {
    const fresh = await createUser("loop");
    await logIn(page, fresh.email, `/login?next=${encodeURIComponent("/login")}`);
    await expect(page).toHaveURL(/\/feed$/);
  });

  test("the register link on a login page that has a next keeps it", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`/login?next=${encodeURIComponent("/profile")}`);
    await expect(page.getByRole("link", { name: /create (an )?account|sign up|join/i }).first()).toHaveAttribute("href", /\/register\?next=%2Fprofile$/);
  });
});

test.describe("registration records acceptance of the current Terms and Privacy Policy", () => {
  test("a new member's acceptance is stored, versioned, and tagged with where it came from", async ({ page }) => {
    const email = `cph-new-${suffix}@test.local`;
    const username = `cphnew${suffix}`;
    await page.context().clearCookies();
    await page.goto("/register");
    await page.getByLabel("What should we call you?").fill("CPH New Member");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("What's your email?").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Choose a password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Pick a username").fill(username);
    await page.getByRole("checkbox", { name: /i have read and agree/i }).check();
    await page.getByRole("button", { name: /join/i }).click();
    await expect(page).toHaveURL(/\/feed$/);

    const { data: profile } = await admin.from("user_profiles").select("id").eq("username", username).single();
    expect(profile).not.toBeNull();
    registered.push(profile!.id);
    const { data: rows } = await admin.from("legal_acceptances").select("document, version, source").eq("user_id", profile!.id).order("document");
    expect(rows).toEqual([
      { document: "privacy", version: LEGAL_DOCUMENTS.privacy.version, source: "register" },
      { document: "terms", version: LEGAL_DOCUMENTS.terms.version, source: "register" },
    ]);
  });

  test("the Terms checkbox is required: submitting without it creates no account and records nothing", async ({ page }) => {
    const username = `cphnoterms${suffix}`;
    await page.context().clearCookies();
    await page.goto("/register");
    await page.getByLabel("What should we call you?").fill("CPH No Terms");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("What's your email?").fill(`cph-noterms-${suffix}@test.local`);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Choose a password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Pick a username").fill(username);
    await page.getByRole("button", { name: /join/i }).click();
    await expect(page).toHaveURL(/\/register$/);
    const { data } = await admin.from("user_profiles").select("id").eq("username", username);
    expect(data ?? []).toHaveLength(0);
  });
});

test.describe("Game headers follow the sport", () => {
  test("American football reads Away @ Home; football reads Home vs Away", async ({ page }) => {
    await logIn(page, member.email);
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByRole("article", { name: `Game: ${nfl.away} at ${nfl.home}` }).first()).toBeVisible();
    await expect(page.getByRole("article", { name: `Game: ${soccer.home} vs ${soccer.away}` }).first()).toBeVisible();
    const nflHeading = page.getByRole("article", { name: `Game: ${nfl.away} at ${nfl.home}` }).first().getByText(`${nfl.away} @ ${nfl.home}`);
    await expect(nflHeading.first()).toBeVisible();
    // The Pick buttons follow the same order as the header: away first for American football.
    const buttons = await page.getByRole("article", { name: `Game: ${nfl.away} at ${nfl.home}` }).first().getByRole("button", { name: /^Pick .* to win$/ }).allInnerTexts();
    expect(buttons.map((t) => t.trim())).toEqual([nfl.away, nfl.home]);
  });

  test("the post detail uses the same order", async ({ page }) => {
    await logIn(page, member.email);
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto(`/post/${soccer.postId}`);
    await expect(page.getByRole("main")).toContainText(`${soccer.home} vs`);
    expect(await page.getByRole("main").innerText()).toMatch(new RegExp(`${soccer.home} vs[\\s\\S]*${soccer.away}`));
    await page.goto(`/post/${nfl.postId}`);
    await expect(page.getByRole("main")).toContainText(`${nfl.away} @`);
    expect(await page.getByRole("main").innerText()).toMatch(new RegExp(`${nfl.away} @[\\s\\S]*${nfl.home}`));
  });
});

test.describe("Pick-first sentiment", () => {
  test("a member who has not picked sees no percentages and no count — just the nudge; after picking they appear", async ({ page }) => {
    await logIn(page, member.email);
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto(`/post/${nfl.postId}`);
    const main = page.getByRole("main");
    await expect(main.getByText("Make your pick to see how everyone else picked.")).toBeVisible();
    expect(await main.innerText()).not.toMatch(/\d+%|\d+ predicted/);

    await page.getByRole("button", { name: `Pick ${nfl.home} to win` }).first().click();
    await expect(main.getByText(/\d+%/).first()).toBeVisible();
    await expect(main.getByText(/\d+ predicted/).first()).toBeVisible();
  });

  test("a logged-out visitor never sees percentages or counts on any Game card of the front door", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/");
    const cards = page.getByRole("article", { name: /^Game: / });
    await expect(cards.first()).toBeVisible();
    for (const text of await cards.allInnerTexts()) expect(text).not.toMatch(/\d+%|\d+ predicted/);
  });
});

test.describe("admin Predictions filters", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("search by username, filter by state, and the URL carries the filters; a non-match shows a clear empty state", async ({ page }) => {
    await logIn(page, operator.email);
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto("/admin/predictions");
    const filters = page.getByRole("search", { name: "Filter predictions" });
    await filters.getByLabel(/search/i).fill(rival.username);
    await filters.getByRole("button", { name: /apply|search|filter/i }).click();
    await expect(page).toHaveURL(new RegExp(`q=${rival.username}`));
    await expect(page.getByRole("row").filter({ hasText: rival.username })).toHaveCount(1);

    await filters.getByLabel(/state/i).selectOption("GRADED");
    await filters.getByRole("button", { name: /apply|search|filter/i }).click();
    await expect(page).toHaveURL(/state=GRADED/);
    await expect(page.getByRole("row").filter({ hasText: rival.username })).toHaveCount(0);
    await expect(page.getByText(/no predictions match/i)).toBeVisible();
  });

  test("literal search: % and _ are not wildcards", async ({ page }) => {
    await logIn(page, operator.email);
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto(`/admin/predictions?q=${encodeURIComponent("%")}`);
    await expect(page.getByRole("row").filter({ hasText: rival.username })).toHaveCount(0);
  });

  test("usable at phone width: the filters stack and the page never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await logIn(page, operator.email);
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto(`/admin/predictions?q=${rival.username}`);
    await expect(page.getByRole("search", { name: "Filter predictions" })).toBeVisible();
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(doc.sw).toBeLessThanOrEqual(doc.iw);
  });
});
