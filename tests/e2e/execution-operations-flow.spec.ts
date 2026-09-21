/**
 * E2E coverage for Milestone 5.5 — Execution Controls, Reconciliation &
 * Operational Safety (docs/architecture/execution-operational-safety.md).
 * Proves the browser-facing loop actually works end to end: an authorized
 * operator activates a GLOBAL kill switch from the admin operations
 * surface, a consumer's simulated-execution quote request is immediately
 * blocked (no reload/re-navigation needed beyond the next request), the
 * operator disables it again, the consumer's next request succeeds again,
 * and the activation/deactivation is visible as an audit event on the same
 * page. Also proves an unauthorized user cannot reach the surface at all.
 *
 * Deliberately uses a market with a FAKE (non-"polymarket") provider — the
 * control-plane check this test exercises runs before any provider call,
 * so no live network dependency is needed here at all (STEP 27's own
 * brittleness-reduction goal). Requires the local Supabase stack
 * (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

test.describe.configure({ mode: "serial" });

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

async function createSuperAdmin(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create admin user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: "E2E Ops Admin",
    username: `e2eopsadmin${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "super_admin",
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
}

async function seedMarket(provider: string, providerMarketId: string) {
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider,
      provider_market_id: providerMarketId,
      question: `E2E execution ops test: ${providerMarketId}`,
      status: "ACTIVE",
      yes_price: 0.5,
      no_price: 0.5,
      liquidity: 1000,
      closes_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create market");
  return data.id as string;
}

async function cleanup(marketIds: string[], userIds: string[]) {
  if (marketIds.length > 0) await admin.from("markets").delete().in("id", marketIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  await admin.from("execution_kill_switches").update({ enabled: false, disabled_at: new Date().toISOString() }).eq("enabled", true);
}

test.describe("Milestone 5.5 — Execution Operations", () => {
  test("operator activates a GLOBAL kill switch, a consumer quote request is blocked, then unblocked once disabled — with an audit trail", async ({ browser }) => {
    const suffix = randomUUID();
    const provider = `e2e_ops_provider_${suffix}`;
    const adminEmail = `e2e-ops-admin-${suffix}@test.local`;
    const playerEmail = `e2e-ops-player-${suffix}@test.local`;
    const userIds: string[] = [];
    const marketIds: string[] = [];

    const adminContext = await browser.newContext();
    const playerContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const playerPage = await playerContext.newPage();

    try {
      userIds.push(await createSuperAdmin(adminEmail));
      userIds.push(await createPlayer(playerEmail, "e2eopsplayer"));
      const marketId = await seedMarket(provider, `active_${suffix}`);
      marketIds.push(marketId);

      await loginAs(adminPage, adminEmail);
      await expect(adminPage).toHaveURL(/\/feed$/);
      await loginAs(playerPage, playerEmail);
      await expect(playerPage).toHaveURL(/\/feed$/);

      // Baseline: before any kill switch, a quote request reaches the
      // (fake, unreachable) provider and is rejected for a DIFFERENT
      // reason — proving the later block is specifically the kill switch,
      // not a coincidental failure.
      await playerPage.goto(`/markets/${marketId}`);
      await playerPage.getByRole("button", { name: "YES", exact: true }).click();
      await playerPage.getByLabel("Amount ($)").fill("5.00");
      await playerPage.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(playerPage.getByText("We can't reach live pricing for this market right now — try again in a moment.")).toBeVisible();

      // Operator activates a GLOBAL kill switch.
      await adminPage.goto("/admin/execution-operations");
      const killSwitchForm = adminPage.locator("form").filter({ has: adminPage.getByRole("button", { name: "Activate switch" }) });
      await killSwitchForm.getByLabel("Scope").selectOption("GLOBAL");
      await killSwitchForm.getByLabel("Reason").fill(`E2E incident drill ${suffix}`);
      await killSwitchForm.getByRole("button", { name: "Activate switch" }).click();
      await expect(adminPage.getByText(`E2E incident drill ${suffix}`)).toBeVisible();

      // Consumer's very next request is blocked — no reload of the
      // consumer's own session/page state was needed for this to take
      // effect, since the control plane is read fresh on every request.
      await playerPage.getByRole("button", { name: "YES", exact: true }).click();
      await playerPage.getByLabel("Amount ($)").fill("5.00");
      await playerPage.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(playerPage.getByText("Simulated predictions are temporarily unavailable.")).toBeVisible();

      // The audit trail records the activation.
      await adminPage.reload();
      await expect(adminPage.getByText("KILL_SWITCH_ACTIVATED").first()).toBeVisible();

      // Operator disables the switch — scoped to the specific row by its
      // reason text, never `.first()`, since the table also shows every
      // previously-created (already-disabled) switch from other tests.
      const switchRow = adminPage.locator("tr", { hasText: `E2E incident drill ${suffix}` });
      await switchRow.getByRole("button", { name: "Disable" }).click();
      await expect(switchRow.getByText("Disabled", { exact: false })).toBeVisible();

      // Consumer can now proceed again (back to the baseline, provider-side
      // failure — not the kill-switch message).
      await playerPage.getByRole("button", { name: "YES", exact: true }).click();
      await playerPage.getByLabel("Amount ($)").fill("5.00");
      await playerPage.getByRole("button", { name: "Get simulated quote" }).click();
      await expect(playerPage.getByText("We can't reach live pricing for this market right now — try again in a moment.")).toBeVisible();

      await adminPage.reload();
      await expect(adminPage.getByText("KILL_SWITCH_DEACTIVATED").first()).toBeVisible();
    } finally {
      await cleanup(marketIds, userIds);
      await adminContext.close();
      await playerContext.close();
    }
  });

  test("a player cannot reach the execution operations surface", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-ops-unauthorized-${suffix}@test.local`;
    const userIds: string[] = [];

    try {
      userIds.push(await createPlayer(email, "e2eopsdenied"));
      await loginAs(page, email);
      await expect(page).toHaveURL(/\/feed$/);

      await page.goto("/admin/execution-operations");
      await expect(page).toHaveURL(/\/feed$/);
    } finally {
      for (const id of userIds) await admin.auth.admin.deleteUser(id);
    }
  });
});
