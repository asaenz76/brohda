/**
 * E2E coverage for the Call BS final-hardening pass: live sibling refresh on
 * the canonical Post page, no stale Accept/Decline past cutoff, money and
 * Call BS coexisting on one row, and the 375px layout. Picks, challenges and
 * money are seeded through the same RPCs the app itself uses (service role),
 * so each test only drives the UI it is actually about — and needs one or
 * two logins instead of a dozen.
 *
 * call_bs_enabled is set once per run by tests/e2e/helpers/global-setup.ts.
 * monetary_p2p_enabled is turned on here exactly as the other monetary specs
 * do. No real money — local-only wallet fixtures.
 */
import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const STAKE = 1000;

async function createPlayer(email: string, usernamePrefix: string, displayName?: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: displayName ?? email.split("@")[0],
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

async function seedMarket({ startsInMs = 86_400_000, homeTeam = "Home Test FC", awayTeam = "Away Test FC" } = {}) {
  const { data: fixture, error: fixtureErr } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-hardening-${randomUUID()}`,
      home_team_name: homeTeam,
      away_team_name: awayTeam,
      scheduled_start_utc: new Date(Date.now() + startsInMs).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (fixtureErr || !fixture) throw fixtureErr ?? new Error("failed to create fixture");

  const { data: market, error: marketErr } = await admin
    .from("markets")
    .insert({
      provider: "e2e_hardening",
      provider_market_id: `active_${randomUUID()}`,
      question: `E2E hardening test: ${randomUUID()}`,
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

  // The canonical social surface for a Game is its published Post.
  const { data: post, error: postErr } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postErr || !post) throw postErr ?? new Error("failed to create post");

  return { fixtureId: fixture.id as string, marketId: market.id as string, postId: post.id as string };
}

async function pickVia(userId: string, marketId: string, selectedOutcome: "YES" | "NO") {
  const { data, error } = await admin
    .rpc("set_pick", {
      p_user_id: userId,
      p_market_id: marketId,
      p_selected_outcome: selectedOutcome,
      p_yes_probability: 0.6,
      p_no_probability: 0.4,
      p_market_question: "q",
      p_market_close_at: null,
      p_market_status: "ACTIVE",
      p_idempotency_key: randomUUID(),
    })
    .single();
  if (error) throw error;
  const row = data as { prediction: { id: string } | null; outcome: string };
  if (!row.prediction) throw new Error(`pick failed: ${row.outcome}`);
  return row.prediction.id;
}

async function callBsVia(challengerId: string, recipientPickId: string) {
  const { data, error } = await admin.rpc("call_bs", { p_challenger_user_id: challengerId, p_recipient_prediction_id: recipientPickId }).single();
  if (error) throw error;
  return (data as { id: string }).id;
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

async function commitMoneyVia(proposerId: string, recipientId: string, recipientPickId: string) {
  const { data: proposal, error } = await admin
    .rpc("propose_money", {
      p_proposer_user_id: proposerId,
      p_recipient_prediction_id: recipientPickId,
      p_stake: STAKE,
      p_idempotency_key: randomUUID(),
      p_source_challenge_id: null,
    })
    .single();
  if (error) throw error;
  const { error: acceptError } = await admin.rpc("accept_monetary_proposal", { p_proposal_id: (proposal as { id: string }).id, p_recipient_user_id: recipientId }).single();
  if (acceptError) throw acceptError;
}

async function cleanup(fixtureId: string, marketId: string, postId: string, userIds: string[]) {
  const { data: positions } = await admin.from("monetary_positions").select("id").eq("market_id", marketId);
  const positionIds = (positions ?? []).map((r) => r.id);
  const { data: proposals } = await admin.from("monetary_proposals").select("id").eq("market_id", marketId);
  const proposalIds = (proposals ?? []).map((r) => r.id);
  if (proposalIds.length > 0) {
    await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
    if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
    await admin.from("monetary_proposals").delete().in("id", proposalIds);
  }
  const { data: challenges } = await admin.from("challenges").select("id").eq("market_id", marketId);
  const challengeIds = (challenges ?? []).map((r) => r.id);
  if (challengeIds.length > 0) {
    await admin.from("notifications").delete().in("challenge_id", challengeIds);
    await admin.from("challenges").delete().in("id", challengeIds);
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

test.describe("Call BS final hardening", () => {
  test("accepting one Call BS on the Post expires its siblings live — no reload — and Accept/Decline vanish with them", async ({ page }) => {
    test.slow();
    const suffix = randomUUID();
    const emails = {
      andre: `e2e-live-andre-${suffix}@test.local`,
      carlos: `e2e-live-carlos-${suffix}@test.local`,
      marco: `e2e-live-marco-${suffix}@test.local`,
      priya: `e2e-live-priya-${suffix}@test.local`,
    };
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const andre = await createPlayer(emails.andre, "e2eliveandre");
      const carlos = await createPlayer(emails.carlos, "e2elivecarlos");
      const marco = await createPlayer(emails.marco, "e2elivemarco");
      const priya = await createPlayer(emails.priya, "e2elivepriya");
      userIds.push(andre, carlos, marco, priya);

      const andrePick = await pickVia(andre, marketId, "YES");
      await pickVia(carlos, marketId, "NO");
      await pickVia(marco, marketId, "NO");
      await pickVia(priya, marketId, "NO");
      await callBsVia(carlos, andrePick);
      await callBsVia(marco, andrePick);

      await loginAs(page, emails.andre);
      await page.goto(`/post/${postId}`);
      const carlosRow = rowFor(page, "e2e-live-carlos");
      const marcoRow = rowFor(page, "e2e-live-marco");
      const priyaRow = rowFor(page, "e2e-live-priya");
      await expect(carlosRow.getByRole("button", { name: "Accept" })).toBeVisible();
      await expect(marcoRow.getByRole("button", { name: "Accept" })).toBeVisible();
      await expect(priyaRow.getByRole("button", { name: "Call BS" })).toBeVisible();

      await carlosRow.getByRole("button", { name: "Accept" }).click();
      await expect(carlosRow.getByText("Accepted")).toBeVisible();

      // No page.reload(): the displaced sibling and the now-ineligible row
      // must update on their own, because the action revalidates the Post.
      await expect(marcoRow.getByText("No longer available")).toBeVisible();
      await expect(marcoRow.getByRole("button", { name: "Accept" })).toHaveCount(0);
      await expect(marcoRow.getByRole("button", { name: "Decline" })).toHaveCount(0);
      await expect(marcoRow.getByText("Declined")).toHaveCount(0);
      await expect(priyaRow.getByRole("button", { name: "Call BS" })).toHaveCount(0);

      const { data: marcoChallenge } = await admin.from("challenges").select("status").eq("market_id", marketId).eq("challenger_user_id", marco).single();
      expect(marcoChallenge?.status).toBe("EXPIRED");
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });

  test("a PENDING Call BS whose cutoff has passed shows no Accept/Decline to the recipient and no eternal Pending to the sender", async ({ page }) => {
    test.slow();
    const suffix = randomUUID();
    const emailA = `e2e-cutoff-a-${suffix}@test.local`;
    const emailB = `e2e-cutoff-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emailA, "e2ecutoffa");
      const b = await createPlayer(emailB, "e2ecutoffb");
      userIds.push(a, b);
      const aPick = await pickVia(a, marketId, "YES");
      await pickVia(b, marketId, "NO");
      await callBsVia(b, aPick);

      // Before cutoff the recipient is offered Accept/Decline.
      await loginAs(page, emailA);
      await page.goto(`/post/${postId}`);
      await expect(rowFor(page, "e2e-cutoff-b").getByRole("button", { name: "Accept" })).toBeVisible();

      // Kickoff moves inside the cutoff window. Nothing sweeps the PENDING
      // row — it is still PENDING in the database.
      await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", fixtureId);
      const { data: stillPending } = await admin.from("challenges").select("status").eq("market_id", marketId).single();
      expect(stillPending?.status).toBe("PENDING");

      await page.reload();
      const bRow = rowFor(page, "e2e-cutoff-b");
      await expect(bRow.getByText("No longer available")).toBeVisible();
      await expect(bRow.getByRole("button", { name: "Accept" })).toHaveCount(0);
      await expect(bRow.getByRole("button", { name: "Decline" })).toHaveCount(0);

      // The sender sees the same, not a Pending that can never resolve.
      await loginAs(page, emailB);
      await page.goto(`/post/${postId}`);
      const aRow = rowFor(page, "e2e-cutoff-a");
      await expect(aRow.getByText("No longer available")).toBeVisible();
      await expect(aRow.getByText("Pending")).toHaveCount(0);
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });

  test("money first: a money-locked pair is still offered a free Call BS, and accepting it leaves the money Position untouched on the same row", async ({ page }) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-money-a-${suffix}@test.local`;
    const emailB = `e2e-money-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const a = await createPlayer(emailA, "e2emoneya");
      const b = await createPlayer(emailB, "e2emoneyb");
      userIds.push(a, b);
      const aPick = await pickVia(a, marketId, "YES");
      const bPick = await pickVia(b, marketId, "NO");
      await fund(a, STAKE);
      await fund(b, STAKE);
      await commitMoneyVia(a, b, bPick);

      const { data: locked } = await admin.from("predictions").select("lock_reason").in("id", [aPick, bPick]);
      expect((locked ?? []).map((p) => p.lock_reason)).toEqual(["MONETARY_POSITION_ACCEPTED", "MONETARY_POSITION_ACCEPTED"]);

      // B (monetary-locked viewer, monetary-locked target) still sees Call BS next to the money state.
      await loginAs(page, emailB);
      await page.goto(`/post/${postId}`);
      const aRow = rowFor(page, "e2e-money-a");
      await expect(aRow.getByText("$10.00 on the line")).toBeVisible();
      await expect(aRow.getByRole("button", { name: "Call BS" })).toBeVisible();
      await aRow.getByRole("button", { name: "Call BS" }).click();
      await expect(aRow.getByText("Pending")).toBeVisible();

      // A accepts it — the free layer works on a money-locked Pick.
      await loginAs(page, emailA);
      await page.goto(`/post/${postId}`);
      const bRow = rowFor(page, "e2e-money-b");
      await expect(bRow.getByRole("button", { name: "Accept" })).toBeVisible();
      await bRow.getByRole("button", { name: "Accept" }).click();
      await expect(bRow.getByText("Accepted")).toBeVisible();
      await expect(bRow.getByText("$10.00 on the line")).toBeVisible();

      const { data: challenge } = await admin.from("challenges").select("status").eq("market_id", marketId).single();
      expect(challenge?.status).toBe("ACCEPTED");
      const { data: after } = await admin.from("predictions").select("lock_reason").in("id", [aPick, bPick]);
      expect((after ?? []).map((p) => p.lock_reason)).toEqual(["MONETARY_POSITION_ACCEPTED", "MONETARY_POSITION_ACCEPTED"]);
      const { data: position } = await admin.from("monetary_positions").select("settlement_status").eq("market_id", marketId).single();
      expect(position?.settlement_status).toBe("COMMITTED");
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });
});

test.describe("Call BS missing-state hints", () => {
  async function acceptVia(challengeId: string, recipientId: string) {
    const { error } = await admin.rpc("accept_call_bs", { p_challenge_id: challengeId, p_recipient_user_id: recipientId }).single();
    if (error) throw error;
  }

  test("explains why there is no Call BS: a paired target, a paired viewer, and a viewer who has not picked", async ({ page }) => {
    test.slow();
    const suffix = randomUUID();
    const emails = {
      paira: `e2e-hint-paira-${suffix}@test.local`,
      pairb: `e2e-hint-pairb-${suffix}@test.local`,
      viewer: `e2e-hint-viewer-${suffix}@test.local`,
      lurker: `e2e-hint-lurker-${suffix}@test.local`,
    };
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket();

    try {
      const pairA = await createPlayer(emails.paira, "e2ehintpa");
      const pairB = await createPlayer(emails.pairb, "e2ehintpb");
      const viewer = await createPlayer(emails.viewer, "e2ehintv");
      const lurker = await createPlayer(emails.lurker, "e2ehintl");
      userIds.push(pairA, pairB, viewer, lurker);

      await pickVia(pairA, marketId, "YES");
      const pairBPick = await pickVia(pairB, marketId, "NO");
      await pickVia(viewer, marketId, "NO");
      await acceptVia(await callBsVia(pairA, pairBPick), pairB);

      // A viewer who opposes a paired participant is told why there is no button.
      await loginAs(page, emails.viewer);
      await page.goto(`/post/${postId}`);
      const pairARow = rowFor(page, "e2e-hint-paira");
      await expect(pairARow.getByText("In a Call BS")).toBeVisible();
      await expect(pairARow.getByRole("button", { name: "Call BS" })).toHaveCount(0);
      // Same-side participants are never labelled — it would be noise.
      await expect(rowFor(page, "e2e-hint-pairb").getByText("In a Call BS")).toHaveCount(0);

      // A paired viewer is told they cannot call BS on anyone else; their partner's row reads Accepted.
      await loginAs(page, emails.paira);
      await page.goto(`/post/${postId}`);
      await expect(rowFor(page, "e2e-hint-pairb").getByText("Accepted")).toBeVisible();
      await expect(page.getByText("You're already in a Call BS on this game")).toBeVisible();

      // Someone who hasn't picked sees a hint, and nobody's name or pick.
      await loginAs(page, emails.lurker);
      await page.goto(`/post/${postId}`);
      await expect(page.getByText("Make a pick to call BS on anyone who picked the other side.")).toBeVisible();
      await expect(page.getByText("Other picks")).toHaveCount(0);
      await expect(page.getByText("e2e-hint-paira")).toHaveCount(0);
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });
});

test.describe("Call BS at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  async function expectNoHorizontalOverflow(page: Page, label: string) {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(scrollWidth, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(innerWidth);
  }

  async function expectInsideViewport(locator: Locator, label: string) {
    const box = await locator.boundingBox();
    expect(box, `${label}: not rendered`).not.toBeNull();
    expect(box!.x, `${label}: clipped on the left`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${label}: clipped on the right`).toBeLessThanOrEqual(375 + 0.5);
  }

  async function expectNoOverlap(a: Locator, b: Locator, label: string) {
    const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()];
    expect(boxA && boxB, `${label}: both must be rendered`).toBeTruthy();
    const overlaps = boxA!.x < boxB!.x + boxB!.width && boxB!.x < boxA!.x + boxA!.width && boxA!.y < boxB!.y + boxB!.height && boxB!.y < boxA!.y + boxA!.height;
    expect(overlaps, `${label}: elements overlap`).toBe(false);
  }

  async function shot(page: Page, testInfo: TestInfo, name: string) {
    await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }

  test("every state fits: long names and labels, Call BS beside Put money on it, Accept/Decline with the lock warning, Accepted, No longer available", async ({ page }, testInfo) => {
    test.slow();
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const longName = "Bartholomew-Maximilian-Featherstonehaugh-Wolfeschlegelstein";
    const emails = {
      viewer: `e2e-m375-viewer-${suffix}@test.local`,
      longname: `e2e-m375-long-${suffix}@test.local`,
      incoming: `e2e-m375-incoming-${suffix}@test.local`,
      gone: `e2e-m375-gone-${suffix}@test.local`,
      accepter: `e2e-m375-accepter-${suffix}@test.local`,
    };
    const userIds: string[] = [];
    const { fixtureId, marketId, postId } = await seedMarket({
      homeTeam: "The Extraordinarily Long Named Football Club of Greater Metropolis United",
      awayTeam: "Another Remarkably Lengthy Athletic Association of the Northern Territories",
    });

    try {
      const viewer = await createPlayer(emails.viewer, "m375viewer");
      const longUser = await createPlayer(emails.longname, "m375long", longName);
      const incoming = await createPlayer(emails.incoming, "m375incoming");
      const gone = await createPlayer(emails.gone, "m375gone");
      const accepter = await createPlayer(emails.accepter, "m375accepter");
      userIds.push(viewer, longUser, incoming, gone, accepter);

      const viewerPick = await pickVia(viewer, marketId, "YES");
      await pickVia(longUser, marketId, "NO");
      await pickVia(incoming, marketId, "NO");
      await pickVia(gone, marketId, "NO");
      await pickVia(accepter, marketId, "NO");

      await callBsVia(incoming, viewerPick); // incoming PENDING → Accept / Decline
      const goneChallenge = await callBsVia(gone, viewerPick);
      await admin.from("challenges").update({ status: "EXPIRED" }).eq("id", goneChallenge); // → No longer available

      await loginAs(page, emails.viewer);
      await page.goto(`/post/${postId}`);

      const longRow = rowFor(page, "Bartholomew");
      const incomingRow = rowFor(page, "e2e-m375-incoming");
      const goneRow = rowFor(page, "e2e-m375-gone");

      // Eligible row: Call BS and Put money on it, both on screen and not on top of each other.
      const callBs = longRow.getByRole("button", { name: "Call BS" });
      const putMoney = longRow.getByRole("button", { name: /put money on it/i });
      await expect(callBs).toBeVisible();
      await expect(putMoney).toBeVisible();
      await expectInsideViewport(callBs, "Call BS");
      await expectInsideViewport(putMoney, "Put money on it");
      await expectNoOverlap(callBs, putMoney, "Call BS vs Put money on it");

      // The long display name shrinks (truncates) inside the row instead of pushing anything out.
      // The row has two links to the profile (avatar + name); the name is the truncating one.
      const nameLink = longRow.locator("a.truncate");
      await expectInsideViewport(nameLink, "long display name");
      expect(await nameLink.evaluate((el) => el.scrollWidth > el.clientWidth), "the long name should truncate, not overflow").toBe(true);

      // The long outcome label wraps rather than escaping the row.
      await expectInsideViewport(longRow.getByText(/^Picked /), "long outcome label");

      // Incoming Call BS: Accept/Decline are touch-sized, on screen, and the lock warning is readable.
      const accept = incomingRow.getByRole("button", { name: "Accept" });
      const decline = incomingRow.getByRole("button", { name: "Decline" });
      await expect(accept).toBeVisible();
      await expectInsideViewport(accept, "Accept");
      await expectInsideViewport(decline, "Decline");
      await expectNoOverlap(accept, decline, "Accept vs Decline");
      expect((await accept.boundingBox())!.height, "Accept touch target").toBeGreaterThanOrEqual(36);
      const warning = incomingRow.getByText("Accepting locks both predictions for this game.");
      await expect(warning).toBeVisible();
      await expectInsideViewport(warning, "lock warning");
      expect(await warning.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), "lock warning font size").toBeGreaterThanOrEqual(12);

      // Displaced state reads as plain text.
      await expect(goneRow.getByText("No longer available")).toBeVisible();
      await expectInsideViewport(goneRow.getByText("No longer available"), "No longer available");

      await expectNoHorizontalOverflow(page, "states before accepting");
      await shot(page, testInfo, "375-before-accept");

      // Accept the incoming one: Accepted is readable, the siblings update live.
      await accept.click();
      await expect(incomingRow.getByText("Accepted")).toBeVisible();
      await expectInsideViewport(incomingRow.getByText("Accepted"), "Accepted");
      await expect(longRow.getByRole("button", { name: "Call BS" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "states after accepting");
      await shot(page, testInfo, "375-after-accept");
    } finally {
      await cleanup(fixtureId, marketId, postId, userIds);
    }
  });
});
