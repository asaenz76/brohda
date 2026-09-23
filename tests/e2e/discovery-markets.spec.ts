/**
 * E2E coverage for Milestone 2 — Prediction Market Discovery
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md). Read-only browse surface — no
 * prediction submission, no order, no wallet. Requires the local Supabase
 * stack (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
 *
 * Every seeded market's question text embeds this test's unique suffix —
 * not just its provider_market_id — because Playwright's text/role matchers
 * match by visible content, and a prior run's leftover row (if a run is
 * ever interrupted before its own cleanup) would otherwise collide with an
 * identically-worded question from a fresh run.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `e2edisc${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;
  return data.user.id as string;
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedCategory(slug: string, displayOrder: number, enabled = true) {
  const { data, error } = await admin
    .from("discovery_categories")
    .insert({ slug, display_name: slug.replace(/-/g, " "), display_order: displayOrder, enabled })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create category");
  return data.id as string;
}

async function seedMapping(categoryId: string, provider: string, providerTag: string) {
  const { error } = await admin.from("discovery_category_provider_mappings").insert({ category_id: categoryId, provider, provider_tag: providerTag, enabled: true });
  if (error) throw error;
}

// Milestone R1: every Market now belongs to a canonical Game (fixture_id is
// a real, NOT NULL FK — supabase/migrations/20260101000148_*.sql). Each
// seeded market gets its own dedicated fixture, distinct enough to satisfy
// the proposition-uniqueness constraint.
async function seedFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-discovery-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  return data.id as string;
}

async function seedMarket(provider: string, providerMarketId: string, overrides: Record<string, unknown> = {}) {
  const fixtureId = (overrides.fixture_id as string | undefined) ?? (await seedFixture());
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider,
      provider_market_id: providerMarketId,
      question: `E2E discovery test: ${providerMarketId}`,
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      yes_price: 0.62,
      no_price: 0.38,
      liquidity: 1000,
      closes_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
      ...overrides,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create market");
  return data.id as string;
}

async function cleanup(provider: string, categoryIds: string[]) {
  const { data: markets } = await admin.from("markets").select("fixture_id").eq("provider", provider);
  const fixtureIds = (markets ?? []).map((m) => m.fixture_id).filter((id): id is string => id != null);
  await admin.from("markets").delete().eq("provider", provider);
  if (fixtureIds.length > 0) await admin.from("fixtures").delete().in("id", fixtureIds);
  if (categoryIds.length > 0) await admin.from("discovery_categories").delete().in("id", categoryIds);
}

test.describe("prediction market discovery", () => {
  test("user can browse the discovery feed, see YES/NO percentages, filter by a configured category, and open a market's detail page", async ({ page }) => {
    const suffix = randomUUID();
    const provider = `e2e_provider_${suffix}`;
    const categorySlug = `e2e-cat-${suffix}`;
    const categoryDisplayName = categorySlug.replace(/-/g, " ");
    const categoryId = await seedCategory(categorySlug, 0);

    try {
      await seedMapping(categoryId, provider, `e2e-tag-${suffix}`);

      const categorizedQuestion = `Will the E2E test pass ${suffix}?`;
      const uncategorizedQuestion = `An uncategorized E2E market ${suffix}`;
      const unpricedQuestion = `A market with no price data ${suffix}`;

      const categorizedMarketId = await seedMarket(provider, `cat-market-${suffix}`, {
        question: categorizedQuestion,
        provider_metadata: { _categoryTagsExtracted: [`e2e-tag-${suffix}`] },
      });
      await seedMarket(provider, `uncat-market-${suffix}`, { question: uncategorizedQuestion });
      await seedMarket(provider, `unpriced-market-${suffix}`, { question: unpricedQuestion, yes_price: null, no_price: null });

      const email = `e2e-discovery-${suffix}@example.com`;
      await createPlayer(email);

      await loginAs(page, email);
      await page.goto("/markets");

      // Category tab renders dynamically from configuration, not a hard-coded list.
      await expect(page.getByRole("link", { name: "All", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: categoryDisplayName, exact: true })).toBeVisible();

      // All three markets appear under "All."
      await expect(page.getByText(categorizedQuestion)).toBeVisible();
      await expect(page.getByText(uncategorizedQuestion)).toBeVisible();
      await expect(page.getByText(unpricedQuestion)).toBeVisible();

      // YES/NO percentages render for the priced market.
      const categorizedCard = page.locator("a", { hasText: categorizedQuestion });
      await expect(categorizedCard.getByText("62%")).toBeVisible();
      await expect(categorizedCard.getByText("38%")).toBeVisible();
      await expect(categorizedCard.getByText("Yes", { exact: true })).toBeVisible();
      await expect(categorizedCard.getByText("No", { exact: true })).toBeVisible();

      // Unavailable price is presented honestly — no fabricated percentage.
      const unpricedCard = page.locator("a", { hasText: unpricedQuestion });
      await expect(unpricedCard.getByText(/pricing isn.t available/i)).toBeVisible();

      // No prediction/order/trade UI exists anywhere on this page.
      await expect(page.getByRole("button", { name: /buy|sell|trade|predict|enter/i })).toHaveCount(0);
      await expect(page.getByText(/potential return/i)).toHaveCount(0);

      // Category filtering: only the mapped market appears; the uncategorized one does not.
      await page.getByRole("link", { name: categoryDisplayName, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`category=${categorySlug}`));
      await expect(page.getByText(categorizedQuestion)).toBeVisible();
      await expect(page.getByText(uncategorizedQuestion)).toHaveCount(0);

      // Market detail opens. This user has no existing Prediction here, so
      // Milestone 3's real "Predict YES"/"Predict NO" actions legitimately
      // render (docs/architecture/prediction-layer.md) — still asserting no
      // financial/exchange language of any kind appears.
      await page.getByText(categorizedQuestion).click();
      await expect(page).toHaveURL(new RegExp(`/markets/${categorizedMarketId}`));
      await expect(page.getByText("62%")).toBeVisible();
      await expect(page.getByRole("button", { name: /buy|sell|trade|enter/i })).toHaveCount(0);
    } finally {
      await cleanup(provider, [categoryId]);
    }
  });

  test("a disabled category is absent from discovery navigation and its direct slug renders an honest empty state, not an error", async ({ page }) => {
    const suffix = randomUUID();
    const disabledSlug = `e2e-disabled-cat-${suffix}`;
    const categoryId = await seedCategory(disabledSlug, 0, false);

    try {
      const email = `e2e-discovery-disabled-${suffix}@example.com`;
      await createPlayer(email);

      await loginAs(page, email);
      await page.goto("/markets");
      await expect(page.getByRole("link", { name: new RegExp(disabledSlug, "i") })).toHaveCount(0);

      await page.goto(`/markets?category=${disabledSlug}`);
      await expect(page.getByText(/nothing here yet/i)).toBeVisible();
    } finally {
      await cleanup(`e2e_provider_${suffix}`, [categoryId]);
    }
  });
});
