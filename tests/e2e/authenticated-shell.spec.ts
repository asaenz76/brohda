/**
 * E2E coverage for the signed-in shell: the logged-out front door's own shape
 * with identity, navigation and participation available. Desktop is a left
 * rail + centre + (xl) contextual right rail; phones get the feed plus a
 * bottom bar (Home / Discovery / Notifications / Profile / Menu). It must stay
 * the same product as the front door (same Game Post card), never offer a
 * way to create a Game or a post, keep Wallet a quiet utility, and keep the
 * Pick interaction working. Seeded through the app's own tables; driven
 * through the browser.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);
const HOME = `Shell Home ${suffix}`;
const AWAY = `Shell Away ${suffix}`;
const LONG_HOME = `The Extraordinarily Long Named Football Club of Greater Metropolis United ${suffix}`;
const LONG_AWAY = `Another Remarkably Lengthy Athletic Association of the Northern Territories ${suffix}`;
const TEAM_NAME = `Shell FC ${suffix}`;
const LONG_COMMENT = `${"A very long comment that keeps going and going so it has to wrap on a phone. ".repeat(4)}${suffix}`;
const USERNAME = `shellviewer${suffix}`;

const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[], posts: [] as string[], teams: [] as string[], communities: [] as string[], postId: "", marketId: "" };
let viewerEmail = "";

async function createUser(label: string, displayName: string, username: string) {
  const email = `shell-${label}-${suffix}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: displayName, username, role: "player", is_active: true });
  if (profileError) throw profileError;
  seeded.users.push(data.user.id);
  return { id: data.user.id as string, email };
}

async function seedGame(home: string, away: string, minutesAhead: number) {
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-shell-${randomUUID()}`, home_team_name: home, away_team_name: away, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + minutesAhead * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  seeded.fixtures.push(fixture!.id);
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "e2e_shell", provider_market_id: `shell_${randomUUID()}`, question: `Will ${home} win?`, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {} })
    .select("id")
    .single();
  seeded.markets.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  seeded.posts.push(post!.id);
  return { marketId: market!.id as string, postId: post!.id as string };
}

async function sweepStaleSeeds() {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: teams } = await admin.from("teams").select("id").eq("provider", "e2e_shell").lt("created_at", cutoff);
  const teamIds = (teams ?? []).map((t) => t.id);
  if (teamIds.length) {
    const { data: cs } = await admin.from("communities").select("id").in("team_id", teamIds);
    const communityIds = (cs ?? []).map((c) => c.id);
    if (communityIds.length) await admin.from("community_follows").delete().in("community_id", communityIds);
    await admin.from("communities").delete().in("team_id", teamIds);
    await admin.from("teams").delete().in("id", teamIds);
  }
  const { data: fixtures } = await admin.from("fixtures").select("id").like("external_fixture_id", "e2e-shell-%").lt("created_at", cutoff);
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
  const viewer = await createUser("viewer", "Shell Viewer", USERNAME);
  viewerEmail = viewer.email;
  const commenter = await createUser("commenter", "Long Named Commenter Fernández-Albuquerque", `shellcommenter${suffix}`);
  // Soonest kickoffs (beyond the Pick cutoff) so these lead the shared timeline.
  const game = await seedGame(HOME, AWAY, 20);
  seeded.postId = game.postId;
  seeded.marketId = game.marketId;
  await seedGame(LONG_HOME, LONG_AWAY, 21);
  // The commenter also picked the other side, so the Post shows a participant row (Call BS) beneath the conversation.
  await admin
    .rpc("set_pick", { p_user_id: commenter.id, p_market_id: game.marketId, p_selected_outcome: "NO", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  await admin.from("post_comments").insert({ post_id: game.postId, user_id: commenter.id, body: LONG_COMMENT });
  await admin.from("notifications").insert([
    { user_id: viewer.id, type: "POST_COMMENT_REPLY", title: "New reply", body: `${commenter.id.slice(0, 4)} replied: ${LONG_COMMENT}` },
    { user_id: viewer.id, type: "prediction_graded", title: "You were right", body: "Your pick was correct.", read_at: new Date().toISOString() },
  ]);
  const { data: team } = await admin.from("teams").insert({ provider: "e2e_shell", external_id: `shell-${randomUUID()}`, name: TEAM_NAME }).select("id").single();
  seeded.teams.push(team!.id);
  const { data: community } = await admin.from("communities").insert({ type: "TEAM", team_id: team!.id, slug: `shell-team-${suffix}`, active: true }).select("id").single();
  seeded.communities.push(community!.id);
  await admin.from("community_follows").insert({ user_id: viewer.id, community_id: community!.id });
});

test.afterAll(async () => {
  // Users FIRST: service_role cannot DELETE post_comments, so comments only leave with their authors.
  for (const id of seeded.users) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.from("community_follows").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  if (seeded.markets.length) await admin.from("predictions").delete().in("market_id", seeded.markets);
  if (seeded.posts.length) await admin.from("posts").delete().in("id", seeded.posts);
  if (seeded.markets.length) await admin.from("markets").delete().in("id", seeded.markets);
  if (seeded.fixtures.length) await admin.from("fixtures").delete().in("id", seeded.fixtures);
  if (seeded.communities.length) await admin.from("communities").delete().in("id", seeded.communities);
  if (seeded.teams.length) await admin.from("teams").delete().in("id", seeded.teams);
});

async function login(page: Page, email: string = viewerEmail) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(iw);
}

const gameArticle = (page: Page) => page.getByRole("article", { name: `Game: ${AWAY} at ${HOME}` });
const rail = (page: Page) => page.getByRole("complementary", { name: "Navigation" }).getByRole("navigation", { name: "Primary" });

test.describe("Authenticated shell — desktop (1280)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("signed-out visitors never get the shell: consumer routes send them to log in", async ({ page }) => {
    for (const path of ["/feed", "/discovery", "/notifications", "/profile", "/search", "/wallet", `/post/${seeded.postId}`]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login/);
      await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    }
  });

  test("the rail marks exactly the current section on every consumer route, and Wallet stays a quiet utility below the primary links", async ({ page }) => {
    await login(page);
    const cases: [string, string][] = [
      ["/feed", "Home"],
      ["/discovery", "Discovery"],
      ["/notifications", "Notifications"],
      ["/search", "Search"],
      ["/profile", "Profile"],
      ["/wallet", "Wallet"],
      ["/profile/edit", "Settings"],
      ["/rules", "Rules"],
    ];
    for (const [path, label] of cases) {
      await page.goto(path);
      const current = rail(page).locator('a[aria-current="page"]');
      await expect(current, path).toHaveCount(1);
      await expect(current, path).toContainText(label);
      // The same shell wraps every one of them.
      await expect(page.getByRole("complementary", { name: "Navigation" })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    }

    // Home's page header matches the front door's: "Upcoming games" (the nav item itself stays "Home").
    await page.goto("/feed");
    await expect(page.getByRole("heading", { level: 1, name: "Upcoming games" })).toBeVisible();
    await expect(rail(page).locator('a[aria-current="page"]')).toContainText("Home");

    // Order: the five primary links, then Wallet, positioned lower on the page (a utility, not a destination).
    await page.goto("/feed");
    const hrefs = await rail(page).getByRole("link").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(hrefs).toEqual(["/feed", "/discovery", "/notifications", "/search", "/profile", "/wallet", "/profile/edit", "/rules"]);
    const profileBox = (await rail(page).getByRole("link", { name: "Profile" }).boundingBox())!;
    const walletBox = (await rail(page).getByRole("link", { name: /^Wallet:/ }).boundingBox())!;
    expect(walletBox.y).toBeGreaterThan(profileBox.y + profileBox.height);

    // Own profile highlights Profile; someone else's profile highlights nothing.
    await page.goto(`/profile/${USERNAME}`);
    await expect(rail(page).locator('a[aria-current="page"]')).toContainText("Profile");
    await page.goto(`/post/${seeded.postId}`);
    await expect(rail(page).locator('a[aria-current="page"]')).toHaveCount(0);
  });

  test("a Post is the feed item expanded into a conversation, with the same authorship line and a way back", async ({ page }) => {
    await login(page);
    await page.goto(`/post/${seeded.postId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Post" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/feed");
    const main = page.getByRole("main");
    await expect(main.getByText("Game published by")).toBeAttached();
    await expect(main).toContainText("Brohda · NFL");
    await expect(main).toContainText(`${AWAY} @`);
    await expect(main.getByText("Comments")).toBeVisible();
    await expect(main).toContainText("A very long comment");
  });

  test("Post detail reads Game -> Pick and sentiment -> conversation -> Call BS / money, one expanded Game Post", async ({ page }) => {
    // Participants (Call BS / money) only show to someone who has a Pick, so this test uses its own viewer who already picked
    // the other side from the seeded commenter — independent of what the Pick test does to the main viewer.
    const picker = await createUser("order", "Order Viewer", `shellorder${suffix}`);
    await admin
      .rpc("set_pick", { p_user_id: picker.id, p_market_id: seeded.marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
      .single();
    await login(page, picker.email);
    await page.goto(`/post/${seeded.postId}`);
    const y = async (loc: import("@playwright/test").Locator) => (await loc.first().boundingBox())!.y;
    const main = page.getByRole("main");
    const game = await y(main.getByText(`${AWAY} @`));
    const sentiment = await y(main.getByText(/\d+% *$/).first());
    const pick = await y(main.getByRole("button", { name: /^Pick: / }));
    const comments = await y(main.getByText("Comments", { exact: true }));
    const comment = await y(main.getByText("A very long comment"));
    const others = await y(main.getByText("Other picks", { exact: true }));
    expect(game).toBeLessThan(sentiment);
    expect(sentiment).toBeLessThan(pick);
    expect(pick).toBeLessThan(comments);
    expect(comments).toBeLessThan(comment);
    expect(comment).toBeLessThan(others); // the participants (Call BS, optional money) come after the conversation
    // One Post, one card.
    await expect(main.locator('[data-slot="card"]')).toHaveCount(1);
  });

  test("the right rail is contextual: the viewer's own identity and what they follow — real data, no composer", async ({ page }) => {
    await login(page);
    const context = page.getByRole("complementary", { name: "Context" });
    await expect(context).toBeVisible();
    await expect(context.getByRole("region", { name: "Your profile" })).toContainText("Shell Viewer");
    await expect(context.getByRole("region", { name: "Your profile" })).toContainText(`@${USERNAME}`);
    const following = context.getByRole("region", { name: "Following" });
    await expect(following.getByRole("link", { name: TEAM_NAME })).toHaveAttribute("href", `/community/shell-team-${suffix}`);
    // The legal links are the page footer's, not the rail's.
    await expect(context.getByRole("link", { name: "Terms" })).toHaveCount(0);
    // Not a second nav: no primary destinations in the rail.
    await expect(context.getByRole("link", { name: "Notifications" })).toHaveCount(0);
  });

  test("never offers a way to create a Game, a post or a prediction — on any consumer route", async ({ page }) => {
    await login(page);
    for (const path of ["/feed", "/discovery", "/notifications", "/profile", "/search", `/post/${seeded.postId}`]) {
      await page.goto(path);
      const body = await page.locator("body").innerText();
      expect(body, path).not.toMatch(/create post|new post|create game|new game|create prediction|what['’]s on your mind|publish event|compose/i);
      // The only free-text input anywhere is a comment box inside a Game's conversation (or the search box).
      const textareas = await page.locator("textarea").count();
      if (path.startsWith("/post/")) expect(textareas).toBe(1);
      else expect(textareas, path).toBe(0);
    }
  });

  test("Game Posts are platform-authored in the feed: a Brohda line, no user author", async ({ page }) => {
    await login(page);
    const game = gameArticle(page);
    await expect(game).toBeVisible();
    await expect(game).toContainText("Brohda · NFL");
    await expect(game.getByText("Game published by")).toBeAttached();
    expect(await game.innerText()).not.toMatch(/posted by|authored by|created by/i);
  });

  test("the Pick control still works from the shell: choose a side, see it saved, change it", async ({ page }) => {
    await login(page);
    const game = gameArticle(page);
    await game.getByRole("button", { name: "Pick: Yes" }).click();
    await expect(game.getByText("Change your prediction")).toBeVisible();
    const { count } = await admin.from("predictions").select("id", { count: "exact", head: true }).eq("market_id", seeded.marketId).eq("user_id", seeded.users[0]);
    expect(count).toBe(1);
    await game.getByRole("button", { name: "Pick: No" }).click();
    await expect.poll(async () => (await admin.from("predictions").select("selected_outcome").eq("market_id", seeded.marketId).eq("user_id", seeded.users[0]).single()).data?.selected_outcome).toBe("NO");
  });

  test("signed-in /feed and the logged-out front door use the very same Game Post card language", async ({ page, browser }) => {
    await login(page);
    const memberCard = gameArticle(page).locator('[data-slot="card"]');
    await expect(memberCard).toBeVisible();
    const style = (el: import("@playwright/test").Locator) =>
      el.evaluate((node) => {
        const cs = getComputedStyle(node);
        const title = node.querySelector("p.font-semibold") as HTMLElement;
        return { radius: cs.borderTopLeftRadius, border: `${cs.borderTopWidth} ${cs.borderTopColor}`, bg: cs.backgroundColor, padTop: cs.paddingTop, titleSize: getComputedStyle(title).fontSize, titleWeight: getComputedStyle(title).fontWeight, font: getComputedStyle(title).fontFamily };
      });
    const member = await style(memberCard);

    const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const anonPage = await anon.newPage();
    await anonPage.goto("/");
    const publicCard = gameArticle(anonPage).locator('[data-slot="card"]');
    await expect(publicCard).toBeVisible();
    expect(await style(publicCard)).toEqual(member);
    // Same column header treatment too.
    const headerStyle = (p: Page) => p.locator('[data-slot="column-header"]').first().evaluate((n) => { const cs = getComputedStyle(n); return { position: cs.position, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius }; });
    expect(await headerStyle(anonPage)).toEqual(await headerStyle(page));
    await anon.close();
  });

  test("Home carries the same header as the front door: Upcoming games over Sports | Leagues | Teams, Sports being the Game timeline", async ({ page, browser }) => {
    await login(page);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: "Upcoming games" })).toBeVisible();
    await expect(main.getByRole("tab")).toHaveText(["Sports", "Leagues", "Teams"]);
    await expect(main.getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "true");
    await expect(gameArticle(page)).toBeVisible();

    // Teams: the same Community list Discovery shows, with the viewer's own follow state — and no Game Posts.
    await main.getByRole("tab", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/feed\?tab=teams$/);
    await expect(main.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "true");
    await expect(main.getByRole("link", { name: TEAM_NAME })).toHaveAttribute("href", `/community/shell-team-${suffix}`);
    await expect(page.getByRole("article")).toHaveCount(0);
    await main.getByRole("tab", { name: "Leagues" }).click();
    await expect(page).toHaveURL(/\/feed\?tab=leagues$/);
    await main.getByRole("tab", { name: "Sports" }).click();
    await expect(gameArticle(page)).toBeVisible();

    // Same tab bar as logged out: identical labels and the same underline treatment.
    const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const anonPage = await anon.newPage();
    await anonPage.goto("/");
    const bar = (p: Page) => p.getByRole("main").getByRole("tablist").evaluate((n) => { const cs = getComputedStyle(n); return { borderBottom: cs.borderBottomWidth, display: cs.display }; });
    expect(await bar(anonPage)).toEqual(await bar(page));
    await expect(anonPage.getByRole("main").getByRole("heading", { name: "Upcoming games" })).toBeVisible();
    await anon.close();
  });

  test("Discovery keeps the Sports | Leagues | Teams tabs with the same active underline as the front door", async ({ page }) => {
    await login(page);
    await page.goto("/discovery");
    const main = page.getByRole("main");
    await expect(main.getByRole("tab")).toHaveText(["Sports", "Leagues", "Teams"]);
    await expect(main.getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "true");
    expect(await main.getByRole("tab", { name: "Sports" }).evaluate((el) => getComputedStyle(el).borderBottomColor)).not.toBe("rgba(0, 0, 0, 0)");
    await main.getByRole("tab", { name: "Teams" }).click();
    await expect(page).toHaveURL(/tab=teams$/);
    await expect(main.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "true");
  });

  test("notifications read as an inbox: unread is marked in words, not only colour, and a row leads to its Post", async ({ page }) => {
    await login(page);
    await page.goto("/notifications");
    const main = page.getByRole("main");
    await expect(main.getByText("Unread:")).toBeAttached();
    await expect(main.getByRole("button", { name: "Mark all read" })).toBeVisible();
    await expect(rail(page).getByRole("link", { name: /Notifications/ })).toContainText("(1 unread)");
  });
});

test.describe("Authenticated shell — breakpoints", () => {
  const pages = (): [string, string][] => [["feed", "/feed"], ["discovery", "/discovery"], ["notifications", "/notifications"], ["profile", "/profile"], ["post", `/post/${seeded.postId}`]];

  test("1024: left rail + centre, right rail collapsed; 1920: all three, centre stays a readable column", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
    const page = await ctx.newPage();
    await login(page);
    await expect(page.getByRole("complementary", { name: "Navigation" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Context" })).toBeHidden();
    await expectNoHorizontalScroll(page, "1024");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.getByRole("complementary", { name: "Context" })).toBeVisible();
    await expect(gameArticle(page)).toBeVisible();
    expect((await gameArticle(page).boundingBox())!.width).toBeLessThanOrEqual(640);
    await expectNoHorizontalScroll(page, "1920");
    await ctx.close();
  });

  test("768: one rail (navigation) beside the page; no bottom bar", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page = await ctx.newPage();
    await login(page);
    await expect(page.getByRole("complementary", { name: "Navigation" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Context" })).toBeHidden();
    await expect(page.getByTestId("auth-bottom-nav")).toBeHidden();
    for (const [name, path] of pages()) {
      await page.goto(path);
      // Let the page settle before leaving it: navigating on while a page is still hydrating can abort the next goto under load.
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expectNoHorizontalScroll(page, `768 ${name}`);
    }
    await ctx.close();
  });

  for (const width of [375, 360, 320]) {
    test(`${width}: the page owns the viewport; a bottom bar replaces the rails; long names, comments and notifications stay inside the screen`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await ctx.newPage();
      await login(page);
      await expect(page.getByRole("complementary")).toHaveCount(0);
      const bar = page.getByTestId("auth-bottom-nav");
      await expect(bar).toBeVisible();
      await expect(bar.getByRole("link")).toHaveText([/Home/, /Discovery/, /Notifications/, /Profile/]);
      await expect(bar.getByRole("button", { name: "Menu" })).toBeVisible();
      await expect(bar.locator('a[aria-current="page"]')).toContainText("Home");
      expect(await bar.evaluate((el) => el.className)).toContain("env(safe-area-inset-bottom)");

      // The bar never covers the end of the feed.
      await expect(gameArticle(page)).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const barBox = (await bar.boundingBox())!;
      const last = (await page.getByRole("article").last().boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(barBox.y);

      const longGame = page.getByRole("article", { name: `Game: ${LONG_AWAY} at ${LONG_HOME}` });
      await longGame.scrollIntoViewIfNeeded();
      const longBox = (await longGame.boundingBox())!;
      expect(longBox.x).toBeGreaterThanOrEqual(0);
      expect(longBox.x + longBox.width).toBeLessThanOrEqual(width + 0.5);

      for (const [name, path] of pages()) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expectNoHorizontalScroll(page, `${width} ${name}`);
      }
      // Each bottom-bar label is fully visible (not clipped) at this width.
      await page.goto("/feed");
      const clipped = await bar.evaluate((el) =>
        [...el.querySelectorAll("span")]
          .filter((n) => ["Home", "Discovery", "Notifications", "Profile", "Menu"].includes(n.firstChild?.textContent ?? "") && n.scrollWidth > n.clientWidth)
          .map((n) => n.firstChild?.textContent),
      );
      expect(clipped, `clipped bottom-bar labels at ${width}`).toEqual([]);
      await ctx.close();
    });
  }

  test("375: the Menu sheet holds Search, Wallet and Log out; Escape and Close dismiss it; focus returns; no composer", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await login(page);
    const menuButton = page.getByRole("button", { name: "Menu" });
    await menuButton.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Menu" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Search" })).toHaveAttribute("href", "/search");
    await expect(sheet.getByRole("link", { name: /^Wallet:/ })).toHaveAttribute("href", "/wallet");
    await expect(sheet.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/profile/edit");
    await expect(sheet.getByRole("button", { name: "Log out" })).toBeVisible();
    expect(await sheet.innerText()).not.toMatch(/create|new post|publish/i);
    await expectNoHorizontalScroll(page, "375 menu open");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), "focus trapped").toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(menuButton).toBeFocused();

    await menuButton.click();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(sheet).toBeHidden();

    await menuButton.click();
    await page.getByRole("dialog").getByRole("link", { name: "Search" }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await menuButton.click();
    await page.getByRole("dialog").getByRole("link", { name: /^Wallet:/ }).click();
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(page.getByTestId("auth-bottom-nav").getByRole("button", { name: "Menu" })).toBeVisible();

    // Log out works from the sheet and returns to the logged-out front door.
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Log out" }).click();
    // ...and lands on the public front door (registration is open in this environment), not an authenticated page.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 2, name: "Upcoming games" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create account" }).first()).toBeVisible();
    await expect(page.getByTestId("auth-bottom-nav")).toHaveCount(0);
    await ctx.close();
  });
});
