/**
 * Consumer monetary capability gating, end to end. With monetary_p2p_enabled = false the consumer app is a complete free product: no
 * Wallet entry, no money action, no Money section in the Rules — while a person who still has money in the system can always see it and
 * take it out, an offer that already exists can be declined, and operators keep their financial view. With it on, everything is back.
 *
 * Runs in the serial project (it flips the platform_settings singleton) after the parallel suite; the global setup's ambient value is
 * restored afterwards.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

test.describe.configure({ mode: "serial" });

let originalFlag = true;

async function setMoney(enabled: boolean) {
  const { error } = await admin.from("platform_settings").update({ monetary_p2p_enabled: enabled }).eq("id", true);
  if (error) throw error;
}

test.beforeAll(async () => {
  const { data } = await admin.from("platform_settings").select("monetary_p2p_enabled").eq("id", true).single();
  originalFlag = data?.monetary_p2p_enabled ?? true;
});
test.afterAll(async () => {
  await setMoney(originalFlag);
});

async function createUser(prefix: string, role: "player" | "admin" | "super_admin" = "player") {
  const email = `e2e-${prefix}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: prefix,
    username: `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role,
    is_active: true,
  });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email };
}

async function fund(userId: string, amountCents: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user", p_user_id: userId, p_type: "manual_deposit", p_direction: "credit",
    p_amount: amountCents, p_admin_id: null, p_reason: "e2e funding", p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

async function loginAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedMarket() {
  const { data: fixture, error: fixtureErr } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-capgate-${randomUUID()}`, home_team_name: "Home Test FC", away_team_name: "Away Test FC", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (fixtureErr || !fixture) throw fixtureErr ?? new Error("failed to create fixture");
  const { data: market, error: marketErr } = await admin
    .from("markets")
    .insert({ provider: "e2e_capgate", provider_market_id: `active_${randomUUID()}`, question: `E2E capability gating: ${randomUUID()}`, status: "ACTIVE", fixture_id: fixture.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {} })
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

// The seeded Market is a MONEYLINE with the home team as YES, so "Yes" is the home team and "No" the away team — the choices read as teams.
const TEAM_FOR_SIDE = { Yes: "Home Test FC", No: "Away Test FC" } as const;
async function pickOn(page: Page, marketId: string, side: "Yes" | "No") {
  const team = TEAM_FOR_SIDE[side];
  await page.goto(`/markets/${marketId}`);
  await page.getByRole("button", { name: `Pick ${team} to win` }).click();
  await expect(page.getByText(new RegExp(`You picked ${team}`))).toBeVisible();
}

async function predictionId(userId: string, marketId: string): Promise<string> {
  const { data } = await admin.from("predictions").select("id").eq("user_id", userId).eq("market_id", marketId).single();
  return data!.id as string;
}

const walletLink = (page: Page) => page.getByRole("link", { name: /^Wallet/ });

test.describe("Money OFF — a complete free product", () => {
  test("a player with nothing in the system: no Wallet entry (desktop or phone), /wallet redirects quietly, Rules has no Money section, and Picks and Call BS still work", async ({ page, browser }) => {
    const { fixtureId, marketId } = await seedMarket();
    const a = await createUser("free-a");
    const b = await createUser("free-b");
    try {
      await setMoney(true);
      await loginAs(page, b.email);
      await pickOn(page, marketId, "No"); // an opposing Pick for A to see
      await setMoney(false);

      await loginAs(page, a.email);
      await expect(page.getByRole("link", { name: /^Feed|^Home/ }).first()).toBeVisible();
      await expect(walletLink(page)).toHaveCount(0);

      // The route itself never errors for a consumer — it just isn't a destination.
      const response = await page.goto("/wallet");
      expect(response?.status()).toBeLessThan(400);
      await expect(page).toHaveURL(/\/feed$/);

      await pickOn(page, marketId, "Yes");
      await page.reload();
      await expect(page.getByText("Other picks")).toBeVisible();
      await expect(page.getByRole("button", { name: "Put money on it" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /call bs/i }).first()).toBeVisible();
      const main = page.getByRole("main");
      await expect(main).not.toContainText(/put money|on the line|\bstake\b|\bfee\b|real money/i);

      await page.goto("/rules");
      await expect(page.getByRole("heading", { level: 2, name: "Money" })).toHaveCount(0);
      const rules = page.getByRole("main");
      await expect(rules).toContainText("A Pick is free.");
      await expect(rules).not.toContainText(/\bmoney\b|\bfees?\b|\bstakes?\b|\bwallet\b|\bposition/i);

      // Phone: the Menu sheet has no Wallet either.
      const phone = await browser.newContext({ viewport: { width: 375, height: 812 } });
      const mobile = await phone.newPage();
      await loginAs(mobile, a.email);
      await mobile.getByRole("button", { name: "Menu" }).click();
      const sheet = mobile.getByTestId("auth-mobile-menu");
      await expect(sheet.getByRole("link", { name: /^Rules/ })).toBeVisible();
      await expect(sheet.getByRole("link", { name: /^Wallet/ })).toHaveCount(0);
      await phone.close();

      // Account settings don't talk about a balance the person can't see.
      await page.goto("/profile/edit");
      await page.getByRole("button", { name: "Close account" }).click();
      await expect(page.getByText("You’ll need no picks still in progress.")).toBeVisible();
      await expect(page.getByRole("main")).not.toContainText(/\$0 balance|withdrawal request/i);
    } finally {
      await setMoney(false);
      await cleanup(fixtureId, marketId, [a.id, b.id]);
    }
  });

  test("a funded player with a pending offer: Wallet stays reachable to take money out (no Add Funds), the offer can only be declined, and nobody can start a new one", async ({ page }) => {
    const { fixtureId, marketId } = await seedMarket();
    const a = await createUser("wind-a"); // will receive the offer
    const b = await createUser("wind-b"); // sent it
    try {
      await setMoney(true);
      await fund(a.id, 3000);
      await fund(b.id, 3000);
      await loginAs(page, a.email);
      await pickOn(page, marketId, "Yes");
      await loginAs(page, b.email);
      await pickOn(page, marketId, "No");
      const { error } = await admin.rpc("propose_money", { p_proposer_user_id: b.id, p_recipient_prediction_id: await predictionId(a.id, marketId), p_stake: 1000, p_idempotency_key: randomUUID(), p_source_challenge_id: null });
      if (error) throw error;
      await setMoney(false);

      // Recipient A: the offer is decline-only; no Accept, no funding prompt, no new "Put money on it".
      await loginAs(page, a.email);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText(/sent an offer of \$10\.00\. It can no longer be accepted/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Put money on it" })).toHaveCount(0);
      await expect(page.getByText(/not enough available balance|fund your wallet/i)).toHaveCount(0);

      // Their wallet is still reachable (they hold money), with only Transfer Out.
      await expect(walletLink(page)).toBeVisible();
      await page.goto("/wallet");
      await expect(page).toHaveURL(/\/wallet$/);
      await expect(page.getByRole("button", { name: "Transfer Out" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add Funds" })).toHaveCount(0);

      // Declining releases the sender's hold.
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Decline" }).click();
      await expect.poll(async () => (await admin.from("monetary_proposals").select("status").eq("market_id", marketId).single()).data?.status).toBe("DECLINED");
      const { data: reservations } = await admin.from("wallet_reservations").select("status").eq("user_id", b.id);
      expect((reservations ?? []).every((r) => r.status !== "ACTIVE")).toBe(true);

      // The sender B, now with nothing held but a balance, still sees their wallet and no money action either.
      await loginAs(page, b.email);
      await expect(walletLink(page)).toBeVisible();
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByRole("button", { name: "Put money on it" })).toHaveCount(0);
    } finally {
      await setMoney(false);
      await cleanup(fixtureId, marketId, [a.id, b.id]);
    }
  });

  test("operators keep their financial view with money off: Wallet, and the super admin's money pages", async ({ page }) => {
    await setMoney(false);
    for (const role of ["admin", "super_admin"] as const) {
      const operator = await createUser(`op-${role}`, role);
      try {
        await loginAs(page, operator.email);
        await expect(walletLink(page)).toBeVisible();
        await page.goto("/wallet");
        await expect(page).toHaveURL(/\/wallet$/);
        if (role === "super_admin") {
          // The money admin surface (requests, ledger) is untouched by the consumer flag.
          await page.goto("/admin/wallet-requests");
          await expect(page).toHaveURL(/\/admin\/wallet-requests$/);
        }
      } finally {
        await admin.auth.admin.deleteUser(operator.id);
      }
    }
  });
});

test.describe("Money ON — everything is back", () => {
  test("Wallet is visible to everyone, the money action is offered between funded opponents, and the Rules show the live Money section", async ({ page }) => {
    const { fixtureId, marketId } = await seedMarket();
    const a = await createUser("on-a");
    const b = await createUser("on-b");
    try {
      await setMoney(true);
      await fund(a.id, 3000);
      await fund(b.id, 3000);
      await loginAs(page, b.email);
      await pickOn(page, marketId, "No");
      await loginAs(page, a.email);
      await expect(walletLink(page)).toBeVisible();
      await pickOn(page, marketId, "Yes");
      await page.reload();
      await expect(page.getByRole("button", { name: "Put money on it" })).toBeVisible();

      const { data } = await admin.from("platform_settings").select("p2p_fee_bps").eq("id", true).single();
      await page.goto("/rules");
      await expect(page.getByRole("heading", { level: 2, name: "Money" })).toBeVisible();
      await expect(page.getByRole("main")).toContainText(`The fee is currently ${(data!.p2p_fee_bps / 100).toString().replace(/\.0+$/, "")}%`);

      const nothing = await createUser("on-nothing");
      try {
        await loginAs(page, nothing.email);
        await expect(walletLink(page)).toBeVisible();
        await page.goto("/wallet");
        await expect(page).toHaveURL(/\/wallet$/);
        await expect(page.getByRole("button", { name: "Add Funds" })).toBeVisible();
      } finally {
        await admin.auth.admin.deleteUser(nothing.id);
      }
    } finally {
      await cleanup(fixtureId, marketId, [a.id, b.id]);
    }
  });
});

test.describe("Privacy — other people's money stays out of sight", () => {
  test("a third person on the same Market sees no pending offer, no Position, and no money indicators — with money on or off", async ({ page }) => {
    const { fixtureId, marketId } = await seedMarket();
    const a = await createUser("priv-a");
    const b = await createUser("priv-b");
    const c = await createUser("priv-c");
    try {
      await setMoney(true);
      await fund(a.id, 3000);
      await fund(b.id, 3000);
      await loginAs(page, a.email);
      await pickOn(page, marketId, "Yes");
      await loginAs(page, b.email);
      await pickOn(page, marketId, "No");
      await loginAs(page, c.email);
      await pickOn(page, marketId, "Yes");

      const { data: proposed, error } = await admin.rpc("propose_money", { p_proposer_user_id: b.id, p_recipient_prediction_id: await predictionId(a.id, marketId), p_stake: 1500, p_idempotency_key: randomUUID(), p_source_challenge_id: null }).single();
      if (error) throw error;
      const { error: acceptError } = await admin.rpc("accept_monetary_proposal", { p_proposal_id: (proposed as { id: string }).id, p_recipient_user_id: a.id });
      if (acceptError) throw acceptError;

      for (const enabled of [true, false]) {
        await setMoney(enabled);
        await page.goto(`/markets/${marketId}`);
        await page.reload();
        await expect(page.getByText("Other picks")).toBeVisible();
        const main = page.getByRole("main");
        // Someone else's amount, offer or Position is never shown. (With money on, the viewer's OWN "Put money on it" action is legitimately there.)
        await expect(main).not.toContainText(/\$\d|on the line|pending|\boffer\b|real money/i);
        if (!enabled) await expect(main).not.toContainText(/put money/i);
        await page.goto("/profile");
        await expect(page.getByRole("main")).not.toContainText(/\$\d/);
        await page.goto("/notifications");
        await expect(page.getByRole("main")).not.toContainText(/\$\d|offer/i);
        if (!enabled) await expect(walletLink(page)).toHaveCount(0);
      }
    } finally {
      await setMoney(false);
      await cleanup(fixtureId, marketId, [a.id, b.id, c.id]);
    }
  });
});
