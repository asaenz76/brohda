/**
 * E2E coverage for Milestone R9 (docs/BROHDA_2_0_MILESTONE_MAP.md, Monetary
 * Challenge + Position) — the "Put money on it" / Accept / Decline UI
 * surfaced inside MarketPredictionCard on /markets/[id], mirroring
 * tests/e2e/call-bs-challenges.spec.ts's own shape. No real money — the
 * recipient's wallet is funded through the same safe local
 * apply_wallet_transaction() test path tests/e2e/paid-entry-flow.spec.ts
 * already uses, never a real payment provider. Requires the local Supabase
 * stack (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
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
      external_fixture_id: `e2e-monetary-${randomUUID()}`,
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
      provider: "e2e_monetary",
      provider_market_id: `active_${randomUUID()}`,
      question: `E2E monetary test: ${randomUUID()}`,
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

async function cleanup(fixtureId: string, marketId: string, userIds: string[]) {
  const { data: proposalRows } = await admin.from("monetary_proposals").select("id").eq("market_id", marketId);
  const proposalIds = (proposalRows ?? []).map((r) => r.id);
  if (proposalIds.length > 0) {
    await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
    await admin.from("monetary_positions").delete().in("proposal_id", proposalIds);
    await admin.from("monetary_proposals").delete().in("id", proposalIds);
  }
  await admin.from("predictions").delete().eq("market_id", marketId);
  await admin.from("markets").delete().eq("id", marketId);
  await admin.from("fixtures").delete().eq("id", fixtureId);
  await admin.from("wallet_reservations").delete().in("user_id", userIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}

test.describe("Monetary Challenge + Position", () => {
  test("proposer sends money, an unfunded recipient can't accept until funded, and acceptance commits a Position with both holds visible", async ({ page }) => {
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-monetary-a-${suffix}@test.local`;
    const emailB = `e2e-monetary-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId } = await seedMarket();

    try {
      // A picks YES and will be the RECIPIENT of the money proposal
      // (unfunded at first); B picks NO and is the one who actually sends
      // the proposal — the "Put money on it" button appears on the
      // opposing participant's row for whoever is viewing, so B is the
      // proposer in this flow.
      const recipientId = await createPlayer(emailA, "e2emonetarya");
      const proposerId = await createPlayer(emailB, "e2emonetaryb");
      userIds.push(recipientId, proposerId);
      await fund(proposerId, 2000); // proposer must have the stake before sending

      // A picks YES.
      await loginAs(page, emailA);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: Yes" }).click();
      await expect(page.getByText(/You picked Yes/)).toBeVisible();

      // B picks NO, sees A's opposing pick, and proposes $10.
      await page.context().clearCookies();
      await loginAs(page, emailB);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();
      await page.reload();
      await expect(page.getByText("Other picks")).toBeVisible();

      // B proposes money on A's opposing pick.
      await page.getByRole("button", { name: "Put money on it" }).click();
      await page.getByPlaceholder("Amount").fill("10");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("$10.00 pending")).toBeVisible();

      // A sees the incoming proposal but has no funds yet — cannot accept,
      // only a "fund your wallet" prompt and Decline are offered. Funding
      // must never auto-accept.
      await page.context().clearCookies();
      await loginAs(page, emailA);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText(/not enough available balance/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);

      await fund(recipientId, 1000); // A (the recipient of this proposal) is funded through the safe local test path — no real money
      await page.reload();
      const { data: stillPendingAfterFunding } = await admin.from("monetary_proposals").select("status").eq("market_id", marketId).single();
      expect(stillPendingAfterFunding?.status).toBe("PENDING"); // funding alone never auto-accepts

      await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
      await page.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByText("$10.00 on the line")).toBeVisible();

      const { data: proposal } = await admin.from("monetary_proposals").select("status, position_id").eq("market_id", marketId).single();
      expect(proposal?.status).toBe("ACCEPTED");
      expect(proposal?.position_id).not.toBeNull();

      // Both participants' wallet pages show their hold.
      await page.goto("/wallet");
      await expect(page.getByText("On hold")).toBeVisible();
      await expect(page.getByText("$10.00").first()).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailB);
      await page.goto("/wallet");
      await expect(page.getByText("On hold")).toBeVisible();
    } finally {
      await cleanup(fixtureId, marketId, userIds);
    }
  });
});
