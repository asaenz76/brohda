/**
 * E2E baseline for the PAID entry flow (FREE_MODE_ARCHITECTURE_PROPOSAL.md
 * §15's E2E ask, and the release-gate follow-up that required it before
 * this feature could be considered release-ready) — proves the browser is
 * correctly wired to the already-integration-tested create_pool_entry RPC,
 * not a re-test of the RPC's own logic. Requires the local Supabase stack
 * (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createPlayer(email: string, balanceCents: number) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  // A username is required before the app lets any account past
  // middleware's profile-completion redirect (lib/supabase/middleware.ts)
  // — set explicitly, unlike the plain integration-test player helpers,
  // which never navigate real pages and so never hit that gate.
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `e2epaid${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;

  const { error: fundError } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: data.user.id,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: balanceCents,
    p_admin_id: null,
    p_reason: "e2e funding",
    p_idempotency_key: randomUUID(),
  });
  if (fundError) throw fundError;

  return data.user.id as string;
}

// CI's E2E job (.github/workflows/ci.yml) never bootstraps a super_admin —
// only invite-flow.spec.ts's own admin/invitee are created inline, the same
// pattern this mirrors — so this must create its own rather than assume one
// exists.
async function getAdminId(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `e2e-paid-admin-${randomUUID()}@example.com`,
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
      external_fixture_id: `e2e-paid-${randomUUID()}`,
      home_team_name: "E2E Paid Home FC",
      away_team_name: "E2E Paid Away FC",
      scheduled_start_utc: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  return data.id as string;
}

async function createPaidPool(fixtureId: string, creatorId: string, entryFeeCents: number) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
      pool_type: "TEMPLATE_GRADED",
      template_id: "BOTH_TEAMS_TO_SCORE",
      template_config: {},
      question: "E2E: will the home team win?",
      entry_mode: "PAID",
      entry_fee: entryFeeCents,
      house_fee_bps: 500,
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

test("PAID entry flow: pick, confirm, entered state, correct fixed amount, no FREE copy", async ({ page }) => {
  const adminId = await getAdminId();
  const fixtureId = await createFixture();
  const entryFeeCents = 1000; // $10.00
  const { poolId } = await createPaidPool(fixtureId, adminId, entryFeeCents);
  const email = `e2e-paid-${Date.now()}@example.com`;
  const playerId = await createPlayer(email, 5000); // $50.00 — comfortably above entryFeeCents

  await loginAs(page, email);
  await page.goto(`/pool/${poolId}`);

  // Before entering: PAID card copy ("entered"), never FREE's ("predicted").
  await expect(page.getByText(/entered$/i).first()).toBeVisible();
  await expect(page.getByText(/predicted/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Yes" }).click();

  // PAID confirmation UI: exact fixed entry amount, balance-after, platform
  // fee note — none of FREE's UI/copy.
  await expect(page.getByText(/entry fee/i)).toBeVisible();
  await expect(page.getByText("$10.00").first()).toBeVisible();
  await expect(page.getByText(/balance after entry/i)).toBeVisible();
  await expect(page.getByText("$40.00")).toBeVisible(); // 5000 - 1000 = 4000 cents
  await expect(page.getByText(/platform fee/i)).toBeVisible();
  await expect(page.getByText(/predicted/i)).toHaveCount(0);
  await expect(page.getByText(/you're in/i)).toHaveCount(0);

  await page.getByRole("button", { name: /tap here to confirm/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Force a fresh server render to confirm the entered state persisted,
  // not just optimistic client state.
  await page.reload();
  await expect(page.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("1 entered")).toBeVisible();

  const { data: entry } = await admin
    .from("entries")
    .select("amount, status")
    .eq("pool_id", poolId)
    .eq("user_id", playerId)
    .single();
  expect(entry?.amount).toBe(entryFeeCents);
  expect(entry?.status).toBe("ACTIVE");

  const { data: tx } = await admin
    .from("wallet_transactions")
    .select("amount, type")
    .eq("pool_id", poolId)
    .eq("user_id", playerId)
    .single();
  expect(tx?.amount).toBe(entryFeeCents);
  expect(tx?.type).toBe("pool_entry_debit");

  const { data: balance } = await admin.from("wallet_balances").select("balance").eq("user_id", playerId).single();
  expect(balance?.balance).toBe(5000 - entryFeeCents);
});
