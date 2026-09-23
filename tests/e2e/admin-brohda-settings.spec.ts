/**
 * E2E coverage for Milestone R12 (docs/BROHDA_2_0_MILESTONE_MAP.md, Admin +
 * Configuration) — the real browser flow through the new /admin/settings/
 * brohda surface: an unauthorized player is turned away, a super_admin
 * changes a non-financial setting and sees both the product effect and the
 * audit trail, an invalid value is rejected with nothing else touched, and
 * a financial (P2P fee) change is proven non-retroactive against an
 * already-committed Position. No real money — funding, proposing, and
 * accepting all go through the same safe local RPC calls every other E2E
 * spec in this suite already uses. Requires the local Supabase stack
 * (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
 *
 * This file mutates the platform_settings singleton across many domains at
 * once (the same class of shared cross-test resource
 * platform-capability-toggle-flow.spec.ts already isolates itself for) —
 * see playwright.config.ts's own dedicated "chromium-admin-settings"
 * project, which guarantees this file never runs at the same time as any
 * other E2E spec.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

test.describe.configure({ mode: "serial" });

const DEFAULTS = {
  pick_lock_minutes_before_kickoff: 10,
  prediction_cutoff_minutes_before_close: 0,
  prediction_allow_repeat: false,
  prediction_allow_stale_price: true,
  prediction_allow_unavailable_price: false,
  prediction_allow_closed_market: false,
  leaderboard_min_decided_picks: 5,
  monetary_p2p_enabled: true,
  monetary_proposal_rate_limit_window_seconds: 60,
  monetary_proposal_rate_limit_max_attempts: 10,
  p2p_fee_bps: 0,
  call_bs_enabled: true,
  market_ingestion_enabled: true,
  post_publication_enabled: true,
  community_distribution_enabled: true,
};

async function restoreDefaults() {
  const { error } = await admin.from("platform_settings").update(DEFAULTS).eq("id", true);
  if (error) throw error;
}

async function createUser(label: string, role: "player" | "super_admin" = "player") {
  const email = `${label}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: label,
    username: `${label.replace(/[^a-z0-9]/gi, "")}${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role,
    is_active: true,
  });
  if (profileError) throw profileError;
  return { userId: data.user.id as string, email };
}

/** Scopes to the settings-sections.tsx FieldRow whose label paragraph exactly matches `label`, then finds the input inside it — robust against page-wide text collisions (e.g. the fee value itself echoing "4" elsewhere), unlike a bare document-order "next input" guess. */
function fieldInput(page: Page, label: string) {
  return page.locator("div.flex.items-center.justify-between", { has: page.getByText(label, { exact: true }) }).locator("input");
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedMarket(label: string) {
  const { data: fixture, error: fixtureErr } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-r12-${label}-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (fixtureErr || !fixture) throw fixtureErr ?? new Error("failed to create fixture");

  const { data: market, error: marketErr } = await admin
    .from("markets")
    .insert({
      provider: "e2e_r12",
      provider_market_id: `active_${randomUUID()}`,
      question: `E2E R12 test: ${randomUUID()}`,
      status: "ACTIVE",
      fixture_id: fixture.id,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      yes_price: 0.6,
      no_price: 0.4,
      liquidity: 1000,
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketErr || !market) throw marketErr ?? new Error("failed to create market");

  return { fixtureId: fixture.id as string, marketId: market.id as string };
}

async function pick(userId: string, marketId: string, selectedOutcome: "YES" | "NO") {
  const { data, error } = await admin
    .from("predictions")
    .insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: selectedOutcome,
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "q",
      market_close_at_snapshot: null,
      market_status_snapshot: "ACTIVE",
      idempotency_key: randomUUID(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("pick failed");
  return data.id as string;
}

async function grade(predictionId: string, result: "CORRECT" | "INCORRECT") {
  const { error } = await admin
    .from("predictions")
    .update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: result === "CORRECT" ? "YES" : "NO", graded_at: new Date().toISOString() })
    .eq("id", predictionId);
  if (error) throw error;
}

async function fund(userId: string, amount: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amount,
    p_admin_id: null,
    p_reason: "e2e funding",
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

/** Commits a Position at the CURRENT platform fee, entirely via direct RPC calls — this spec is testing the admin settings surface, not re-proving R9's own proposal UI. */
async function commitPosition(stake = 1000) {
  const { marketId } = await seedMarket(`fee-${randomUUID()}`);
  const proposer = await createUser("e2e-r12-proposer");
  const recipient = await createUser("e2e-r12-recipient");
  await fund(proposer.userId, stake);
  await fund(recipient.userId, stake);
  const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
  const recipientPredictionId = await pick(recipient.userId, marketId, "NO");
  const { data: proposal, error: proposeError } = await admin
    .rpc("propose_money", { p_proposer_user_id: proposer.userId, p_recipient_prediction_id: recipientPredictionId, p_stake: stake, p_idempotency_key: randomUUID(), p_source_challenge_id: null })
    .single();
  if (proposeError) throw proposeError;
  const { data: accepted, error: acceptError } = await admin
    .rpc("accept_monetary_proposal", { p_proposal_id: (proposal as { id: string }).id, p_recipient_user_id: recipient.userId })
    .single();
  if (acceptError) throw acceptError;
  const row = accepted as { position: { id: string; fee_bps: number } | null; outcome: string };
  if (row.outcome !== "accepted" || !row.position) throw new Error("commitPosition setup failed");
  return { positionId: row.position.id, feeBps: row.position.fee_bps, proposerPredictionId, recipientPredictionId };
}

test.describe("Admin Brohda Settings", () => {
  test.afterEach(async () => {
    await restoreDefaults();
  });

  test("an unauthorized player is turned away from the admin settings surface", async ({ page }) => {
    const { email } = await createUser("e2e-r12-player");
    await loginAs(page, email);
    await page.goto("/admin/settings/brohda");
    await expect(page).toHaveURL(/\/feed$/);
    await expect(page.getByText("Brohda Settings")).toHaveCount(0);
  });

  test("a super_admin sees current values, changes Reputation, sees the product effect, and sees it in history", async ({ page }) => {
    const { email } = await createUser("e2e-r12-admin", "super_admin");
    await loginAs(page, email);
    await page.goto("/admin/settings/brohda");
    await expect(page.getByRole("heading", { name: "Brohda Settings" })).toBeVisible();

    const leaderboardInput = fieldInput(page, "Leaderboard minimum sample");
    await expect(leaderboardInput).toHaveValue("5");
    await leaderboardInput.fill("3");
    await page.getByRole("button", { name: "Save Reputation" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    // Product effect: a user with exactly 3 decided Picks is now eligible.
    const { userId } = await createUser("e2e-r12-board");
    for (let i = 0; i < 3; i++) {
      const { marketId } = await seedMarket(`board-${i}-${randomUUID()}`);
      await grade(await pick(userId, marketId, "YES"), "CORRECT");
    }
    const { data: record } = await admin.rpc("get_user_prediction_record", { p_user_id: userId }).single();
    expect((record as { eligible_for_leaderboard: boolean }).eligible_for_leaderboard).toBe(true);

    await page.goto("/admin/settings/brohda/history");
    // Scoped to the single newest matching entry card (history orders
    // newest-first) — local dev accumulates many prior
    // "settings.reputation_updated" rows across earlier runs and manual
    // testing, so a page-wide text search hits Playwright's strict-mode
    // multiple-match error, the same class of collision documented
    // repeatedly elsewhere in this suite (e.g.
    // tests/e2e/reputation-leaderboards.spec.ts's own #row-{userId}
    // scoping) — never assert with a bare page-wide getByText() on a
    // shared, ever-growing local dataset.
    const latestEntry = page.locator("div.rounded-xl", { has: page.getByText("settings.reputation_updated", { exact: true }) }).first();
    await expect(latestEntry).toBeVisible();
    await expect(latestEntry.getByText(/"leaderboardMinDecidedPicks": 3/)).toBeVisible();
  });

  test("an invalid value is rejected in the UI and no unrelated setting changes", async ({ page }) => {
    const { email } = await createUser("e2e-r12-admin2", "super_admin");
    await loginAs(page, email);
    await page.goto("/admin/settings/brohda");

    const pickLockInput = fieldInput(page, "Pick lock");
    await pickLockInput.fill("-5");
    await page.getByRole("button", { name: "Save Predictions" }).click();
    await expect(page.getByText("Pick lock must be zero or more minutes.")).toBeVisible();

    const { data: row } = await admin.from("platform_settings").select("pick_lock_minutes_before_kickoff, prediction_cutoff_minutes_before_close").eq("id", true).single();
    expect(row!.pick_lock_minutes_before_kickoff).toBe(DEFAULTS.pick_lock_minutes_before_kickoff);
    expect(row!.prediction_cutoff_minutes_before_close).toBe(DEFAULTS.prediction_cutoff_minutes_before_close);
  });

  test("a financial (P2P fee) change through the admin UI never retroactively alters an already-committed Position", async ({ page }) => {
    const { email } = await createUser("e2e-r12-admin3", "super_admin");
    await loginAs(page, email);
    await page.goto("/admin/settings/brohda");

    const feeInput = fieldInput(page, "P2P settlement fee");
    await feeInput.fill("4");
    await page.getByRole("button", { name: "Save Monetary P2P" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    const older = await commitPosition(1000);
    expect(older.feeBps).toBe(400);

    await page.reload();
    const feeInputAfterReload = fieldInput(page, "P2P settlement fee");
    await feeInputAfterReload.fill("9");
    await page.getByRole("button", { name: "Save Monetary P2P" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    await grade(older.proposerPredictionId, "CORRECT");
    await grade(older.recipientPredictionId, "INCORRECT");
    const { data: settleResult, error: settleError } = await admin.rpc("settle_monetary_position", { p_position_id: older.positionId }).single();
    if (settleError) throw settleError;
    expect((settleResult as { outcome: string }).outcome).toBe("settled_win");

    const { data: settlement } = await admin.from("monetary_position_settlements").select("fee_bps").eq("position_id", older.positionId).single();
    expect(settlement!.fee_bps).toBe(400);

    const newer = await commitPosition(1000);
    expect(newer.feeBps).toBe(900);
  });
});
