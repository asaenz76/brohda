/**
 * SEE MORE MARKETS in a real browser: visible on the card (no hover, no tap, no expanding) exactly when the Game has other displayable Markets; its own link to the
 * canonical Game Post; Back unwinds Home → Post → Market → Post → Home; and at every width it is visible, inside the card, tappable and clear of the Pick buttons.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createPlayer() {
  const email = `e2e-more-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: `more${Math.floor(Math.random() * 100000)}`, username: `more${Date.now()}${Math.floor(Math.random() * 1000)}`, role: "player", is_active: true });
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

type Extra = { template: "TOTAL" | "SPREAD"; status: string };
async function seedGame(suffix: string, extras: Extra[], sport = "hockey") {
  const home = `Bruins ${suffix}`;
  const away = `Canadiens ${suffix}`;
  const provider = sport === "hockey" ? "api_nhl" : "api_nfl";
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ provider, external_fixture_id: `e2e-more-${randomUUID()}`, sport, home_team_name: home, away_team_name: away, competition_name: "NHL", competition_external_id: "57", scheduled_start_utc: new Date(Date.now() + 24 * 3_600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  const base = { provider, status: "ACTIVE", fixture_id: fixture!.id, yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {} };
  const rows = [
    { ...base, provider_market_id: `m_ml_${randomUUID()}`, question: "ml?", market_template: "MONEYLINE", yes_side: "HOME", line_value: null },
    ...extras.map((e) => ({ ...base, status: e.status, provider_market_id: `m_${e.template}_${randomUUID()}`, question: "x?", market_template: e.template, yes_side: e.template === "TOTAL" ? null : "HOME", line_value: e.template === "TOTAL" ? 6.5 : -1.5 })),
  ];
  const { data: markets, error } = await admin.from("markets").insert(rows).select("id, market_template");
  if (error) throw error;
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  return { fixtureId: fixture!.id as string, postId: post!.id as string, home, away, marketIds: markets!.map((m) => m.id as string), totalId: markets!.find((m) => m.market_template === "TOTAL")?.id as string | undefined };
}

const cleanup = async (g: { fixtureId: string; marketIds: string[] }) => {
  await admin.from("posts").delete().eq("fixture_id", g.fixtureId);
  await admin.from("markets").delete().in("id", g.marketIds);
  await admin.from("fixtures").delete().eq("id", g.fixtureId);
};
const card = (page: Page, g: { home: string }) => page.locator("article").filter({ hasText: g.home }).first();

test("one Market → no action; two or three eligible Markets → the action is visible with no hover, tap or expansion; a hidden or archived extra Market does not trigger it", async ({ page }) => {
  const s = randomUUID().slice(0, 6);
  const one = await seedGame(`${s}a`, []);
  const two = await seedGame(`${s}b`, [{ template: "TOTAL", status: "ACTIVE" }]);
  const three = await seedGame(`${s}c`, [{ template: "TOTAL", status: "ACTIVE" }, { template: "SPREAD", status: "ACTIVE" }]);
  const hidden = await seedGame(`${s}d`, [{ template: "TOTAL", status: "ARCHIVED" }, { template: "SPREAD", status: "INACTIVE" }]);
  const user = await createPlayer();
  try {
    await loginAs(page, user.email);
    await page.goto("/feed");
    const action = (g: { home: string }) => card(page, g).getByRole("link", { name: /^See more markets/i });
    await expect(card(page, one)).toBeVisible();
    await expect(action(one)).toHaveCount(0);
    await expect(action(hidden)).toHaveCount(0);
    for (const g of [two, three]) {
      await expect(action(g)).toBeVisible();
      await expect(action(g)).toHaveCSS("text-transform", "uppercase"); // reads SEE MORE MARKETS
      await expect(action(g)).toHaveAttribute("href", `/post/${g.postId}`);
    }
  } finally {
    for (const g of [one, two, three, hidden]) await cleanup(g);
    await admin.auth.admin.deleteUser(user.id);
  }
});

test("clicking it opens the canonical Game Post (listing the other Markets); Back unwinds Home → Post → Market → Post → Home", async ({ page }) => {
  const s = randomUUID().slice(0, 6);
  const g = await seedGame(s, [{ template: "TOTAL", status: "ACTIVE" }, { template: "SPREAD", status: "ACTIVE" }]);
  const user = await createPlayer();
  try {
    await loginAs(page, user.email);
    await page.goto("/feed");
    await card(page, g).getByRole("link", { name: /^See more markets/i }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${g.postId}$`));
    await expect(page.getByText("More markets for this game")).toBeVisible();
    await page.getByRole("link", { name: /Total 6\.5/ }).click();
    await expect(page).toHaveURL(new RegExp(`/markets/${g.totalId}$`));
    await page.getByRole("link", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${g.postId}$`));
    await page.getByRole("link", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/feed$/);
  } finally {
    await cleanup(g);
    await admin.auth.admin.deleteUser(user.id);
  }
});

test("using a Pick control never navigates, and using the action never makes a Pick", async ({ page }) => {
  const s = randomUUID().slice(0, 6);
  const g = await seedGame(s, [{ template: "TOTAL", status: "ACTIVE" }]);
  const user = await createPlayer();
  try {
    await loginAs(page, user.email);
    await page.goto("/feed");
    const c = card(page, g);
    await c.getByRole("button", { name: new RegExp(`^Pick ${g.home}`) }).click();
    await expect(c.getByText("Change your prediction")).toBeVisible();
    await expect(page).toHaveURL(/\/feed$/); // the Pick stayed on the feed
    await c.getByRole("link", { name: /^See more markets/i }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${g.postId}$`));
    expect((await admin.from("predictions").select("id").eq("user_id", user.id)).data).toHaveLength(1); // exactly the one Pick made on purpose
  } finally {
    await admin.from("predictions").delete().eq("user_id", user.id);
    await cleanup(g);
    await admin.auth.admin.deleteUser(user.id);
  }
});

for (const width of [320, 375, 768, 1280]) {
  test(`at ${width}px the action is visible, inside the card, tappable, clear of the Pick buttons, and works from the keyboard`, async ({ page }) => {
    const s = randomUUID().slice(0, 6);
    const g = await seedGame(s, [{ template: "TOTAL", status: "ACTIVE" }, { template: "SPREAD", status: "ACTIVE" }]);
    const user = await createPlayer();
    try {
      await page.setViewportSize({ width, height: 900 });
      await loginAs(page, user.email);
      await page.goto("/feed");
      const c = card(page, g);
      await c.scrollIntoViewIfNeeded();
      const action = c.getByRole("link", { name: /^See more markets/i });
      await expect(action).toBeVisible();
      const [a, cardBox] = [(await action.boundingBox())!, (await c.boundingBox())!];
      expect(a.height).toBeGreaterThanOrEqual(32);
      expect(a.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(a.x + a.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      for (const button of await c.getByRole("button", { name: /^Pick / }).all()) {
        const b = (await button.boundingBox())!;
        const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await action.focus();
      await expect(action).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/post/${g.postId}$`));
    } finally {
      await cleanup(g);
      await admin.auth.admin.deleteUser(user.id);
    }
  });
}
