/**
 * E2E coverage for the wallet's held-funds display: the header pill leads
 * with what's available to act on, and the wallet page leads with
 * Available, with On hold and Total beneath it. Money on hold is still the
 * person's (a hold isn't a spend), so the total is shown, just never as the
 * headline. Funding and the hold go through the same local RPCs the other
 * wallet specs use. Requires the local Supabase stack.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createFundedPlayerWithHold(email: string, totalCents: number, heldCents: number) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `e2ewallet${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;

  const { error: depositError } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: data.user.id,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: totalCents,
    p_admin_id: null,
    p_reason: "e2e funding",
    p_idempotency_key: randomUUID(),
  });
  if (depositError) throw depositError;

  if (heldCents > 0) {
    const { error: holdError } = await admin.rpc("reserve_funds", {
      p_user_id: data.user.id,
      p_amount: heldCents,
      p_purpose: "withdrawal_request",
      p_idempotency_key: randomUUID(),
    });
    if (holdError) throw holdError;
  }
  return data.user.id as string;
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function cleanup(userId: string) {
  await admin.from("wallet_reservations").delete().eq("user_id", userId);
  // A funded user can't be hard-deleted (the ledger is append-only); the
  // attempt is harmless when it can't succeed.
  await admin.auth.admin.deleteUser(userId);
}

test.describe("Wallet balance", () => {
  test("the header leads with available funds and the wallet page breaks out what's on hold", async ({ page }) => {
    const email = `e2e-wallet-hold-${randomUUID()}@test.local`;
    const userId = await createFundedPlayerWithHold(email, 100_000, 20_000);
    try {
      await loginAs(page, email);

      const pill = page.getByRole("link", { name: /^Wallet:/ });
      await expect(pill).toHaveAttribute("href", "/wallet");
      await expect(pill).toContainText("$800.00");
      await expect(pill).toHaveAttribute("title", "$800.00 available, $200.00 on hold");
      await expect(pill).not.toContainText("$1,000.00");

      await page.goto("/wallet");
      const card = page.locator("main").first();
      await expect(card.getByText("Available", { exact: true })).toBeVisible();
      await expect(card.getByText("$800.00").first()).toBeVisible();
      await expect(card.getByText("On hold", { exact: true })).toBeVisible();
      await expect(card.getByText("$200.00").first()).toBeVisible();
      await expect(card.getByText("Total", { exact: true })).toBeVisible();
      await expect(card.getByText("$1,000.00").first()).toBeVisible();
    } finally {
      await cleanup(userId);
    }
  });

  test("with nothing on hold, the wallet stays simple: just the available amount", async ({ page }) => {
    const email = `e2e-wallet-free-${randomUUID()}@test.local`;
    const userId = await createFundedPlayerWithHold(email, 50_000, 0);
    try {
      await loginAs(page, email);
      await expect(page.getByRole("link", { name: "Wallet: $500.00 available" })).toBeVisible();

      await page.goto("/wallet");
      await expect(page.getByText("Available", { exact: true })).toBeVisible();
      await expect(page.getByText("On hold", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Total", { exact: true })).toHaveCount(0);
    } finally {
      await cleanup(userId);
    }
  });
});
