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

// Milestone R1: every Market now belongs to a canonical Game (fixture_id is
// a real, NOT NULL FK — supabase/migrations/20260101000148_*.sql). Each
// seeded market gets its own dedicated fixture, distinct enough to satisfy
// the proposition-uniqueness constraint.
async function seedFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-prediction-${randomUUID()}`,
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
      question: `E2E prediction test: ${providerMarketId}`,
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      yes_price: 0.62,
      no_price: 0.38,
      price_outcome_labels: { yes: "Home Test FC wins", no: "Home Test FC does not win" },
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
  const { data: markets } = await admin.from("markets").select("fixture_id").eq("provider", provider);
  const fixtureIds = (markets ?? []).map((m) => m.fixture_id).filter((id): id is string => id != null);
  await admin.from("markets").delete().eq("provider", provider);
  if (fixtureIds.length > 0) await admin.from("fixtures").delete().in("id", fixtureIds);
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

      await expect(page.getByRole("button", { name: "Pick: Home Test FC wins" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Pick: Home Test FC does not win" })).toBeVisible();

      const bodyTextBefore = await page.locator("body").innerText();
      for (const pattern of FORBIDDEN_TERMS) expect(bodyTextBefore).not.toMatch(pattern);
      // No amount input anywhere on the page — a Prediction is a free,
      // equal, non-monetary belief, never a stake.
      await expect(page.locator('input[type="number"]')).toHaveCount(0);

      await page.getByRole("button", { name: "Pick: Home Test FC wins" }).click();
      // Stage 4A remediation (Stage 4 audit §16): semantic Pick confirmation
      // language, never the raw YES/NO enum.
      await expect(page.getByText(/You picked Home Test FC wins \(\d+%\)\./)).toBeVisible();

      const bodyTextAfter = await page.locator("body").innerText();
      for (const pattern of FORBIDDEN_TERMS) expect(bodyTextAfter).not.toMatch(pattern);

      // Revisit: the server now considers this Game's Pick cutoff still
      // far away (Milestone R5: the fixture here is scheduled well in the
      // future), so reloading must show the EDITABLE control pre-filled
      // with the current selection, never the old always-readonly
      // "You picked: ..." state and never a bare re-offer of a first
      // pick — both selection buttons remain, now labeled as a change.
      await page.reload();
      await expect(page.getByText("Change your prediction")).toBeVisible();
      await expect(page.getByRole("button", { name: "Pick: Home Test FC wins" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Pick: Home Test FC wins" })).toHaveAttribute("aria-pressed", "true");

      // Milestone R5: change the Pick from YES to NO while still eligible.
      await page.getByRole("button", { name: "Pick: Home Test FC does not win" }).click();
      await expect(page.getByText(/You picked Home Test FC does not win \(\d+%\)\./)).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: "Pick: Home Test FC does not win" })).toHaveAttribute("aria-pressed", "true");

      // Profile's Market Predictions tab shows the latest (NO) selection —
      // not the original YES — matching "the final selection is the
      // permanent record" (§7).
      await page.goto("/profile?tab=markets");
      await expect(page.getByText("You picked Home Test FC does not win", { exact: false })).toBeVisible();
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

      const yesButton = page.getByRole("button", { name: "Pick: Home Test FC wins" });
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
      // Stage 4A remediation (Stage 4 audit §15): the Market's resolved
      // outcome renders as its semantic label ("Home Test FC wins"), never
      // "Result: YES" — kept visually/conceptually distinct from the
      // Pick's own graded result ("Correct"/"Incorrect"/"Void").
      await expect(page.getByText("You picked: Home Test FC wins")).toBeVisible();
      // The Market's own resolved-outcome line and its Yes/No percentage
      // breakdown label now render the same semantic text ("Home Test FC
      // wins") — expected and harmless duplication, not a raw-enum leak —
      // so this checks at least one such element renders, not exactly one.
      await expect(page.getByText("Home Test FC wins", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Result: Correct")).toBeVisible();

      await page.goto("/profile?tab=markets");
      await expect(page.getByText("Correct", { exact: true })).toBeVisible();
    } finally {
      await cleanup(provider, userIds);
    }
  });
});
