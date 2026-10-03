/**
 * E2E coverage for the logged-out front door at "/": it is the public face of
 * the same social network a member sees — platform-published Game Posts,
 * aggregate sentiment, a comment count, and two ways in. It must never imply
 * a person authors a Game, never expose comments/people/Picks, never market
 * money, and never mutate anything for an anonymous visitor. Seeded through
 * the app's own RPCs; the page itself is driven through the browser.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

const suffix = randomUUID().slice(0, 8);
const HOME = `Front Door Home ${suffix}`;
const AWAY = `Front Door Away ${suffix}`;
const LONG_HOME = `The Extraordinarily Long Named Football Club of Greater Metropolis United ${suffix}`;
const LONG_AWAY = `Another Remarkably Lengthy Athletic Association of the Northern Territories ${suffix}`;
const PRIVATE_COMMENT = `PRIVATE-COMMENT-${suffix}`;
const PRIVATE_NAME = `PrivateName${suffix}`;

const TEAM_NAME = `Front Door FC ${suffix}`;
const TEAM_SLUG = `fd-team-${suffix}`;

const seeded = { teamIds: [] as string[], communityIds: [] as string[], fixtureIds: [] as string[], marketIds: [] as string[], postIds: [] as string[], userIds: [] as string[], postId: "", marketId: "" };

async function createUser(label: string, displayName: string) {
  const email = `fd-${label}-${suffix}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: displayName, username: `fd${label}${suffix}`, role: "player", is_active: true });
  if (profileError) throw profileError;
  seeded.userIds.push(data.user.id);
  return { id: data.user.id as string, email };
}

async function seedGame(home: string, away: string, minutesAhead: number) {
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-fd-${randomUUID()}`, home_team_name: home, away_team_name: away, competition_name: "NFL",
      scheduled_start_utc: new Date(Date.now() + minutesAhead * 60_000).toISOString(), internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  seeded.fixtureIds.push(fixture!.id);
  const { data: market } = await admin
    .from("markets")
    .insert({
      provider: "e2e_fd", provider_market_id: `fd_${randomUUID()}`, question: `Will ${home} win?`, status: "ACTIVE", fixture_id: fixture!.id,
      market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {},
    })
    .select("id")
    .single();
  seeded.marketIds.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  seeded.postIds.push(post!.id);
  return { marketId: market!.id as string, postId: post!.id as string };
}

async function seedTeamCommunity() {
  const { data: team, error } = await admin.from("teams").insert({ provider: "e2e_fd", external_id: `fd-${randomUUID()}`, name: TEAM_NAME }).select("id").single();
  if (error || !team) throw error ?? new Error("failed to create team");
  seeded.teamIds.push(team.id);
  const { data: community, error: communityError } = await admin.from("communities").insert({ type: "TEAM", team_id: team.id, slug: TEAM_SLUG, active: true }).select("id").single();
  if (communityError || !community) throw communityError ?? new Error("failed to create community");
  seeded.communityIds.push(community.id);
}

async function pick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { error } = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  if (error) throw error;
}

/**
 * Removes this spec's Games left behind by an earlier run that died or failed mid-way (Playwright restarts a worker after a
 * failing test and re-runs beforeAll, so a failure used to leak seeds that then crowded the 10-item feed on every later run).
 * Only rows older than a few minutes are touched, so a concurrent worker's freshly seeded Games are never removed.
 */
async function sweepStaleSeeds() {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: staleTeams } = await admin.from("teams").select("id").eq("provider", "e2e_fd").lt("created_at", cutoff);
  const staleTeamIds = (staleTeams ?? []).map((t) => t.id);
  if (staleTeamIds.length) {
    await admin.from("communities").delete().in("team_id", staleTeamIds);
    await admin.from("teams").delete().in("id", staleTeamIds);
  }
  const { data: fixtures } = await admin.from("fixtures").select("id").like("external_fixture_id", "e2e-fd-%").lt("created_at", cutoff);
  const fixtureIds = (fixtures ?? []).map((f) => f.id);
  if (fixtureIds.length === 0) return;
  const { data: markets } = await admin.from("markets").select("id").in("fixture_id", fixtureIds);
  const { data: posts } = await admin.from("posts").select("id").in("fixture_id", fixtureIds);
  const marketIds = (markets ?? []).map((m) => m.id);
  const postIds = (posts ?? []).map((p) => p.id);
  // Comments can't be hard-deleted by service_role; they leave with their authors.
  if (postIds.length) {
    const { data: comments } = await admin.from("post_comments").select("user_id").in("post_id", postIds);
    for (const userId of new Set((comments ?? []).map((c) => c.user_id as string))) await admin.auth.admin.deleteUser(userId);
  }
  if (marketIds.length) await admin.from("predictions").delete().in("market_id", marketIds);
  if (postIds.length) await admin.from("posts").delete().in("id", postIds);
  if (marketIds.length) await admin.from("markets").delete().in("id", marketIds);
  await admin.from("fixtures").delete().in("id", fixtureIds);
}

test.beforeAll(async () => {
  await sweepStaleSeeds();
  await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
  const commenter = await createUser("a", PRIVATE_NAME);
  const other = await createUser("b", "Another Person");
  // Soonest kickoffs (but beyond the Pick cutoff) so these lead the timeline whatever else the shared test database holds.
  const game = await seedGame(HOME, AWAY, 20);
  seeded.postId = game.postId;
  seeded.marketId = game.marketId;
  await pick(commenter.id, game.marketId, "YES");
  await pick(other.id, game.marketId, "NO");
  await admin.from("post_comments").insert({ post_id: game.postId, user_id: commenter.id, body: PRIVATE_COMMENT });
  await seedGame(LONG_HOME, LONG_AWAY, 21);
  await seedTeamCommunity();
});

test.afterAll(async () => {
  // Users FIRST: service_role cannot DELETE post_comments (comments are tombstoned, never hard-deleted), so a comment can only
  // go away with its author. Deleting the Post before that fails on the comment foreign key and then strands the Fixture too.
  for (const id of seeded.userIds) await admin.auth.admin.deleteUser(id);
  if (seeded.marketIds.length) await admin.from("predictions").delete().in("market_id", seeded.marketIds);
  if (seeded.postIds.length) await admin.from("posts").delete().in("id", seeded.postIds);
  if (seeded.marketIds.length) await admin.from("markets").delete().in("id", seeded.marketIds);
  if (seeded.fixtureIds.length) await admin.from("fixtures").delete().in("id", seeded.fixtureIds);
  if (seeded.communityIds.length) await admin.from("communities").delete().in("id", seeded.communityIds);
  if (seeded.teamIds.length) await admin.from("teams").delete().in("id", seeded.teamIds);
});

async function expectNoHorizontalScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(iw);
}

const gameArticle = (page: Page) => page.getByRole("article", { name: `Game: ${AWAY} at ${HOME}` });

test.describe("Logged-out front door — desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("is the public face of the network: platform-published Games, aggregate sentiment, a comment count, two ways in", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle(/Sports opinions should have a record/);

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Sports opinions should have a record." })).toBeVisible();
    await expect(page.getByText("Pick a side. Talk shit. Call BS. See who was right.").filter({ visible: true })).toHaveCount(1);

    const game = gameArticle(page);
    await expect(game).toBeVisible();
    await expect(game).toContainText(`${AWAY} @`);
    await expect(game).toContainText("Brohda · NFL");
    await expect(game.getByText("Game published by")).toBeAttached();
    await expect(game).toContainText("2 predicted");
    await expect(game).toContainText("1 comment");
    await expect(page.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    await expect(page.getByRole("link", { name: "Log in" }).first()).toHaveAttribute("href", "/login");
  });

  test("never shows a comment, a person or a Pick — only counts", async ({ page }) => {
    await page.goto("/");
    await expect(gameArticle(page)).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toContain(PRIVATE_COMMENT);
    expect(body).not.toContain(PRIVATE_NAME);
    expect(body).not.toContain("Another Person");
    expect(body).not.toMatch(/prediction accuracy|you picked/i);
  });

  test("has no composer and no authorship cue: nothing implies a person created a Game", async ({ page }) => {
    await page.goto("/");
    await expect(gameArticle(page)).toBeVisible();
    expect(await page.locator("textarea").count()).toBe(0);
    expect(await page.locator("form").count()).toBe(0);
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/what['’]s on your mind|create post|new post|\bcompose\b|create prediction|publish event|post event|new game|\bpublish\b|posted by|authored by/i);
  });

  test("zero-leak audit: no pool-era, money or promotional language anywhere on the page", async ({ page }) => {
    await page.goto("/");
    await expect(gameArticle(page)).toBeVisible();
    const everything = `${await page.locator("body").innerText()}\n${await page.locator("body").evaluate((el) => el.innerHTML)}\n${await page.title()}\n${(await page.locator('meta[name="description"]').getAttribute("content")) ?? ""}`;
    const forbidden = /\b(pools?|leaderboards?|analytics|winnings|stakes?|wallet|payout|put money on it|bet|bets|betting|wager|usdt|real money|no money)\b/i;
    const hit = everything.match(forbidden);
    expect(hit, `unexpected landing copy: ${hit?.[0]}`).toBeNull();
    await expect(page.getByRole("button", { name: /put money on it/i })).toHaveCount(0);
    await expect(page.getByText(/put money on it/i)).toHaveCount(0);
  });

  test("has real, working navigation: left context, Game links, Terms and Privacy; a Pick or a Post leads to an account", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("complementary", { name: "About Brohda" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Join Brohda" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Terms" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy" }).first()).toBeVisible();

    const game = gameArticle(page);
    await expect(game.getByRole("link", { name: new RegExp(`${AWAY} @`) })).toHaveAttribute("href", `/post/${seeded.postId}`);

    // A Pick click is an intent click, not an anonymous Pick: it routes to sign-up and records nothing.
    // Counted for this Game's own Market only: seeding and cleanup run once per worker, so a global count would race.
    const picksOnThisGame = async () => (await admin.from("predictions").select("id", { count: "exact", head: true }).eq("market_id", seeded.marketId)).count;
    const before = await picksOnThisGame();
    await game.getByRole("link", { name: /^Pick: .* \(create an account/ }).first().click();
    await expect(page).toHaveURL(/\/register$/);
    expect(await picksOnThisGame()).toBe(before);

    // A Post link is real; Post detail needs an account today, so the visitor is sent to log in.
    await page.goto("/");
    await gameArticle(page).getByRole("link", { name: new RegExp(`${AWAY} @`) }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("centre column: Upcoming games over Sports | Leagues | Teams, Sports by default; tabs switch real content", async ({ page }) => {
    await page.goto("/");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 2, name: "Upcoming games" })).toBeVisible();
    await expect(main.getByRole("tab")).toHaveText(["Sports", "Leagues", "Teams"]);
    await expect(main.getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "true");
    await expect(gameArticle(page)).toBeVisible();

    // The active tab carries a visible underline (the other two don't).
    const underline = (name: string) => main.getByRole("tab", { name }).evaluate((el) => getComputedStyle(el).borderBottomColor);
    expect(await underline("Sports")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await underline("Leagues")).toBe("rgba(0, 0, 0, 0)");

    // Leagues / Teams: Discovery's own Community lists (or its empty copy) — never Game Posts.
    for (const [label, key, empty] of [["Leagues", "leagues", "No leagues to show yet."], ["Teams", "teams", "No teams to show yet."]] as const) {
      await main.getByRole("tab", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`/\\?tab=${key}$`));
      await expect(main.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("article")).toHaveCount(0);
      const rows = main.getByRole("listitem");
      if ((await rows.count()) === 0) await expect(main.getByText(empty)).toBeVisible();
      else await expect(rows.first().getByRole("link")).toHaveAttribute("href", /^\/community\//);
      await expect(main.getByRole("button", { name: /follow/i })).toHaveCount(0);
    }
    // Teams lists the real Community, linking to its page (which asks a visitor to log in).
    await main.getByRole("tab", { name: "Teams" }).click();
    await expect(main.getByRole("link", { name: TEAM_NAME })).toHaveAttribute("href", `/community/${TEAM_SLUG}`);
    await main.getByRole("link", { name: TEAM_NAME }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/");
    await main.getByRole("tab", { name: "Sports" }).click();
    await expect(gameArticle(page)).toBeVisible();

    // A direct link opens the right tab; an unknown value falls back to Sports.
    await page.goto("/?tab=teams");
    await expect(main.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "true");
    await page.goto("/?tab=nonsense");
    await expect(main.getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "true");
  });

  test("the left sidebar stays restrained: search, one line about Brohda, legal — no Sports/Leagues/Teams links", async ({ page }) => {
    await page.goto("/");
    const left = page.getByRole("complementary", { name: "About Brohda" });
    await expect(left.getByRole("link", { name: /Search/ })).toHaveAttribute("href", "/login");
    await expect(left.getByText("Brohda is a social network for people who think they know sports.")).toBeVisible();
    await expect(left.getByRole("link", { name: "Terms" })).toBeVisible();
    await expect(left.getByRole("link", { name: "Privacy" })).toBeVisible();
    for (const label of ["Sports", "Leagues", "Teams"]) await expect(left.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    // The desktop layout has no bottom bar or hamburger.
    await expect(page.getByTestId("public-bottom-bar")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
  });

  test("a signed-in visitor goes straight into the app", async ({ page }) => {
    const member = await createUser("member", "Front Door Member");
    await page.goto("/login");
    await page.getByLabel("Email").fill(member.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/feed$/);
  });

  test("has no horizontal overflow at 1280", async ({ page }) => {
    await page.goto("/");
    await expect(gameArticle(page)).toBeVisible();
    await expectNoHorizontalScroll(page, "1280");
  });
});

test.describe("Logged-out front door — large desktop", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test("keeps its three columns centred without overflow", async ({ page }) => {
    await page.goto("/");
    await expect(gameArticle(page)).toBeVisible();
    await expect(page.getByRole("complementary", { name: "About Brohda" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Join Brohda" })).toBeVisible();
    await expectNoHorizontalScroll(page, "1920");
    const feed = await gameArticle(page).boundingBox();
    expect(feed!.width, "centre feed stays a readable column").toBeLessThanOrEqual(640);
  });
});

test.describe("Logged-out front door — tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 } });
  test("shows the feed with one account column that also carries the legal links", async ({ page }) => {
    await page.goto("/");
    await expect(gameArticle(page)).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Join Brohda" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "About Brohda" })).toHaveCount(0); // not rendered at this width
    await expect(page.getByRole("complementary", { name: "Join Brohda" }).getByRole("link", { name: "Terms" })).toBeVisible(); // legal moves to the right column
    await expect(page.getByTestId("public-bottom-bar")).toBeHidden(); // the bar and hamburger are phone-only
    await expect(page.getByRole("main").getByRole("tab")).toHaveText(["Sports", "Leagues", "Teams"]);
    await expectNoHorizontalScroll(page, "768");
  });
});

test.describe("Logged-out front door — mobile (Mastodon pattern: the feed is the page)", () => {
  for (const width of [375, 360]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 800 } });

      test("the centre feed is the page: no side columns, Upcoming games, three tabs, Game Posts first", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByRole("complementary")).toHaveCount(0); // neither desktop sidebar is stacked above or below
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { level: 2, name: "Upcoming games" })).toBeVisible();
        await expect(main.getByRole("tab")).toHaveText(["Sports", "Leagues", "Teams"]);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1); // one h1, for assistive tech
        await expect(page.getByText("Pick a side. Talk shit. Call BS. See who was right.").filter({ visible: true })).toHaveCount(0); // no stacked marketing intro

        // The feed starts quickly: the first Game Post is already on screen without scrolling.
        // (The first article, not ours: other seeded Games can legitimately sort ahead of this spec's.)
        const first = page.getByRole("article").first();
        await expect(first).toBeVisible();
        const tabsBox = (await main.getByRole("tab", { name: "Sports" }).boundingBox())!;
        const gameBox = (await first.boundingBox())!;
        expect(gameBox.y, "feed starts in the first screen").toBeLessThan(800 - 150);
        expect(gameBox.y).toBeGreaterThan(tabsBox.y);
      });

      test("fixed bottom bar: Create account and Log in always visible, hamburger bottom-right, safe-area padded", async ({ page }) => {
        await page.goto("/");
        const bar = page.getByTestId("public-bottom-bar");
        const create = bar.getByRole("link", { name: "Create account" });
        const login = bar.getByRole("link", { name: "Log in" });
        const burger = bar.getByRole("button", { name: "Open menu" });
        await expect(create).toBeVisible();
        await expect(login).toBeVisible();
        await expect(burger).toBeVisible();
        await expect(create).toHaveAttribute("href", "/register");
        await expect(login).toHaveAttribute("href", "/login");

        // Still there after scrolling the whole feed, and the hamburger is the right-most control.
        await page.mouse.wheel(0, 6000);
        for (const el of [create, login, burger]) await expect(el).toBeVisible();
        const [c, l, b] = await Promise.all([create.boundingBox(), login.boundingBox(), burger.boundingBox()]);
        expect(c!.x).toBeLessThan(l!.x);
        expect(l!.x + l!.width).toBeLessThanOrEqual(b!.x);
        expect(b!.x + b!.width, "hamburger hugs the right edge").toBeGreaterThan(width - 24);
        expect(b!.y + b!.height, "bar sits at the bottom").toBeGreaterThan(800 - 24);
        expect(b!.width, "touch target").toBeGreaterThanOrEqual(40);
        expect(b!.height, "touch target").toBeGreaterThanOrEqual(40);
        expect(c!.height, "touch target").toBeGreaterThanOrEqual(36);
        await expect(bar).toHaveCSS("position", "fixed");
        expect(await bar.evaluate((el) => el.className)).toContain("env(safe-area-inset-bottom)");
      });

      test("the bottom bar never covers the end of the feed, and the title + tabs stay in reach while scrolling", async ({ page }) => {
        await page.goto("/");
        await expect(gameArticle(page)).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const bar = (await page.getByTestId("public-bottom-bar").boundingBox())!;
        const articles = page.getByRole("article");
        const last = (await articles.last().boundingBox())!;
        expect(last.y + last.height, "last Game Post ends above the bar").toBeLessThanOrEqual(bar.y);
        // Sticky header: still visible at the very bottom of the page.
        await expect(page.getByRole("heading", { level: 2, name: "Upcoming games" })).toBeVisible();
        await expect(page.getByRole("tab", { name: "Teams" })).toBeVisible();
      });

      test("hamburger menu: opens a labelled sheet, Escape closes it and restores focus, its links work", async ({ page }) => {
        await page.goto("/");
        const burger = page.getByRole("button", { name: "Open menu" });
        await burger.click();
        const menu = page.getByRole("dialog");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("heading", { name: "Menu" })).toBeVisible();
        await expect(menu.getByRole("link")).toHaveText(["SearchLog in to search", "Sports", "Leagues", "Teams", "Terms", "Privacy"]);
        await expect(menu.getByRole("heading", { name: "About Brohda" })).toBeVisible();
        await expect(menu.getByText("Brohda is a social network for people who think they know sports.")).toBeVisible();
        const menuBox = (await menu.boundingBox())!;
        expect(menuBox.x).toBeGreaterThanOrEqual(0);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width + 0.5);
        await expectNoHorizontalScroll(page, `${width} (menu open)`);
        // Account actions never move into the menu.
        await expect(menu.getByRole("link", { name: /Create account|Log in$/ })).toHaveCount(0);

        // Keyboard: focus is inside the sheet; Escape closes it and focus returns to the trigger.
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), "focus trapped").toBe(true);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(burger).toBeFocused();

        // The close button closes too.
        await burger.click();
        await page.getByRole("button", { name: "Close menu" }).click();
        await expect(menu).toBeHidden();

        // Navigation: a tab shortcut closes the sheet and switches the centre tab.
        await burger.click();
        await page.getByRole("dialog").getByRole("link", { name: "Leagues" }).click();
        await expect(page).toHaveURL(/\/\?tab=leagues$/);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByRole("main").getByRole("tab", { name: "Leagues" })).toHaveAttribute("aria-selected", "true");

        // Legal and Search links lead where they say.
        await burger.click();
        await page.getByRole("dialog").getByRole("link", { name: "Privacy" }).click();
        await expect(page).toHaveURL(/\/privacy$/);
        await page.goBack();
        await burger.click();
        await page.getByRole("dialog").getByRole("link", { name: /^Search/ }).click();
        await expect(page).toHaveURL(/\/login$/);
      });

      test("no way to create content or touch money; Picks lead to sign-up; the tab bar switches the feed", async ({ page }) => {
        await page.goto("/");
        await expect(gameArticle(page)).toBeVisible();
        await page.getByRole("button", { name: "Open menu" }).click();
        const everything = `${await page.locator("body").innerText()}\n${await page.locator("body").evaluate((el) => el.innerHTML)}`;
        expect(everything).not.toMatch(/create post|new post|create game|create prediction|what['’]s on your mind|publish event|new game|\bpublish\b/i);
        expect(everything).not.toMatch(/\b(pools?|leaderboards?|analytics|winnings|stakes?|wallet|payout|put money on it|bet|bets|betting|wager|usdt|real money|no money)\b/i);
        expect(await page.locator("textarea").count()).toBe(0);
        await page.keyboard.press("Escape");

        await page.getByRole("main").getByRole("tab", { name: "Teams" }).click();
        await expect(page).toHaveURL(/\/\?tab=teams$/);
        await expect(page.getByRole("article")).toHaveCount(0);
        await page.getByRole("main").getByRole("tab", { name: "Sports" }).click();
        await expect(gameArticle(page)).toBeVisible();
        await gameArticle(page).getByRole("link", { name: /^Pick: .* \(create an account/ }).first().click();
        await expect(page).toHaveURL(/\/register$/);
      });

      test("long names stay inside the screen and nothing overflows horizontally", async ({ page }) => {
        await page.goto("/");
        const longGame = page.getByRole("article", { name: `Game: ${LONG_AWAY} at ${LONG_HOME}` });
        await longGame.scrollIntoViewIfNeeded();
        const longBox = (await longGame.boundingBox())!;
        expect(longBox.x).toBeGreaterThanOrEqual(0);
        expect(longBox.x + longBox.width).toBeLessThanOrEqual(width + 0.5);
        await expectNoHorizontalScroll(page, `${width}`);
      });
    });
  }
});
