/**
 * FEED = PREDICT, POST = GAME PREVIEW + CONVERSATION, in a real browser. The feed card advertises the Post with a visible "Game Preview" text link (no hover, desktop and phone); the opened Post carries information the feed does not —
 * Market sentiment per Market (commit-before-crowd), the saved Game Preview (hook + story), the conversation and Other Picks — and is not a second prediction surface. A Game with no saved Preview still opens as the Game and its conversation.
 * Local test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { predict, seedPrediction } from "./helpers/predict";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const tag = randomUUID().slice(0, 6);

async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-gp-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${tag}`, username: `gp${label}${tag}`.toLowerCase(), role, is_active: true });
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

/** A hockey Game a few hours out with a Moneyline, a Total and a Spread, and a published Post. Uniquely named. */
async function seedGame(name: string) {
  const home = `GPhome ${name} ${tag}`;
  const away = `GPaway ${name} ${tag}`;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ provider: "api_nhl", external_fixture_id: `e2e-gp-${randomUUID()}`, sport: "hockey", home_team_name: home, away_team_name: away, competition_name: "NHL", competition_external_id: "57", scheduled_start_utc: new Date(Date.now() + 180 * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const base = { provider: "api_nhl", status: "ACTIVE", fixture_id: fixture.id, yes_price: 0.6, no_price: 0.4, liquidity: 1000, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {} };
  const rows = [
    { ...base, provider_market_id: `gp_ml_${randomUUID()}`, question: "ml?", market_template: "MONEYLINE", yes_side: "HOME", line_value: null },
    { ...base, provider_market_id: `gp_to_${randomUUID()}`, question: "to?", market_template: "TOTAL", yes_side: null, line_value: 6 },
    { ...base, provider_market_id: `gp_sp_${randomUUID()}`, question: "sp?", market_template: "SPREAD", yes_side: "HOME", line_value: -1.5 },
  ];
  const { data: markets, error: marketError } = await admin.from("markets").insert(rows).select("id, market_template");
  if (marketError || !markets) throw marketError ?? new Error("failed to create markets");
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  const id = (t: string) => markets.find((m) => m.market_template === t)!.id as string;
  return { home, away, fixtureId: fixture.id as string, postId: post.id as string, moneylineId: id("MONEYLINE"), totalId: id("TOTAL"), spreadId: id("SPREAD") };
}
async function savePreview(fixtureId: string, hook: string, body: string) {
  const { data, error } = await admin.rpc("upsert_game_preview", {
    p_fixture_id: fixtureId, p_hook: hook, p_body: body, p_generated_by: "e2e", p_reason: "MISSING",
    p_sources: [{ url: "https://www.nhl.com/news/e2e-preview", provider: "NHL.com", title: "E2E preview", published_at: null, retrieved_at: new Date().toISOString(), supports: null }],
  });
  if (error || (data as { outcome: string }).outcome !== "created") throw error ?? new Error(JSON.stringify(data));
}
const card = (page: Page, g: { home: string; away: string }) => page.locator("article").filter({ hasText: g.home }).filter({ hasText: g.away });

test("the feed card shows a visible 'Game Preview' link on desktop and phone — no hover — and it opens the canonical Post; the title still works; predicting is unaffected", async ({ page }) => {
  test.setTimeout(180_000);
  const m = await createMember("feed");
  const g = await seedGame("feed");
  await loginAs(page, m.email);

  for (const [label, width] of [["desktop", 1280], ["phone", 375]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/feed");
    await page.waitForLoadState("networkidle");
    const link = card(page, g).locator('[data-slot="game-preview-link"]');
    await expect(link, `${label}: visible without hover`).toBeVisible();
    await expect(link).toHaveText("Game Preview");
    await expect(link).toHaveAttribute("aria-label", `Open game preview for ${g.away} at ${g.home}`);
    const box = (await link.boundingBox())!;
    expect(box.height, `${label}: tappable`).toBeGreaterThanOrEqual(32);
    expect(box.x, `${label}: inside the screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${label}: inside the screen`).toBeLessThanOrEqual(width);
    const cardBox = (await card(page, g).boundingBox())!;
    expect(box.x + box.width, `${label}: inside the card`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${label}: no horizontal overflow`).toBeLessThanOrEqual(0);
    // Not hidden behind a hover state.
    expect(await link.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  }

  // It opens the canonical Post; the matchup title is still a path to the same place.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/feed");
  await page.waitForLoadState("networkidle");
  await card(page, g).locator('[data-slot="game-preview-link"]').click();
  await expect(page).toHaveURL(new RegExp(`/post/${g.postId}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/feed$/);
  await card(page, g).getByRole("link", { name: new RegExp(g.home) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/post/${g.postId}$`));

  // The link does not interfere with predicting or with the inline markets: the feed still makes a prediction in two taps and expands more markets in place.
  await page.goto("/feed");
  await page.waitForLoadState("networkidle");
  await predict(card(page, g), new RegExp(`Pick ${g.home} to win`), 2);
  await expect(page).toHaveURL(/\/feed$/);
  await card(page, g).getByRole("button", { name: /^See more markets/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
  await expect(card(page, g).getByRole("heading", { name: "Spread" })).toBeVisible();
});

test("the Post is the Game Preview: identity, then sentiment per Market, then the saved Preview, then comments and Other Picks — with no second prediction surface", async ({ page }) => {
  test.setTimeout(180_000);
  const viewer = await createMember("viewer");
  const other1 = await createMember("o1");
  const other2 = await createMember("o2");
  const g = await seedGame("post");
  await savePreview(g.fixtureId, "Seven goals. Your move, Washington.", "The Devils crushed the Rangers 7-1. Today, they chase a third straight win against the Capitals. Who takes it?");
  // Moneyline: viewer + one other pick YES, one picks NO → 67/33; Total: the others picked, the viewer has not.
  await seedPrediction(viewer.id, g.moneylineId, "YES", 5);
  await seedPrediction(other1.id, g.moneylineId, "YES", 1);
  await seedPrediction(other2.id, g.moneylineId, "NO", 1);
  await seedPrediction(other1.id, g.totalId, "NO", 1);
  await seedPrediction(other2.id, g.totalId, "NO", 1);
  await loginAs(page, viewer.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/post/${g.postId}`);
  const main = page.getByRole("main");

  // Sentiment: Moneyline revealed (the viewer predicted), Total and Spread withheld until they predict there (commit-before-crowd), in the configured order.
  const blocks = main.locator('[data-slot="market-sentiment-block"]');
  await expect(blocks.locator("h2")).toHaveText(["Moneyline", "Total 6", "Spread"]);
  const ml = blocks.nth(0);
  await expect(ml).toContainText("67%");
  await expect(ml).toContainText("33%");
  await expect(ml).toContainText("3 predicted");
  await expect(ml).toContainText("Your prediction:");
  await expect(ml).toContainText("🔥5");
  for (const i of [1, 2]) {
    await expect(blocks.nth(i)).toContainText("Make your prediction in the feed to see how everyone else picked.");
    expect(await blocks.nth(i).innerText()).not.toMatch(/%|predicted/);
  }

  // The Preview: hook and story.
  const preview = main.locator('[data-slot="game-preview"]');
  await expect(preview.getByRole("heading", { name: "Game Preview" })).toBeVisible();
  await expect(preview.locator('[data-slot="game-preview-hook"]')).toHaveText("Seven goals. Your move, Washington.");
  await expect(preview.locator('[data-slot="game-preview-body"]')).toContainText("crushed the Rangers 7-1");
  // The Member never sees provenance by default.
  expect(await preview.innerText()).not.toMatch(/nhl\.com|source/i);

  // Order: identity → sentiment → preview → conversation → Other Picks.
  const y = async (loc: ReturnType<Page["locator"]>) => (await loc.first().boundingBox())!.y;
  const identity = await y(main.getByText(`${g.away} @`));
  const sentimentY = await y(blocks.first());
  const previewY = await y(preview);
  const comments = await y(main.getByText("Comments", { exact: true }));
  const others = await y(main.getByText("Other picks", { exact: true }));
  expect(identity).toBeLessThan(sentimentY);
  expect(sentimentY).toBeLessThan(previewY);
  expect(previewY).toBeLessThan(comments);
  expect(comments).toBeLessThan(others);

  // No second prediction surface on the Post.
  await expect(main.locator('[data-testid="prediction-actions"]')).toHaveCount(0);
  await expect(main.locator('[data-slot="confidence-choice"]')).toHaveCount(0);
  await expect(main.getByText(/You picked|More markets for this game|How confident are you/)).toHaveCount(0);
  await expect(main.getByRole("button", { name: /^Pick / })).toHaveCount(0);
  await expect(main.locator('a[href^="/markets/"]')).toHaveCount(0);

  // Comments and Other Picks / Call BS still work: the opposing Pick is listed with the Call BS action.
  await expect(main.getByText("Other picks")).toBeVisible();
  await expect(main.getByRole("button", { name: "Call BS" }).first()).toBeVisible();
  await main.getByPlaceholder(/Add a comment/).fill("Capitals in six.");
  await main.getByRole("button", { name: "Post", exact: true }).click();
  await expect(main.getByText("Capitals in six.")).toBeVisible();

  // After the viewer predicts on the Total in the feed, its percentages appear on the Post.
  await page.goto("/feed");
  await page.waitForLoadState("networkidle");
  const c = card(page, g);
  await c.getByRole("button", { name: /^See more markets/i }).click();
  const totalSection = c.locator(`[data-slot="feed-market"][data-market-id="${g.totalId}"]`);
  await predict(totalSection, /^Pick Over 6/, 1);
  await page.goto(`/post/${g.postId}`);
  await expect(main.locator('[data-slot="market-sentiment-block"]').nth(1)).toContainText("3 predicted");
  await expect(main.locator('[data-slot="market-sentiment-block"]').nth(1)).toContainText("Over 6");
});

test("phone: Preview, sentiment and comments read in one column without overflow; a Game with no saved Preview still opens as the Game and its conversation", async ({ page }) => {
  test.setTimeout(180_000);
  const viewer = await createMember("phone");
  const withPreview = await seedGame("phone1");
  const without = await seedGame("phone2");
  await savePreview(withPreview.fixtureId, "Winless in six meets unbeaten at home.", "Vancouver has lost six straight. Tampa Bay is 4-0 at home. Can the Canucks flip the script today, or does the misery continue?");
  await seedPrediction(viewer.id, withPreview.moneylineId, "YES", 1);
  await seedPrediction(viewer.id, without.moneylineId, "NO", 1);
  await loginAs(page, viewer.email);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/post/${withPreview.postId}`);
    const main = page.getByRole("main");
    await expect(main.locator('[data-slot="game-preview-hook"]')).toBeVisible();
    await expect(main.locator('[data-slot="market-sentiment-block"]').first()).toBeVisible();
    await expect(main.getByText("Comments", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}: no horizontal overflow`).toBeLessThanOrEqual(0);
    const hookBox = (await main.locator('[data-slot="game-preview-hook"]').boundingBox())!;
    expect(hookBox.x + hookBox.width).toBeLessThanOrEqual(width);
  }
  // No saved Preview: no Preview block, no placeholder, no error — the Game, its sentiment and the conversation are all there.
  await page.goto(`/post/${without.postId}`);
  const main = page.getByRole("main");
  await expect(main.locator('[data-slot="game-preview"]')).toHaveCount(0);
  await expect(main.getByText(`${without.away} @`)).toBeVisible();
  await expect(main.locator('[data-slot="market-sentiment-block"]').first()).toBeVisible();
  await expect(main.getByText("Comments", { exact: true })).toBeVisible();
  await expect(main.getByText(/coming soon|unavailable|error/i)).toHaveCount(0);
});

test("Admin → Game Previews: settings persist, credentials show as configured or not (never the key), a Generate with no provider configured fails cleanly, and a Super Admin can edit and withdraw — all audited", async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await createMember("owner", "super_admin");
  const g = await seedGame("admin");
  await savePreview(g.fixtureId, "Winless in six meets unbeaten at home.", "Vancouver has lost six straight. Tampa Bay is 4-0 at home. Can the Canucks flip the script today?");
  const { data: cfg } = await admin.from("game_preview_config").select("*").eq("id", true).single();
  try {
    await loginAs(page, owner.email);
    await page.goto("/admin/game-previews");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Game Previews" })).toBeVisible();
    // Usage is visible from day one.
    await expect(main.locator('[data-slot="generation-usage"]')).toContainText("Games researched");
    // Credentials: presence only, never the value.
    await expect(main.locator('[data-slot="credentials-status"]')).toContainText(/configured in the environment|not configured/);
    expect(await main.innerText()).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(await main.locator('[data-slot="game-preview-config-form"] input[type="password"]').count()).toBe(0);

    // Settings persist and are audited; nothing generates automatically by default.
    const form = main.locator('[data-slot="game-preview-config-form"]');
    await expect(form.getByLabel("Generate Previews automatically")).not.toBeChecked();
    // Anthropic is the provider; effort starts at medium; the search tool version is a visible, changeable setting; sk- keys never appear.
    await expect(form.locator('select[name="provider"]')).toHaveValue("anthropic");
    await expect(form.locator('select[name="effort"]')).toHaveValue("medium");
    await expect(form.locator('select[name="web_search_tool_version"]')).toHaveValue("web_search_20250305");
    await expect(form.locator('input[name="max_search_calls_per_game"]')).toHaveValue("3");
    await expect(form.locator('input[name="max_cited_facts"]')).toHaveValue("4");
    await form.locator('input[name="model"]').fill("e2e-model");
    await form.locator('input[name="max_attempts"]').fill("3");
    await form.locator('select[name="effort"]').selectOption("high");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByRole("status")).toContainText("Saved");
    await expect.poll(async () => (await admin.from("game_preview_config").select("model, max_attempts, generation_enabled, effort").eq("id", true).single()).data).toEqual({ model: "e2e-model", max_attempts: 3, generation_enabled: false, effort: "high" });
    // Turning automation on without a model is refused.
    await form.locator('input[name="model"]').fill("");
    await form.getByLabel("Generate Previews automatically").check();
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByRole("alert")).toContainText("Set a model");

    // Generate with no provider credentials (the test environment has none): a plain message, nothing saved, nothing called.
    await page.reload();
    const row = main.locator(`[data-slot="game-preview-row"][data-fixture-id="${g.fixtureId}"]`);
    await expect(row.locator('[data-slot="preview-status"]')).toContainText("Preview saved");
    await expect(row.locator('[data-slot="preview-sources"]')).toHaveCount(1);
    await row.getByRole("button", { name: "Regenerate" }).click();
    await expect(row.getByRole("alert")).toContainText(/credentials|nothing was saved/i);
    expect((await admin.from("game_preview_runs").select("id").eq("fixture_id", g.fixtureId)).data ?? []).toHaveLength(0);

    // Manual edit: needs a note, keeps the sources, is audited, and the Post shows it.
    await row.locator("summary", { hasText: "Edit" }).click();
    await row.getByLabel("Hook").fill("Winless meets unbeaten.");
    await row.getByLabel("What you changed and why").fill("Shortened the hook");
    await row.getByRole("button", { name: "Save edit" }).click();
    await expect(row.getByRole("status")).toContainText("Saved");
    expect((await admin.from("audit_logs").select("id").eq("action", "game_preview.edited").eq("actor_id", owner.id)).data?.length).toBeGreaterThan(0);
    await page.goto(`/post/${g.postId}`);
    await expect(page.locator('[data-slot="game-preview-hook"]')).toHaveText("Winless meets unbeaten.");

    // Withdraw: the Post stops showing it at once.
    await page.goto("/admin/game-previews");
    await row.getByLabel("Why this Preview is being withdrawn").fill("Checked and wrong");
    await row.getByRole("button", { name: "Withdraw" }).click();
    await expect(row.locator('[data-slot="preview-status"]')).toContainText("Withdrawn — Checked and wrong");
    await page.goto(`/post/${g.postId}`);
    await expect(page.locator('[data-slot="game-preview"]')).toHaveCount(0);
  } finally {
    if (cfg) {
      const rest: Record<string, unknown> = { ...cfg };
      delete rest.updated_at;
      delete rest.updated_by;
      await admin.from("game_preview_config").update(rest).eq("id", true);
    }
  }
});
