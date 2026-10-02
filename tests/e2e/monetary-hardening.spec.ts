/**
 * E2E coverage for the monetary P2P hardening: the sender is told the stake
 * is held before sending, the recipient must explicitly confirm real money,
 * an unanswered proposal expires through the real cron route (releasing the
 * hold and telling the proposer), a decline releases the hold, and the whole
 * flow fits at 375px. Picks and funding are seeded through the app's own
 * RPCs; the money controls themselves are driven through the UI. No real
 * money — local-only wallet fixtures.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
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
    .insert({ external_fixture_id: `e2e-monhard-${randomUUID()}`, home_team_name: "Home Test FC", away_team_name: "Away Test FC", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (fixtureErr || !fixture) throw fixtureErr ?? new Error("failed to create fixture");
  const { data: market, error: marketErr } = await admin
    .from("markets")
    .insert({
      provider: "e2e_monhard", provider_market_id: `active_${randomUUID()}`, question: `E2E monetary hardening: ${randomUUID()}`, status: "ACTIVE", fixture_id: fixture.id,
      market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketErr || !market) throw marketErr ?? new Error("failed to create market");
  const { data: post, error: postErr } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postErr || !post) throw postErr ?? new Error("failed to create post");
  return { fixtureId: fixture.id as string, marketId: market.id as string, postId: post.id as string };
}

async function pickVia(userId: string, marketId: string, selectedOutcome: "YES" | "NO") {
  const { data, error } = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: selectedOutcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  if (error) throw error;
  const row = data as { prediction: { id: string } | null; outcome: string };
  if (!row.prediction) throw new Error(`pick failed: ${row.outcome}`);
  return row.prediction.id;
}

async function fund(userId: string, amountCents: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: userId, p_type: "manual_deposit", p_direction: "credit", p_amount: amountCents, p_admin_id: null, p_reason: "e2e funding", p_idempotency_key: randomUUID() });
  if (error) throw error;
}

async function proposeVia(proposerId: string, recipientPickId: string, stake: number) {
  const { data, error } = await admin.rpc("propose_money", { p_proposer_user_id: proposerId, p_recipient_prediction_id: recipientPickId, p_stake: stake, p_idempotency_key: randomUUID(), p_source_challenge_id: null }).single();
  if (error) throw error;
  return data as { id: string; proposer_reservation_id: string };
}

async function reserved(userId: string): Promise<number> {
  const { data } = await admin.from("wallet_balances").select("reserved_balance").eq("user_id", userId).eq("account_type", "user").single();
  return data!.reserved_balance as number;
}

async function cleanup(fixtureId: string, marketId: string, postId: string, userIds: string[]) {
  const { data: positions } = await admin.from("monetary_positions").select("id").eq("market_id", marketId);
  const positionIds = (positions ?? []).map((r) => r.id);
  const { data: proposals } = await admin.from("monetary_proposals").select("id").eq("market_id", marketId);
  const proposalIds = (proposals ?? []).map((r) => r.id);
  if (proposalIds.length > 0) {
    await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
    // positions and proposals reference each other; positions first, with the back-reference nulled by deleting both sides.
    if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
    await admin.from("monetary_proposals").delete().in("id", proposalIds);
  }
  await admin.from("notifications").delete().eq("post_id", postId);
  await admin.from("posts").delete().eq("id", postId);
  await admin.from("predictions").delete().eq("market_id", marketId);
  await admin.from("markets").delete().eq("id", marketId);
  await admin.from("fixtures").delete().eq("id", fixtureId);
  await admin.from("wallet_reservations").delete().in("user_id", userIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}

const rowFor = (page: Page, name: string): Locator => page.locator("li", { hasText: name });

test.describe("Monetary P2P hardening", () => {
  test("the sender is told the stake is held; the recipient must explicitly confirm real money", async ({ page }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, p2p_fee_bps: 100 }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-monhard-a-${suffix}@test.local`;
    const emailB = `e2e-monhard-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emailA, "e2emonharda");
      const b = await createPlayer(emailB, "e2emonhardb");
      userIds.push(a, b);
      await pickVia(a, marketId, "YES");
      await pickVia(b, marketId, "NO");
      await fund(a, 5000);
      await fund(b, 5000);

      // The sender is told, before sending, that the amount is held.
      await loginAs(page, emailA);
      await page.goto(`/post/${postId}`);
      const bRow = rowFor(page, "e2e-monhard-b");
      await bRow.getByRole("button", { name: "Put money on it" }).click();
      await expect(bRow.getByLabel(/amount to put on it/i)).toBeVisible();
      await expect(bRow.getByText(/Sending holds this amount from your balance/)).toBeVisible();
      await expect(bRow.getByText(/You have \$50\.00 available/)).toBeVisible();
      await bRow.getByLabel(/amount to put on it/i).fill("10");
      await bRow.getByRole("button", { name: "Send $10.00" }).click();
      await expect(bRow.getByText(/\$10\.00 pending — held until/)).toBeVisible();
      expect(await reserved(a)).toBe(1000); // the hold is real and immediate

      // The recipient sees the stake in words, and Accept does NOT commit on its own.
      await loginAs(page, emailB);
      await page.goto(`/post/${postId}`);
      const aRow = rowFor(page, "e2e-monhard-a");
      await expect(aRow.getByText(/put \$10\.00 on it/)).toBeVisible();
      await aRow.getByRole("button", { name: "Accept" }).click();
      const confirm = aRow.getByRole("group", { name: /Confirm \$10\.00 against/ });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText("This is real money");
      await expect(confirm).toContainText("If you win, you get $10.00");
      await expect(confirm).toContainText("minus a 1% fee");
      await expect(confirm).toContainText("If you lose, you pay $10.00");
      expect(await reserved(b)).toBe(0); // nothing committed yet
      const { data: before } = await admin.from("monetary_positions").select("id").eq("market_id", marketId);
      expect(before ?? []).toHaveLength(0);

      // Back changes nothing; Confirm commits.
      await confirm.getByRole("button", { name: "Back" }).click();
      await expect(aRow.getByRole("button", { name: "Accept" })).toBeVisible();
      await aRow.getByRole("button", { name: "Accept" }).click();
      await aRow.getByRole("button", { name: /^Confirm/ }).click();
      await expect(aRow.getByText("$10.00 on the line")).toBeVisible();
      expect(await reserved(b)).toBe(1000);
      const { data: after } = await admin.from("monetary_positions").select("settlement_status, fee_bps").eq("market_id", marketId);
      expect(after).toEqual([{ settlement_status: "COMMITTED", fee_bps: 100 }]);
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });

  test("an unanswered proposal expires through the real cron route: the hold is released and the proposer is told", async ({ page, request }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-monexp-a-${suffix}@test.local`;
    const emailB = `e2e-monexp-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emailA, "e2emonexpa");
      const b = await createPlayer(emailB, "e2emonexpb");
      userIds.push(a, b);
      await pickVia(a, marketId, "YES");
      const bPick = await pickVia(b, marketId, "NO");
      await fund(a, 5000);
      await fund(b, 5000);
      const proposal = await proposeVia(a, bPick, 1000);
      expect(await reserved(a)).toBe(1000);

      // Kickoff moves inside the cutoff; nothing has swept yet, so the row is still PENDING with funds held.
      await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 3 * 60_000).toISOString() }).eq("id", fixtureId);

      // Even before the sweep, the recipient is not offered an Accept the server would refuse.
      await loginAs(page, emailB);
      await page.goto(`/post/${postId}`);
      const aRow = rowFor(page, "e2e-monexp-a");
      await expect(aRow.getByText(/proposal expired/)).toBeVisible();
      await expect(aRow.getByRole("button", { name: "Accept" })).toHaveCount(0);

      // The scheduled job's own route runs the sweep.
      const response = await request.get("/api/cron/settle-monetary-positions", { headers: { authorization: "Bearer e2e-placeholder" } });
      expect(response.ok()).toBe(true);
      const summary = await response.json();
      expect(summary.expiredProposals).toBeGreaterThanOrEqual(1);

      const { data: row } = await admin.from("monetary_proposals").select("status").eq("id", proposal.id).single();
      expect(row?.status).toBe("EXPIRED");
      expect(await reserved(a)).toBe(0);

      // The proposer is told, in the notification center, that the hold was released.
      await loginAs(page, emailA);
      await page.goto("/notifications");
      await expect(page.getByText("Your proposal expired")).toBeVisible();
      await expect(page.getByText(/The hold on your \$10\.00 was released/)).toBeVisible();
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });

  test("declining releases the proposer's hold and reads as 'nothing was held' to the recipient", async ({ page }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-mondec-a-${suffix}@test.local`;
    const emailB = `e2e-mondec-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emailA, "e2emondeca");
      const b = await createPlayer(emailB, "e2emondecb");
      userIds.push(a, b);
      await pickVia(a, marketId, "YES");
      const bPick = await pickVia(b, marketId, "NO");
      await fund(a, 5000);
      await fund(b, 5000);
      const proposal = await proposeVia(a, bPick, 1000);
      expect(await reserved(a)).toBe(1000);

      await loginAs(page, emailB);
      await page.goto(`/post/${postId}`);
      const aRow = rowFor(page, "e2e-mondec-a");
      await aRow.getByRole("button", { name: "Decline" }).click();
      await expect(aRow.getByText("Declined — nothing was held")).toBeVisible();

      const { data: row } = await admin.from("monetary_proposals").select("status").eq("id", proposal.id).single();
      expect(row?.status).toBe("DECLINED");
      expect(await reserved(a)).toBe(0);
      const { data: positions } = await admin.from("monetary_positions").select("id").eq("market_id", marketId);
      expect(positions ?? []).toHaveLength(0);
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });
});

test.describe("Monetary P2P at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  async function expectInside(locator: Locator, label: string) {
    const box = await locator.boundingBox();
    expect(box, `${label}: not rendered`).not.toBeNull();
    expect(box!.x, `${label}: clipped left`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${label}: clipped right`).toBeLessThanOrEqual(375 + 0.5);
  }
  async function expectNoOverflow(page: Page, label: string) {
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(sw, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(iw);
  }

  test("composer, hold disclosure, unfunded recipient and the confirmation all fit without overflow", async ({ page }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, p2p_fee_bps: 100 }).eq("id", true);
    const suffix = randomUUID();
    const emails = { a: `e2e-mon375-a-${suffix}@test.local`, b: `e2e-mon375-b-${suffix}@test.local`, c: `e2e-mon375-c-${suffix}@test.local` };
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emails.a, "e2emon375a");
      const b = await createPlayer(emails.b, "e2emon375b");
      const c = await createPlayer(emails.c, "e2emon375c");
      userIds.push(a, b, c);
      await pickVia(a, marketId, "YES");
      const bPick = await pickVia(b, marketId, "NO");
      const cPick = await pickVia(c, marketId, "NO");
      await fund(a, 20000);
      await fund(b, 5000); // funded recipient
      // c stays unfunded
      await proposeVia(a, bPick, 1000);
      await proposeVia(a, cPick, 1000);

      // Sender: composer + hold disclosure.
      await loginAs(page, emails.a);
      await page.goto(`/post/${postId}`);
      // Both rows already hold a pending proposal from a; compose against a third party instead.
      const d = await createPlayer(`e2e-mon375-d-${suffix}@test.local`, "e2emon375d");
      userIds.push(d);
      await pickVia(d, marketId, "NO");
      await page.reload();
      const dRow = rowFor(page, "e2e-mon375-d");
      await dRow.getByRole("button", { name: "Put money on it" }).click();
      const help = dRow.getByText(/Sending holds this amount/);
      await expect(help).toBeVisible();
      await expectInside(help, "hold disclosure");
      await expectInside(dRow.getByLabel(/amount to put on it/i), "stake input");
      await dRow.getByLabel(/amount to put on it/i).fill("5");
      const send = dRow.getByRole("button", { name: "Send $5.00" });
      await expectInside(send, "Send");
      expect((await send.boundingBox())!.height, "Send touch target").toBeGreaterThanOrEqual(36);
      await expectNoOverflow(page, "sender composer");

      // Unfunded recipient: stake, balance, shortfall and the fund link, with no Accept.
      await loginAs(page, emails.c);
      await page.goto(`/post/${postId}`);
      const unfunded = rowFor(page, "e2e-mon375-a");
      await expect(unfunded.getByText(/not enough available balance/)).toBeVisible();
      await expectInside(unfunded.getByText(/not enough available balance/), "unfunded copy");
      await expectInside(unfunded.getByRole("link", { name: "Fund your wallet" }), "fund link");
      await expect(unfunded.getByRole("button", { name: "Accept" })).toHaveCount(0);
      await expectNoOverflow(page, "unfunded recipient");

      // Funded recipient: the confirmation panel fits and its buttons are touch-sized.
      await loginAs(page, emails.b);
      await page.goto(`/post/${postId}`);
      const funded = rowFor(page, "e2e-mon375-a");
      await funded.getByRole("button", { name: "Accept" }).click();
      const confirm = funded.getByRole("group", { name: /Confirm \$10\.00 against/ });
      await expect(confirm).toBeVisible();
      await expectInside(confirm, "confirmation panel");
      const confirmButton = confirm.getByRole("button", { name: /^Confirm/ });
      await expectInside(confirmButton, "Confirm button");
      expect((await confirmButton.boundingBox())!.height, "Confirm touch target").toBeGreaterThanOrEqual(36);
      await expectInside(confirm.getByRole("button", { name: "Back" }), "Back button");
      await expectNoOverflow(page, "confirmation");
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });
});
