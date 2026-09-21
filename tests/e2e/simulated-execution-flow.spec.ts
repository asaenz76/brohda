/**
 * E2E coverage for Milestone 5 — Simulated Execution
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md). No real order, no real wallet,
 * no signing — every confirmed record is structurally `is_simulated =
 * true`. Requires the local Supabase stack (`pnpm supabase:start`) —
 * `pnpm test:e2e` handles the rest.
 *
 * The success-path tests use a REAL, currently-active Polymarket market's
 * real read-only order book (see tests/integration/execution.test.ts's
 * own comment on this accepted, documented external dependency — there is
 * no database-only equivalent to fixture against for live depth data).
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const LIVE_YES_TOKEN_ID = "32338220190071351435772801779725302244575775216413325951443816017994629993401";

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

/**
 * `provider` is always the real `"polymarket"` string — the Milestone 5
 * execution provider registry (lib/execution/provider-registry.ts) only
 * resolves an adapter for that exact value, exactly like the discovery
 * registry does. Test isolation instead comes from a unique
 * `provider_market_id` per call; cleanup tracks the returned Brohda market
 * id directly rather than filtering by provider string.
 */
async function seedLiveMarket(providerMarketId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider: "polymarket",
      provider_market_id: providerMarketId,
      question: `E2E simulated execution test: ${providerMarketId}`,
      status: "ACTIVE",
      yes_price: 0.5,
      no_price: 0.5,
      liquidity: 1000,
      closes_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: { outcomes: ["Yes", "No"], clobTokenIds: [LIVE_YES_TOKEN_ID, "0"] },
      ...overrides,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create market");
  return data.id as string;
}

async function cleanup(marketIds: string[], userIds: string[]) {
  if (marketIds.length > 0) await admin.from("markets").delete().in("id", marketIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  await admin
    .from("platform_settings")
    .update({
      execution_min_amount_cents: 100,
      execution_max_amount_cents: 100_000,
      execution_quote_expiry_seconds: 30,
      // Milestone 5 final remediation (rate limits moved to config —
      // migration 20260101000152): restore the defaults that reproduce
      // the original hard-coded behavior, same reasoning as the three
      // simulation-policy columns above.
      execution_quote_rate_limit_enabled: true,
      execution_quote_rate_limit_window_seconds: 60,
      execution_quote_rate_limit_max_attempts: 30,
      execution_confirmation_rate_limit_enabled: true,
      execution_confirmation_rate_limit_window_seconds: 60,
      execution_confirmation_rate_limit_max_attempts: 10,
    })
    .eq("id", true);
}

// Several of these tests mutate the shared `platform_settings` singleton
// (execution_max_amount_cents, execution_quote_expiry_seconds) — the same
// class of cross-test race this codebase's own
// platform-capability-toggle-flow.spec.ts already isolates via a serial
// project. Simpler fix here: force this file's own tests to run serially
// with each other (they're independent otherwise, so this only affects
// this file's internal scheduling, not other specs).
test.describe.configure({ mode: "serial" });

test.describe("Milestone 5 — Simulated Execution", () => {
  test("user requests a quote, reviews it, confirms, and sees a history entry — with no real-money language or wallet prompt", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-execution-${suffix}@test.local`;
    const userIds: string[] = [];
    const marketIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2eexec"));
      const marketId = await seedLiveMarket(`active_${suffix}`);
      marketIds.push(marketId);

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      await expect(page.getByText("Simulation — practice execution, no money will move")).toBeVisible();

      const bodyBefore = await page.locator("body").innerText();
      expect(bodyBefore).not.toMatch(/\bwallet\b/i);
      expect(bodyBefore).not.toMatch(/connect.*wallet/i);

      await page.getByRole("button", { name: "YES", exact: true }).click();
      await page.getByLabel("Amount ($)").fill("5.00");
      await page.getByRole("button", { name: "Get simulated quote" }).click();

      await expect(page.getByText(/Review your simulated YES prediction/)).toBeVisible();
      await expect(page.getByText(/Estimated simulated return/)).toBeVisible();
      await expect(page.getByText(/Estimated simulated fees/)).toBeVisible();
      await expect(page.getByText(/This is a simulation\. No real money moves and no real order is placed\./)).toBeVisible();

      await page.getByRole("button", { name: "Confirm simulation" }).click();
      await expect(page.getByText(/Simulated YES prediction recorded|Simulation not confirmed/)).toBeVisible();

      const bodyAfter = await page.locator("body").innerText();
      expect(bodyAfter).not.toMatch(/\bwallet\b/i);
      expect(bodyAfter).not.toMatch(/\border placed\b/i);
      expect(bodyAfter).not.toMatch(/\btrade executed\b/i);

      await page.goto("/profile?tab=simulations");
      await expect(page.getByText("Simulated only — no real money has ever moved")).toBeVisible();
      await expect(page.getByText(/YES · \$5\.00/)).toBeVisible();
    } finally {
      await cleanup(marketIds, userIds);
    }
  });

  test("an invalid (out-of-range) amount is rejected with a clear message, not a crash", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-execution-invalid-${suffix}@test.local`;
    const userIds: string[] = [];
    const marketIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2eexecinv"));
      const marketId = await seedLiveMarket(`invalid_${suffix}`);
      marketIds.push(marketId);
      await admin.from("platform_settings").update({ execution_max_amount_cents: 1000 }).eq("id", true); // $10 max

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      await page.getByRole("button", { name: "YES", exact: true }).click();
      await page.getByLabel("Amount ($)").fill("50.00"); // above the configured max
      await page.getByRole("button", { name: "Get simulated quote" }).click();

      await expect(page.getByText("That amount is outside the allowed range for a simulated prediction.")).toBeVisible();
    } finally {
      await cleanup(marketIds, userIds);
    }
  });

  test("an expired quote cannot be confirmed and prompts the user to refresh", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-execution-expiry-${suffix}@test.local`;
    const userIds: string[] = [];
    const marketIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2eexecexp"));
      const marketId = await seedLiveMarket(`expiry_${suffix}`);
      marketIds.push(marketId);
      await admin.from("platform_settings").update({ execution_quote_expiry_seconds: 1 }).eq("id", true);

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      await page.getByRole("button", { name: "YES", exact: true }).click();
      await page.getByLabel("Amount ($)").fill("5.00");
      await page.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(page.getByText(/Review your simulated YES prediction/)).toBeVisible();

      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Confirm simulation" }).click();
      await expect(page.getByText("That quote has expired — please request a new one.")).toBeVisible();

      // Cancel returns to the idle state, ready for a fresh quote — the
      // refresh path this reason exists for, not a dead end.
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText("Try a simulated execution")).toBeVisible();
      await expect(page.getByRole("button", { name: "Get simulated quote" })).toBeVisible();
    } finally {
      await cleanup(marketIds, userIds);
    }
  });

  test("quote rate limiting is enforced from configurable platform_settings, not a hard-coded constant", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-execution-quote-rl-${suffix}@test.local`;
    const userIds: string[] = [];
    const marketIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2eexecqrl"));
      const marketId = await seedLiveMarket(`quote_rl_${suffix}`);
      marketIds.push(marketId);
      // A max of 1 makes the second quote request in this test the one
      // that gets blocked — proves the limit is read from
      // platform_settings (migration 20260101000152), not the original
      // hard-coded QUOTE_MAX_ATTEMPTS = 30 constant.
      await admin.from("platform_settings").update({ execution_quote_rate_limit_window_seconds: 60, execution_quote_rate_limit_max_attempts: 1 }).eq("id", true);

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      await page.getByRole("button", { name: "YES", exact: true }).click();
      await page.getByLabel("Amount ($)").fill("5.00");
      await page.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(page.getByText(/Review your simulated YES prediction/)).toBeVisible();

      // Cancel and immediately request a second quote as the same user —
      // this is the request that should be rejected by the 1-per-window
      // configured limit.
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "YES", exact: true }).click();
      await page.getByLabel("Amount ($)").fill("5.00");
      await page.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(page.getByText("Too many quote requests — please wait a moment and try again.")).toBeVisible();
    } finally {
      await cleanup(marketIds, userIds);
    }
  });

  test("confirmation rate limiting is enforced from configurable platform_settings, not a hard-coded constant, and stays independent of the quote limit", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-execution-confirm-rl-${suffix}@test.local`;
    const userIds: string[] = [];
    const marketIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2eexeccrl"));
      const marketId = await seedLiveMarket(`confirm_rl_${suffix}`);
      marketIds.push(marketId);
      // The quote limit stays generous here (well above the 2 quote
      // requests this test makes) while only the confirmation limit is
      // tightened — proving the two classes are configured, and enforced,
      // independently of each other.
      await admin
        .from("platform_settings")
        .update({
          execution_quote_rate_limit_window_seconds: 60,
          execution_quote_rate_limit_max_attempts: 10,
          execution_confirmation_rate_limit_window_seconds: 60,
          execution_confirmation_rate_limit_max_attempts: 1,
        })
        .eq("id", true);

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      // First confirmation attempt — consumes the configured budget of 1,
      // regardless of whether the simulated result itself fills or
      // rejects (the rate-limit check runs before that decision).
      await page.getByRole("button", { name: "YES", exact: true }).click();
      await page.getByLabel("Amount ($)").fill("5.00");
      await page.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(page.getByText(/Review your simulated YES prediction/)).toBeVisible();
      await page.getByRole("button", { name: "Confirm simulation" }).click();
      await expect(page.getByText(/Simulated YES prediction recorded|Simulation not confirmed/)).toBeVisible();

      // A fresh quote is well under the (still generous) quote limit — a
      // second confirmation attempt is what should now be blocked.
      const restartButton = page.getByRole("button", { name: "Simulate another" }).or(page.getByRole("button", { name: "Try again" }));
      await restartButton.click();
      await page.getByRole("button", { name: "YES", exact: true }).click();
      await page.getByLabel("Amount ($)").fill("5.00");
      await page.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(page.getByText(/Review your simulated YES prediction/)).toBeVisible();
      await page.getByRole("button", { name: "Confirm simulation" }).click();
      await expect(page.getByText("Too many confirmations — please wait a moment and try again.")).toBeVisible();
    } finally {
      await cleanup(marketIds, userIds);
    }
  });

  test("simulation is not offered on a closed market, and no provider/exchange jargon is exposed", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-execution-closed-${suffix}@test.local`;
    const userIds: string[] = [];
    const marketIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2eexecclosed"));
      const marketId = await seedLiveMarket(`closed_${suffix}`, { status: "CLOSED" });
      marketIds.push(marketId);

      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);

      await expect(page.getByText("Simulation — practice execution, no money will move")).toHaveCount(0);

      const bodyText = await page.locator("body").innerText();
      for (const term of [/\btoken\b/i, /\bCLOB\b/, /\bpolygon\b/i, /polymarket/i, /\bcontract\b/i, /\bshares?\b/i]) {
        expect(bodyText).not.toMatch(term);
      }
    } finally {
      await cleanup(marketIds, userIds);
    }
  });
});
