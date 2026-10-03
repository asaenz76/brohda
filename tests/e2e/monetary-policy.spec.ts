/**
 * E2E coverage for the monetary policy controls: configurable stake limits
 * (shown before sending, enforced on send) and one active Position per exact
 * pair per Market. Picks, funding and committed Positions are seeded through
 * the app's own RPCs; the stake flow itself is driven through the UI. No real
 * money — local-only wallet fixtures, small amounts.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createPlayer(email: string, usernamePrefix: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id, display_name: email.split("@")[0], username: `${usernamePrefix}${Date.now()}${Math.floor(Math.random() * 1000)}`, role: "player", is_active: true,
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
    .insert({ external_fixture_id: `e2e-monpol-${randomUUID()}`, home_team_name: "Home Test FC", away_team_name: "Away Test FC", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (fixtureErr || !fixture) throw fixtureErr ?? new Error("failed to create fixture");
  const { data: market, error: marketErr } = await admin
    .from("markets")
    .insert({
      provider: "e2e_monpol", provider_market_id: `active_${randomUUID()}`, question: `E2E monetary policy: ${randomUUID()}`, status: "ACTIVE", fixture_id: fixture.id,
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

async function fund(userId: string, cents: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: userId, p_type: "manual_deposit", p_direction: "credit", p_amount: cents, p_admin_id: null, p_reason: "e2e funding", p_idempotency_key: randomUUID() });
  if (error) throw error;
}

async function commitVia(proposerId: string, recipientId: string, recipientPickId: string, stake: number) {
  const { data: proposal, error } = await admin.rpc("propose_money", { p_proposer_user_id: proposerId, p_recipient_prediction_id: recipientPickId, p_stake: stake, p_idempotency_key: randomUUID(), p_source_challenge_id: null }).single();
  if (error) throw error;
  const { error: acceptError } = await admin.rpc("accept_monetary_proposal", { p_proposal_id: (proposal as { id: string }).id, p_recipient_user_id: recipientId }).single();
  if (acceptError) throw acceptError;
}

async function cleanup(fixtureId: string, marketId: string, postId: string, userIds: string[]) {
  // Proposals and Positions reference each other, so they are removed together in one transaction (local DB only).
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("delete from notifications where monetary_proposal_id in (select id from monetary_proposals where market_id = $1)", [marketId]);
    await client.query("delete from monetary_positions where market_id = $1", [marketId]);
    await client.query("delete from monetary_proposals where market_id = $1", [marketId]);
    await client.query("commit");
  } finally {
    await client.end();
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

async function openComposer(row: Locator) {
  await row.getByRole("button", { name: "Put money on it" }).click();
  return row.getByLabel(/amount to put on it/i);
}

test.describe.configure({ mode: "default" });

test.describe("Monetary stake limits", () => {
  test("limits are shown before sending and enforced: below the minimum, above the maximum, then a valid stake", async ({ page }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000 }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-monpol-a-${suffix}@test.local`;
    const emailB = `e2e-monpol-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emailA, "e2emonpola");
      const b = await createPlayer(emailB, "e2emonpolb");
      userIds.push(a, b);
      await pickVia(a, marketId, "YES");
      await pickVia(b, marketId, "NO");
      await fund(a, 50000); // $500 — more than the $100 maximum, so the configured maximum is the binding limit

      await loginAs(page, emailA);
      await page.goto(`/post/${postId}`);
      const bRow = rowFor(page, "e2e-monpol-b");
      const input = await openComposer(bRow);

      // The limits and the effective ceiling are visible before anything is typed.
      await expect(bRow.getByText(/Between \$1\.00 and \$100\.00/)).toBeVisible();
      await expect(bRow.getByText(/the most you can put on it is \$100\.00/)).toBeVisible();

      // A. Below the minimum — readable currency, tied to the field, Send disabled.
      await input.fill("0.50");
      await expect(bRow.getByRole("alert")).toHaveText("The minimum is $1.00.");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(input).toHaveAccessibleDescription(/The minimum is \$1\.00\./);
      await expect(bRow.getByRole("button", { name: "Send" })).toBeDisabled();

      // B. Above the maximum, even though the balance would cover it.
      await input.fill("150");
      await expect(bRow.getByRole("alert")).toHaveText("The maximum is $100.00.");
      await expect(bRow.getByRole("button", { name: "Send" })).toBeDisabled();
      const { data: none } = await admin.from("monetary_proposals").select("id").eq("market_id", marketId);
      expect(none ?? []).toHaveLength(0);

      // C. A valid stake (exactly the minimum) sends and is held.
      await input.fill("1");
      await expect(bRow.getByRole("alert")).toHaveCount(0);
      await bRow.getByRole("button", { name: "Send $1.00" }).click();
      await expect(bRow.getByText(/\$1\.00 pending — held until/)).toBeVisible();
      const { data: sent } = await admin.from("monetary_proposals").select("stake, status").eq("market_id", marketId);
      expect(sent).toEqual([{ stake: 100, status: "PENDING" }]);
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });

  test("a changed configuration is reflected in the consumer flow, and when the balance is lower than the maximum the ceiling says so", async ({ page }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, monetary_p2p_min_stake_cents: 500, monetary_p2p_max_stake_cents: 2000 }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-monpol-cfg-a-${suffix}@test.local`;
    const emailB = `e2e-monpol-cfg-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emailA, "e2emonpolcfga");
      const b = await createPlayer(emailB, "e2emonpolcfgb");
      userIds.push(a, b);
      await pickVia(a, marketId, "YES");
      await pickVia(b, marketId, "NO");
      await fund(a, 1200); // $12 available: below the $20 maximum

      await loginAs(page, emailA);
      await page.goto(`/post/${postId}`);
      const bRow = rowFor(page, "e2e-monpol-cfg-b");
      const input = await openComposer(bRow);

      await expect(bRow.getByText(/Between \$5\.00 and \$20\.00/)).toBeVisible();
      await expect(bRow.getByText(/the most you can put on it is \$12\.00/)).toBeVisible(); // min(max, available)
      await input.fill("15");
      await expect(bRow.getByRole("alert")).toHaveText("That's more than the $12.00 you have available.");
      await input.fill("3");
      await expect(bRow.getByRole("alert")).toHaveText("The minimum is $5.00.");
    } finally {
      await admin.from("platform_settings").update({ monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000 }).eq("id", true);
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });
});

test.describe("One active Position per exact pair per Market", () => {
  test("an existing Position blocks a second same-pair action from either side, while another counterparty stays available", async ({ page }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000 }).eq("id", true);
    const suffix = randomUUID();
    const emails = { a: `e2e-monpair-a-${suffix}@test.local`, b: `e2e-monpair-b-${suffix}@test.local`, c: `e2e-monpair-c-${suffix}@test.local` };
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emails.a, "e2emonpaira");
      const b = await createPlayer(emails.b, "e2emonpairb");
      const c = await createPlayer(emails.c, "e2emonpairc");
      userIds.push(a, b, c);
      await pickVia(a, marketId, "YES");
      const bPick = await pickVia(b, marketId, "NO");
      await pickVia(c, marketId, "NO");
      await fund(a, 20000);
      await fund(b, 20000);
      await fund(c, 20000);
      await commitVia(a, b, bPick, 1000);

      // A: the committed pair shows its state and offers no fresh action; the other counterparty is still open.
      await loginAs(page, emails.a);
      await page.goto(`/post/${postId}`);
      const bRow = rowFor(page, "e2e-monpair-b");
      await expect(bRow.getByText("$10.00 on the line")).toBeVisible();
      await expect(bRow.getByRole("button", { name: "Put money on it" })).toHaveCount(0);
      const cRow = rowFor(page, "e2e-monpair-c");
      await expect(cRow.getByRole("button", { name: "Put money on it" })).toBeVisible();

      // …and A can actually put money on C, on the same Market, alongside the first Position.
      const input = await openComposer(cRow);
      await input.fill("5");
      await cRow.getByRole("button", { name: "Send $5.00" }).click();
      await expect(cRow.getByText(/\$5\.00 pending — held until/)).toBeVisible();

      // B (the reverse direction) sees the same committed state and no fresh action against A.
      await loginAs(page, emails.b);
      await page.goto(`/post/${postId}`);
      const aRow = rowFor(page, "e2e-monpair-a");
      await expect(aRow.getByText("$10.00 on the line")).toBeVisible();
      await expect(aRow.getByRole("button", { name: "Put money on it" })).toHaveCount(0);

      // The server refuses it too, regardless of the UI.
      const { error } = await admin.rpc("propose_money", { p_proposer_user_id: b, p_recipient_prediction_id: (await admin.from("predictions").select("id").eq("market_id", marketId).eq("user_id", a).single()).data!.id, p_stake: 500, p_idempotency_key: randomUUID(), p_source_challenge_id: null }).single();
      expect(error?.message).toBe("pair_already_has_position");
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });
});
