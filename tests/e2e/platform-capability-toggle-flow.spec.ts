/**
 * E2E coverage for the global platform capability toggle
 * (FREE_MODE_ARCHITECTURE_PROPOSAL.md §5/§13) — proves the browser-facing
 * stale-client race actually resolves the way the architecture document
 * and the RPC-level integration tests (tests/integration/free-mode.test.ts)
 * already proved at the database layer: a confirmation sheet opened while
 * a capability was enabled is rejected, with zero side effects, the
 * instant an admin disables it — even mid-confirmation — and resumes
 * working the instant it's re-enabled, with no reload or re-navigation
 * required. Requires the local Supabase stack (`pnpm supabase:start`) —
 * `pnpm test:e2e` handles the rest.
 *
 * This suite mutates the platform_settings singleton row — the exact same
 * class of shared, non-parallelizable state vitest.integration.config.ts
 * already documents (`fileParallelism: false`, "these tests share one
 * real database... mutate a singleton"). `test.describe.configure({ mode:
 * "serial" })` below keeps this file's own two tests from racing each
 * other, and each test restores both flags to `true` in a `finally` no
 * matter how it exits.
 *
 * Cross-file isolation (this file vs. paid-entry-flow.spec.ts/
 * free-entry-flow.spec.ts, which assume both capabilities stay enabled for
 * their own duration) is handled in playwright.config.ts: this file is
 * matched into its own "chromium-capability-toggle" project, which
 * declares `dependencies: ["chromium"]` — Playwright guarantees a
 * dependency project's tests all finish before the dependent project's
 * tests start, so this file never runs at the same time as anything in
 * the main "chromium" project. The canonical `playwright test` command
 * (no flags) is deterministic as a result — no `--workers=1` needed.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

test.describe.configure({ mode: "serial" });

async function createPlayer(email: string, balanceCents = 0) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `e2etoggle${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;

  if (balanceCents > 0) {
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
  }

  return data.user.id as string;
}

// CI's E2E job (.github/workflows/ci.yml) never bootstraps a super_admin —
// only invite-flow.spec.ts's own admin/invitee are created inline, the same
// pattern this mirrors — so this must create its own rather than assume one
// exists.
async function getAdminId(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `e2e-toggle-admin-${randomUUID()}@example.com`,
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

async function createFixture(label: string): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-toggle-${label}-${randomUUID()}`,
      home_team_name: `E2E Toggle Home ${label}`,
      away_team_name: `E2E Toggle Away ${label}`,
      scheduled_start_utc: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  return data.id as string;
}

async function createPool(
  fixtureId: string,
  creatorId: string,
  opts: { entryMode: "PAID" | "FREE"; entryFeeCents?: number },
) {
  const isPaid = opts.entryMode === "PAID";
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: creatorId,
      pool_type: "TEMPLATE_GRADED",
      template_id: "BOTH_TEAMS_TO_SCORE",
      template_config: {},
      question: `E2E toggle test (${opts.entryMode})`,
      entry_mode: opts.entryMode,
      entry_fee: isPaid ? (opts.entryFeeCents ?? 1000) : null,
      house_fee_bps: isPaid ? 500 : 0,
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

async function setCapability(paid: boolean | undefined, free: boolean | undefined) {
  const update: Record<string, boolean> = {};
  if (paid !== undefined) update.paid_pools_enabled = paid;
  if (free !== undefined) update.free_pools_enabled = free;
  const { error } = await admin.from("platform_settings").update(update).eq("id", true);
  if (error) throw error;
}

async function countEntries(poolId: string, userId: string): Promise<number> {
  const { count } = await admin
    .from("entries")
    .select("id", { count: "exact", head: true })
    .eq("pool_id", poolId)
    .eq("user_id", userId);
  return count ?? 0;
}

test.describe("platform capability toggle — stale client at confirmation time", () => {
  test.afterEach(async () => {
    // Belt and suspenders alongside each test's own re-enable step — if an
    // assertion throws mid-test, the platform must not stay disabled for
    // whatever runs next.
    await setCapability(true, true);
  });

  test("FREE: disabled mid-confirmation rejects with the specific error, no entry; re-enabling resumes it on the same open pool", async ({
    page,
  }) => {
    await setCapability(undefined, true);

    const adminId = await getAdminId();
    const fixtureId = await createFixture("free");
    const { poolId } = await createPool(fixtureId, adminId, { entryMode: "FREE" });
    const email = `e2e-toggle-free-${Date.now()}@example.com`;
    const playerId = await createPlayer(email);

    await loginAs(page, email);
    await page.goto(`/pool/${poolId}`);
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(page.getByText("Your pick")).toBeVisible();

    // Admin disables free pools while this exact sheet is already open —
    // the stale-client scenario.
    await setCapability(undefined, false);

    await page.getByRole("button", { name: /tap here to confirm/i }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText("Free pools are temporarily unavailable. Try again later.");
    expect(await countEntries(poolId, playerId)).toBe(0);

    // Re-enable — same pool, still OPEN, no reload/re-navigation.
    await setCapability(undefined, true);
    await page.getByRole("button", { name: /tap here to confirm/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(await countEntries(poolId, playerId)).toBe(1);
    const { data: entry } = await admin
      .from("entries")
      .select("amount")
      .eq("pool_id", poolId)
      .eq("user_id", playerId)
      .single();
    expect(entry?.amount).toBeNull();
  });

  test("PAID: disabled mid-confirmation rejects with the specific error, no entry, no wallet debit", async ({ page }) => {
    await setCapability(true, undefined);

    const adminId = await getAdminId();
    const fixtureId = await createFixture("paid");
    const entryFeeCents = 750;
    const { poolId } = await createPool(fixtureId, adminId, {
      entryMode: "PAID",
      entryFeeCents,
    });
    const email = `e2e-toggle-paid-${Date.now()}@example.com`;
    const playerId = await createPlayer(email, 5000);

    await loginAs(page, email);
    await page.goto(`/pool/${poolId}`);
    await page.getByRole("button", { name: "Yes" }).click();
    await expect(page.getByText(/entry fee/i)).toBeVisible();

    // Admin disables paid pools while this exact sheet is already open.
    await setCapability(false, undefined);

    await page.getByRole("button", { name: /tap here to confirm/i }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText("Paid pools are temporarily unavailable. Try again later.");

    expect(await countEntries(poolId, playerId)).toBe(0);
    const { count: walletTxCount } = await admin
      .from("wallet_transactions")
      .select("id", { count: "exact", head: true })
      .eq("pool_id", poolId)
      .eq("user_id", playerId);
    expect(walletTxCount).toBe(0);
    const { data: balance } = await admin.from("wallet_balances").select("balance").eq("user_id", playerId).single();
    expect(balance?.balance).toBe(5000);
  });
});
