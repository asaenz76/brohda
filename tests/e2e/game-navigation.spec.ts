/**
 * "BACK MEANS WHERE I CAME FROM" and the league crest, in a real browser with real history (no mocked router). Seeds one Game per sport (NFL, NBA, NHL), each
 * with Moneyline + Spread + Total, a Post, and the league crest the provider adapter would have stored on the fixture; test accounts only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

interface League {
  key: "nfl" | "nba" | "nhl";
  sport: string;
  provider: string;
  name: string;
  externalId: string;
  crest: string;
  home: string;
  away: string;
  total: number;
}
// Distinct crest assets per league (all served by the app itself), so a mix-up between leagues is visible in the `src`.
const LEAGUES: League[] = [
  { key: "nfl", sport: "american_football", provider: "api_nfl", name: "NFL", externalId: "1", crest: "/logo-nfl.png", home: "Capitals", away: "Penguins", total: 44.5 },
  { key: "nba", sport: "basketball", provider: "api_nba", name: "NBA", externalId: "12", crest: "/icons/icon-192.png", home: "Celtics", away: "Lakers", total: 228.5 },
  { key: "nhl", sport: "hockey", provider: "api_nhl", name: "NHL", externalId: "57", crest: "/icons/icon-512.png", home: "Bruins", away: "Canadiens", total: 6.5 },
];

async function createPlayer() {
  const email = `e2e-nav-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `nav${Math.floor(Math.random() * 100000)}`, username: `nav${Date.now()}${Math.floor(Math.random() * 1000)}`, role: "player", is_active: true });
  if (profileError) throw profileError;
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

async function seedGame(league: League, suffix: string, opts: { logo?: string | null } = {}) {
  const home = `${league.home} ${suffix}`;
  const away = `${league.away} ${suffix}`;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({
      provider: league.provider,
      external_fixture_id: `e2e-nav-${randomUUID()}`,
      sport: league.sport,
      home_team_name: home,
      away_team_name: away,
      competition_name: league.name,
      competition_external_id: league.externalId,
      competition_logo_url: opts.logo === undefined ? league.crest : opts.logo,
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const base = { provider: league.provider, status: "ACTIVE", fixture_id: fixture.id, yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {} };
  const rows = [
    { ...base, provider_market_id: `nav_ml_${randomUUID()}`, question: "ml?", market_template: "MONEYLINE", yes_side: "HOME", line_value: null },
    { ...base, provider_market_id: `nav_sp_${randomUUID()}`, question: "sp?", market_template: "SPREAD", yes_side: "HOME", line_value: -1.5 },
    { ...base, provider_market_id: `nav_to_${randomUUID()}`, question: "to?", market_template: "TOTAL", yes_side: null, line_value: league.total },
  ];
  const { data: markets, error: marketError } = await admin.from("markets").insert(rows).select("id, market_template");
  if (marketError || !markets) throw marketError ?? new Error("failed to create markets");
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  const id = (template: string) => markets.find((m) => m.market_template === template)!.id as string;
  return { fixtureId: fixture.id as string, postId: post.id as string, home, away, moneylineId: id("MONEYLINE"), spreadId: id("SPREAD"), totalId: id("TOTAL"), marketIds: markets.map((m) => m.id as string) };
}

async function cleanupGame(game: { fixtureId: string; marketIds: string[] }) {
  await admin.from("post_communities").delete().eq("post_id", (await admin.from("posts").select("id").eq("fixture_id", game.fixtureId).maybeSingle()).data?.id ?? "");
  await admin.from("predictions").delete().in("market_id", game.marketIds);
  await admin.from("posts").delete().eq("fixture_id", game.fixtureId);
  await admin.from("markets").delete().in("id", game.marketIds);
  await admin.from("fixtures").delete().eq("id", game.fixtureId);
}

const card = (page: Page, game: { home: string; away: string }) => page.locator("article").filter({ hasText: game.home }).first();

test.describe("Back means where I came from", () => {
  test("Feed → Post → Back = Feed; Feed → Post → Market → Back = Post → Back = Feed (real browser history)", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const game = await seedGame(LEAGUES[2], suffix);
    const user = await createPlayer();
    try {
      await loginAs(page, user.email);
      await page.goto("/feed");
      await card(page, game).getByRole("link", { name: new RegExp(game.home) }).first().click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/\/feed$/);

      await card(page, game).getByRole("link", { name: new RegExp(game.home) }).first().click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      await page.getByRole("link", { name: /Total 6\.5/ }).click();
      await expect(page).toHaveURL(new RegExp(`/markets/${game.totalId}$`));
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/\/feed$/);
    } finally {
      await cleanupGame(game);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  test("Community → Post → Market → Back = Post → Back = Community", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const game = await seedGame(LEAGUES[0], suffix);
    const user = await createPlayer();
    const { data: team } = await admin.from("teams").insert({ provider: "e2e_nav", external_id: `team-${randomUUID()}`, name: game.home }).select("id").single();
    const { data: community } = await admin.from("communities").insert({ type: "TEAM", team_id: team!.id, slug: `e2e-nav-team-${randomUUID()}`, active: true }).select("id, slug").single();
    await admin.from("post_communities").insert({ post_id: game.postId, community_id: community!.id });
    try {
      await loginAs(page, user.email);
      await page.goto(`/community/${community!.slug}`);
      await card(page, game).getByRole("link", { name: new RegExp(game.home) }).first().click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      await page.getByRole("link", { name: /Moneyline|Total|Spread/ }).first().click();
      await expect(page).toHaveURL(/\/markets\//);
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/community/${community!.slug}$`));
    } finally {
      await cleanupGame(game);
      await admin.from("communities").delete().eq("id", community!.id);
      await admin.from("teams").delete().eq("id", team!.id);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  test("a direct deep link: Market → Back = its own Game Post (never the feed); Post → Back = Feed; both survive a reload", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const game = await seedGame(LEAGUES[1], suffix);
    const user = await createPlayer();
    try {
      await loginAs(page, user.email);
      await page.goto(`/markets/${game.totalId}`);
      const back = page.getByRole("link", { name: "Back", exact: true });
      await expect(back).toHaveAttribute("href", `/post/${game.postId}`);
      await page.reload();
      await back.click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      // This Post is now the first page of the app session: Back must take the feed fallback, not leave the app.
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/\/feed$/);

      await page.goto(`/post/${game.postId}`);
      await expect(page.getByRole("link", { name: "Back", exact: true })).toHaveAttribute("href", "/feed");
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/\/feed$/);
    } finally {
      await cleanupGame(game);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  test("refresh on a Market reached from a Post: Back stays safe (lands on the Post) and the app is never left", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const game = await seedGame(LEAGUES[2], suffix);
    const user = await createPlayer();
    try {
      await loginAs(page, user.email);
      await page.goto("/feed");
      await card(page, game).getByRole("link", { name: new RegExp(game.home) }).first().click();
      await page.getByRole("link", { name: /Total 6\.5/ }).click();
      await expect(page).toHaveURL(new RegExp(`/markets/${game.totalId}$`));
      await page.reload();
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
    } finally {
      await cleanupGame(game);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  test("the feed position survives opening a Post and coming back", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const games = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => seedGame(LEAGUES[i % 3], `${suffix}${i}`)));
    const user = await createPlayer();
    try {
      await page.setViewportSize({ width: 375, height: 700 });
      await loginAs(page, user.email);
      await page.goto("/feed");
      // The feed's order is not ours to assume (other Games may sort above or below), so open whichever of OUR six Games sits lowest on the page.
      await expect(card(page, games[0])).toBeVisible();
      const positions = await Promise.all(games.map(async (g) => ({ g, y: (await card(page, g).boundingBox())?.y ?? -1 })));
      const last = positions.sort((a, b) => b.y - a.y)[0].g;
      expect(positions.every((p) => p.y >= 0)).toBe(true); // all six are rendered
      const target = card(page, last);
      await target.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      expect(before).toBeGreaterThan(200); // six stacked cards on a 700px screen: the lowest is well below the fold
      await target.getByRole("link", { name: new RegExp(last.home) }).first().click();
      await expect(page).toHaveURL(new RegExp(`/post/${last.postId}$`));
      await page.getByRole("link", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/\/feed$/);
      await expect(target).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeGreaterThan(before / 2);
    } finally {
      for (const g of games) await cleanupGame(g);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  for (const width of [320, 375, 768, 1280]) {
    test(`Back is clearly visible, labelled, keyboard-reachable and works at ${width}px`, async ({ page }) => {
      const suffix = randomUUID().slice(0, 6);
      const game = await seedGame(LEAGUES[1], suffix);
      const user = await createPlayer();
      try {
        await page.setViewportSize({ width, height: 800 });
        await loginAs(page, user.email);
        await page.goto("/feed");
        await card(page, game).getByRole("link", { name: new RegExp(game.home) }).first().click();
        await page.getByRole("link", { name: /Total 228\.5/ }).click();
        await expect(page).toHaveURL(new RegExp(`/markets/${game.totalId}$`));
        const back = page.getByRole("link", { name: "Back", exact: true });
        await expect(back).toBeVisible();
        await expect(back).toContainText("Back"); // visible text, not just an arrow
        const box = (await back.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBeGreaterThanOrEqual(32);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        // Keyboard: focusable and activated with Enter.
        await back.focus();
        await expect(back).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      } finally {
        await cleanupGame(game);
        await admin.auth.admin.deleteUser(user.id);
      }
    });
  }
});

test.describe("League crest on every Game card", () => {
  for (const league of LEAGUES) {
    test(`${league.name}: the card, the Post and every Market of the Game show the ${league.name} crest — and only that one`, async ({ page }) => {
      const suffix = randomUUID().slice(0, 6);
      const game = await seedGame(league, suffix);
      const user = await createPlayer();
      try {
        await loginAs(page, user.email);
        await page.goto("/feed");
        const crest = card(page, game).locator('[data-slot="league-crest"]');
        await expect(crest).toHaveAttribute("src", league.crest);
        await expect(card(page, game).locator('[data-slot="league-identity"]')).toHaveText(league.name);
        await expect(card(page, game)).not.toContainText("Brohda ·");
        // A real image that loaded, not a broken one, with its aspect ratio preserved.
        await expect.poll(() => crest.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
        expect(await crest.evaluate((img: HTMLImageElement) => getComputedStyle(img).objectFit)).toBe("contain");

        await card(page, game).getByRole("link", { name: new RegExp(game.home) }).first().click();
        await expect(page.locator('[data-slot="league-crest"]').first()).toHaveAttribute("src", league.crest);
        for (const marketId of [game.moneylineId, game.spreadId, game.totalId]) {
          await page.goto(`/markets/${marketId}`);
          await expect(page.locator('[data-slot="league-crest"]')).toHaveAttribute("src", league.crest);
        }
      } finally {
        await cleanupGame(game);
        await admin.auth.admin.deleteUser(user.id);
      }
    });
  }

  test("missing crest metadata: the league name as text, no <img>, no broken image", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const game = await seedGame(LEAGUES[1], suffix, { logo: null });
    const user = await createPlayer();
    try {
      await loginAs(page, user.email);
      await page.goto("/feed");
      await expect(card(page, game).locator('[data-slot="league-identity"]')).toHaveText("NBA");
      await expect(card(page, game).locator('[data-slot="league-crest"]')).toHaveCount(0);
    } finally {
      await cleanupGame(game);
      await admin.auth.admin.deleteUser(user.id);
    }
  });

  test("a crest URL that 404s collapses to the league name instead of a broken image", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const game = await seedGame(LEAGUES[2], suffix, { logo: "/definitely-missing-crest.png" });
    const user = await createPlayer();
    try {
      await loginAs(page, user.email);
      await page.goto("/feed");
      await expect(card(page, game).locator('[data-slot="league-identity"]')).toHaveText("NHL");
      await expect(card(page, game).locator('[data-slot="league-crest"]')).toHaveCount(0);
    } finally {
      await cleanupGame(game);
      await admin.auth.admin.deleteUser(user.id);
    }
  });
});
