/**
 * E2E coverage for Milestone R10 (docs/BROHDA_2_0_MILESTONE_MAP.md, P2P
 * Settlement) — continues tests/e2e/monetary-challenge-position.spec.ts's
 * own flow (R9) through to settlement: a committed Position, a local
 * authoritative Game/Market result (no real sports provider), the
 * settlement transaction, and the resulting Won/Lost UI + wallet state.
 * No real money — funding and grading both go through the same safe
 * local test paths every other E2E spec in this suite already uses.
 * Requires the local Supabase stack (`pnpm supabase:start`) — `pnpm
 * test:e2e` handles the rest.
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

async function fund(userId: string, amountCents: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amountCents,
    p_admin_id: null,
    p_reason: "e2e funding",
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedMarket() {
  const { data: fixture, error: fixtureErr } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-p2p-settlement-${randomUUID()}`,
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
      provider: "e2e_p2p_settlement",
      provider_market_id: `active_${randomUUID()}`,
      question: `E2E P2P settlement test: ${randomUUID()}`,
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

/** The one, already-established local authoritative-result path — directly grading the two test Predictions the same way lib/predictions/grading.ts's runGradingJob would, for a MONEYLINE market. No real sports provider is ever involved. */
async function produceLocalAuthoritativeResult(fixtureId: string, marketId: string, homeScore: number, awayScore: number) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  const outcome = homeScore > awayScore ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    const result = p.selected_outcome === outcome ? "CORRECT" : "INCORRECT";
    await admin
      .from("predictions")
      .update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: outcome, graded_at: new Date().toISOString() })
      .eq("id", p.id);
  }
}

async function cleanup(fixtureId: string, marketId: string, userIds: string[]) {
  const { data: positionRows } = await admin.from("monetary_positions").select("id").eq("market_id", marketId);
  const positionIds = (positionRows ?? []).map((r) => r.id);
  const { data: proposalRows } = await admin.from("monetary_proposals").select("id").eq("market_id", marketId);
  const proposalIds = (proposalRows ?? []).map((r) => r.id);
  if (proposalIds.length > 0) {
    await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
    if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
    await admin.from("monetary_proposals").delete().in("id", proposalIds);
  }
  if (positionIds.length > 0) await admin.from("monetary_position_settlements").delete().in("position_id", positionIds);
  await admin.from("predictions").delete().eq("market_id", marketId);
  await admin.from("markets").delete().eq("id", marketId);
  await admin.from("fixtures").delete().eq("id", fixtureId);
  await admin.from("wallet_reservations").delete().in("user_id", userIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}

test.describe("P2P Settlement", () => {
  test("a committed Position settles from a local authoritative result, crediting the winner and updating both wallets", async ({ page }) => {
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, p2p_fee_bps: 0 }).eq("id", true);
    const suffix = randomUUID();
    const emailWinner = `e2e-p2p-winner-${suffix}@test.local`;
    const emailLoser = `e2e-p2p-loser-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId } = await seedMarket();

    try {
      // Winner picks YES (home); loser is the one who actually proposes
      // money — the "Put money on it" control appears on the viewer's
      // opposing-participant row, so whoever clicks it is the proposer.
      const winnerId = await createPlayer(emailWinner, "e2ep2pwinner");
      const loserId = await createPlayer(emailLoser, "e2ep2ploser");
      userIds.push(winnerId, loserId);
      await fund(loserId, 2000);
      await fund(winnerId, 2000);

      await loginAs(page, emailWinner);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: Yes" }).click();
      await expect(page.getByText(/You picked Yes/)).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailLoser);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Put money on it" }).click();
      await page.getByPlaceholder("Amount").fill("10");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("$10.00 pending")).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailWinner);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
      await page.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByText("$10.00 on the line")).toBeVisible();

      const { data: position } = await admin.from("monetary_positions").select("id").eq("market_id", marketId).single();
      expect(position?.id).toBeTruthy();

      // The local authoritative Game result: home wins 21-10 -> YES -> the winner's Pick is correct.
      await produceLocalAuthoritativeResult(fixtureId, marketId, 21, 10);

      // Settlement itself has no UI trigger anywhere in this app (it's a
      // backend job — scripts/settle-monetary-positions.ts) — call the
      // same RPC that script calls, directly, exactly as the runner would.
      const { data: settleResult, error: settleError } = await admin.rpc("settle_monetary_position", { p_position_id: position!.id }).single();
      expect(settleError).toBeNull();
      expect((settleResult as { outcome: string }).outcome).toBe("settled_win");

      // The winner now sees "Won $10.00" on the same row.
      await page.reload();
      await expect(page.getByText("Won $10.00")).toBeVisible();

      // The loser sees "Lost $10.00".
      await page.context().clearCookies();
      await loginAs(page, emailLoser);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText("Lost $10.00")).toBeVisible();

      // Both wallets reflect the settlement: loser's balance shrank by
      // their own $10 stake (2000 -> 1000 cents = $10.00), the hold is
      // gone (already on this page, still logged in as the loser).
      await page.goto("/wallet");
      await expect(page.getByText("$10.00").first()).toBeVisible();
      await expect(page.getByText("On hold")).toHaveCount(0);

      // Winner's balance grew by the full losing stake (zero fee
      // configured): 2000 (own) + 1000 (won) = 3000 cents = $30.00.
      await page.context().clearCookies();
      await loginAs(page, emailWinner);
      await page.goto("/wallet");
      await expect(page.getByText("$30.00").first()).toBeVisible();
      await expect(page.getByText("On hold")).toHaveCount(0);

      const { data: finalPosition } = await admin.from("monetary_positions").select("settlement_status").eq("id", position!.id).single();
      expect(finalPosition?.settlement_status).toBe("SETTLED");
    } finally {
      await cleanup(fixtureId, marketId, userIds);
    }
  });
});
