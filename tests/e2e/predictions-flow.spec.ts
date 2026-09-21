/**
 * E2E coverage for Milestone 3 — Brohda Prediction Layer
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md). A FREE/practice Prediction
 * against a real normalized Market — no order, no trade, no position, no
 * wallet, no amount. Requires the local Supabase stack
 * (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createPlayer(email: string, usernamePrefix: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `${usernamePrefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
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

async function seedMarket(provider: string, providerMarketId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider,
      provider_market_id: providerMarketId,
      question: `E2E prediction test: ${providerMarketId}`,
      status: "ACTIVE",
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

async function cleanup(provider: string, userIds: string[]) {
  await admin.from("markets").delete().eq("provider", provider);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}

const FORBIDDEN_TERMS = [/\bbuy\b/i, /\bsell\b/i, /\btrade\b/i, /\border\b/i, /\bcontract\b/i, /\bshares?\b/i, /\bposition\b/i, /\bwallet\b/i, /\bstake\b/i, /\bbet slip\b/i, /polymarket/i];

test.describe("Brohda Prediction layer", () => {
  test("user submits a YES prediction, sees confirmation, and it persists on revisit — with no financial language anywhere", async ({ page }) => {
    const suffix = randomUUID();
    const provider = `e2e_prediction_provider_${suffix}`;
    const email = `e2e-prediction-${suffix}@test.local`;
    const userIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2epred"));
      const marketId = await seedMarket(provider, `active_${suffix}`);

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      await expect(page.getByRole("button", { name: "Predict YES" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Predict NO" })).toBeVisible();

      const bodyTextBefore = await page.locator("body").innerText();
      for (const pattern of FORBIDDEN_TERMS) expect(bodyTextBefore).not.toMatch(pattern);
      // No amount input anywhere on the page — a Prediction is a free,
      // equal, non-monetary belief, never a stake.
      await expect(page.locator('input[type="number"]')).toHaveCount(0);

      await page.getByRole("button", { name: "Predict YES" }).click();
      // submitPredictionAction calls revalidatePath on this same route, so
      // whether the assertion below catches PredictionActions' own
      // transient client-side confirmation banner ("You predicted YES at
      // N%.") or the page's server-rendered already-predicted state
      // ("Your prediction: YES") racing ahead of it is a genuine, harmless
      // timing detail of Next's Server Action + revalidation mechanism —
      // both states equally prove the YES prediction succeeded, so the
      // test accepts either rather than being brittle against exactly one.
      await expect(page.getByText(/You predicted YES at \d+%\.|Your prediction: YES/)).toBeVisible();

      const bodyTextAfter = await page.locator("body").innerText();
      for (const pattern of FORBIDDEN_TERMS) expect(bodyTextAfter).not.toMatch(pattern);

      // Revisit: the submission action itself already re-renders the
      // confirmation client-side; reloading proves the server also now
      // considers this predicted (the YES/NO buttons must not reappear).
      await page.reload();
      await expect(page.getByText("Your prediction: YES")).toBeVisible();
      await expect(page.getByText(/You predicted at \d+%\./)).toBeVisible();
      await expect(page.getByRole("button", { name: "Predict YES" })).toHaveCount(0);

      // Profile's Market Predictions tab shows the same history entry.
      await page.goto("/profile?tab=markets");
      await expect(page.getByText("You predicted YES", { exact: false })).toBeVisible();
    } finally {
      await cleanup(provider, userIds);
    }
  });

  test("a CLOSED market does not accept a new prediction", async ({ page }) => {
    const suffix = randomUUID();
    const provider = `e2e_prediction_closed_${suffix}`;
    const email = `e2e-prediction-closed-${suffix}@test.local`;
    const userIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2epredc"));
      const marketId = await seedMarket(provider, `closed_${suffix}`, { status: "CLOSED", resolved_outcome: null });

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      const yesButton = page.getByRole("button", { name: "Predict YES" });
      await expect(yesButton).toBeVisible();
      await expect(yesButton).toBeDisabled();
      await expect(page.getByText("This market is closed to new predictions.")).toBeVisible();
    } finally {
      await cleanup(provider, userIds);
    }
  });

  test("a graded prediction shows its result in history and on the market detail page", async ({ page }) => {
    const suffix = randomUUID();
    const provider = `e2e_prediction_graded_${suffix}`;
    const email = `e2e-prediction-graded-${suffix}@test.local`;
    const userIds: string[] = [];

    try {
      const userId = await createPlayer(email, "e2epredg");
      userIds.push(userId);
      const marketId = await seedMarket(provider, `resolved_${suffix}`, {
        status: "CLOSED",
        yes_price: 1,
        no_price: 0,
        resolved_outcome: "YES",
      });

      // Directly seed an already-graded Prediction — the grading job
      // itself (PENDING -> GRADED) is covered by
      // tests/integration/predictions.test.ts; this test only proves the
      // UI renders a graded result correctly.
      await admin.from("predictions").insert({
        user_id: userId,
        market_id: marketId,
        selected_outcome: "YES",
        yes_probability_snapshot: 0.55,
        no_probability_snapshot: 0.45,
        market_question_snapshot: `E2E prediction test: resolved_${suffix}`,
        market_status_snapshot: "ACTIVE",
        lifecycle_state: "GRADED",
        result: "CORRECT",
        resolved_outcome_snapshot: "YES",
        graded_at: new Date().toISOString(),
        idempotency_key: randomUUID(),
      });

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText("Your prediction: YES")).toBeVisible();
      await expect(page.getByText("Result: Correct")).toBeVisible();

      await page.goto("/profile?tab=markets");
      await expect(page.getByText("Correct", { exact: true })).toBeVisible();
    } finally {
      await cleanup(provider, userIds);
    }
  });
});
