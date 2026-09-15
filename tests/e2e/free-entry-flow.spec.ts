/**
 * E2E baseline for the FREE entry flow — the counterpart to
 * paid-entry-flow.spec.ts. Proves the browser correctly renders the
 * money-free card/sheet (FreeEntryConfirmationSheet, PoolSummary's
 * "predicted" copy) and that a real prediction through the UI produces the
 * exact backend state the integration suite already proved
 * (amount = null, zero wallet_transactions), not a re-test of that RPC
 * logic itself. Requires the local Supabase stack (`pnpm supabase:start`)
 * — `pnpm test:e2e` handles the rest.
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
    username: `e2efree${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;

  return data.user.id as string;
}

// CI's E2E job (.github/workflows/ci.yml) never bootstraps a super_admin —
// only invite-flow.spec.ts's own admin/invitee are created inline, the same
// pattern this mirrors — so this must create its own rather than assume one
// exists.
async function getAdminId(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `e2e-free-admin-${randomUUID()}@example.com`,
    password: "e2e-admin-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create admin user");

  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: "E2E Admin",
    role: "super_admin",
    is_active: true,
  });
  if (profileError) throw profileError;

  return data.user.id as string;
}

async function createFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-free-${randomUUID()}`,
      home_team_name: "E2E Free Home FC",
      away_team_name: "E2E Free Away FC",
      scheduled_start_utc: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  return data.id as string;
}

async function createFreePool(fixtureId: string, creatorId: string) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
      pool_type: "TEMPLATE_GRADED",
      template_id: "BOTH_TEAMS_TO_SCORE",
      template_config: {},
      question: "E2E: will the home team win (free)?",
      entry_mode: "FREE",
      entry_fee: null,
      house_fee_bps: 0,
      min_total_entries: 1,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create pool");

  const { data: options, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: pool.id, label: "Yes", sort_order: 0, binary_outcome: "YES" },
      { pool_id: pool.id, label: "No", sort_order: 1, binary_outcome: "NO" },
    ])
    .select("id, label");
  if (optionsError || !options) throw optionsError ?? new Error("failed to create options");

  return {
    poolId: pool.id as string,
    yesOptionId: options.find((o) => o.label === "Yes")!.id as string,
  };
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

test("FREE entry flow: no money UI anywhere, pick, confirm, predicted state, null amount", async ({ page }) => {
  const adminId = await getAdminId();
  const fixtureId = await createFixture();
  const { poolId } = await createFreePool(fixtureId, adminId);
  const email = `e2e-free-${Date.now()}@example.com`;
  const playerId = await createPlayer(email);

  await loginAs(page, email);
  await page.goto(`/pool/${poolId}`);

  // Before predicting: FREE card copy ("predicted"), never PAID's
  // ("entered"), and no pot/price anywhere on the card.
  await expect(page.getByText(/predicted$/i).first()).toBeVisible();
  await expect(page.getByText(/entered$/i)).toHaveCount(0);
  await expect(page.getByText(/pot$/i)).toHaveCount(0);
  await expect(page.getByText(/entry fee/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Yes" }).click();

  // FreeEntryConfirmationSheet: "Your pick", the lock time, nothing else —
  // no entry fee, no balance, no estimated return, no top-up/wallet UI.
  await expect(page.getByText("Your pick")).toBeVisible();
  await expect(page.getByText(/entry fee/i)).toHaveCount(0);
  await expect(page.getByText(/balance after entry/i)).toHaveCount(0);
  await expect(page.getByText(/estimated return/i)).toHaveCount(0);
  await expect(page.getByText(/platform fee/i)).toHaveCount(0);
  await expect(page.getByText(/top.?up/i)).toHaveCount(0);
  await expect(page.getByText(/insufficient balance/i)).toHaveCount(0);

  await page.getByRole("button", { name: /tap here to confirm/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("1 predicted")).toBeVisible();

  const { data: entry } = await admin
    .from("entries")
    .select("amount, status")
    .eq("pool_id", poolId)
    .eq("user_id", playerId)
    .single();
  expect(entry?.amount).toBeNull();
  expect(entry?.status).toBe("ACTIVE");

  const { count: walletTxCount } = await admin
    .from("wallet_transactions")
    .select("id", { count: "exact", head: true })
    .eq("pool_id", poolId)
    .eq("user_id", playerId);
  expect(walletTxCount).toBe(0);
});
