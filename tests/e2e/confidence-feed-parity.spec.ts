/**
 * Confidence-backed Picks from the Home feed, with the same control and the same canonical state as the Post detail: a Pick on a feed card exposes "How confident are you?" inline (no navigation), an existing
 * unbacked Pick shows it on load, changing the side keeps a fresh selector, committing locks the card and shows the amount, the feed and the Post agree in both directions, insufficient balance disables only
 * the unaffordable amounts, and nothing is offered when the capability is off, the Game is inside its lock window, or for a Sponsor. Phone widths work. Local test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
test.describe.configure({ mode: "serial" });
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tag = randomUUID().slice(0, 6);
async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-fp-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${tag}`, username: `f${label}${tag}`.toLowerCase(), role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email };
}
async function createSponsorLogin() {
  const email = `e2e-fp-sponsor-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: org, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: `FP Co ${randomUUID().slice(0, 4)}`, p_contact_name: "E2E", p_website: null, p_country: null, p_phone: null });
  if (accountError) throw accountError;
  await admin.from("sponsors").update({ status: "ACTIVE", logo_path: `${randomUUID()}/logo.webp` }).eq("id", (Array.isArray(org) ? org[0] : org).id);
  return { email };
}
async function loginAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}
async function loginAsSponsor(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/sponsor/login");
  await page.getByLabel("Business email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/sponsor$/);
}

/** A published Game a few hours out (so it sorts at the top of the feed) with a Moneyline, uniquely named so its card can be found. */
async function seedGame(name: string, startsInMinutes = 180) {
  const home = `Fhome ${name} ${tag}`;
  const away = `Faway ${name} ${tag}`;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-fp-${randomUUID()}`, home_team_name: home, away_team_name: away, scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const { data: market, error: marketError } = await admin
    .from("markets")
    .insert({
      provider: `e2e_fp_${randomUUID()}`, provider_market_id: `m_${randomUUID()}`, question: "E2E feed pick", status: "ACTIVE", fixture_id: fixture.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.62, no_price: 0.38,
      price_outcome_labels: { yes: `${home} wins`, no: `${home} does not win` }, liquidity: 1000, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  return { home, away, fixtureId: fixture.id as string, marketId: market.id as string, postId: post.id as string };
}
/** A Pick made through the real set_pick path (what the Pick button does), for tests that start from an existing Pick. */
async function pickViaDb(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { data, error } = await admin.rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() });
  if (error) throw error;
  return data as Row;
}
const card = (page: Page, g: { home: string; away: string }) => page.locator("article", { hasText: g.home }).filter({ hasText: g.away });
const balance = (page: Page) => page.locator('[data-slot="shell-confidence"]:visible');
const stakeOf = async (memberId: string) => ((await admin.from("confidence_prediction_stakes").select("amount, state, prediction_id").eq("member_id", memberId)).data ?? []) as Row[];
async function gotoFeedReady(page: Page) {
  await page.goto("/feed");
  await page.waitForLoadState("networkidle"); // let the client components hydrate before pressing their buttons
}

let saved: Row | null = null;
let alice: { id: string; email: string };
let poor: { id: string; email: string };
let owner: { id: string; email: string };
test.beforeAll(async () => {
  const { data } = await admin.from("platform_settings").select("confidence_enabled, confidence_backed_picks_enabled, confidence_allowed_stakes, confidence_baseline, pick_lock_minutes_before_kickoff").eq("id", true).single();
  saved = data;
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10 }).eq("id", true);
  alice = await createMember("alice");
  poor = await createMember("poor");
  owner = await createMember("owner", "super_admin");
  for (const m of [alice, poor]) await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  await admin.rpc("admin_confidence_adjust", { p_admin_id: owner.id, p_member_id: poor.id, p_amount: -47, p_reason_code: "CORRECTION", p_note: "e2e setup", p_idempotency_key: randomUUID() }); // available 3
});
test.afterAll(async () => {
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});

test("A–E: a Pick made on the feed exposes Confidence inline, the side can change first, committing locks the card, and the feed and the Post agree both ways", async ({ page }) => {
  test.setTimeout(240_000);
  const g1 = await seedGame("one");
  const g2 = await seedGame("two");
  await loginAs(page, alice.email);
  await gotoFeedReady(page);

  // A. Make the ordinary Pick on the feed: the selector appears on the SAME card, with no navigation, and nothing is reserved yet.
  const c1 = card(page, g1);
  await c1.getByRole("button", { name: new RegExp(`Pick ${g1.home}`) }).click();
  await expect(c1.locator('[data-slot="confidence-backing"]')).toContainText("How confident are you?");
  await expect(c1.locator('[data-slot="confidence-backing"]')).toContainText("You have 🔥50 available");
  await expect(page).toHaveURL(/\/feed$/);
  expect(await stakeOf(alice.id)).toEqual([]);
  const picks = (await admin.from("predictions").select("selected_outcome").eq("user_id", alice.id).eq("market_id", g1.marketId)).data;
  expect(picks).toEqual([{ selected_outcome: "YES" }]);

  // C. Change the side before committing: the selector stays, and it is bound to the NEW side (no stale chosen amount).
  await c1.locator('[data-slot="confidence-choice"][data-amount="3"]').click();
  await expect(c1.locator('[data-slot="confidence-confirm"]')).toContainText(g1.home);
  await c1.getByRole("button", { name: new RegExp(`Pick ${g1.away}`) }).click();
  await expect(c1.locator('[data-slot="confidence-confirm"]')).toHaveCount(0); // the previous side's half-made choice is gone
  await expect(c1.locator('[data-slot="confidence-backing"]')).toBeVisible();
  await c1.locator('[data-slot="confidence-choice"][data-amount="1"]').click();
  await expect(c1.locator('[data-slot="confidence-confirm"]')).toContainText(g1.away);
  expect(await stakeOf(alice.id)).toEqual([]); // choosing is not attaching

  // D. Confirm: the card locks and shows the committed amount; the shell total is unchanged with the split in its label.
  await c1.locator('[data-slot="confidence-confirm-button"]').click();
  await expect(c1.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked");
  await expect(c1.locator('[data-slot="confidence-backing"]')).toHaveCount(0);
  await expect(c1.getByRole("button", { name: /^Pick / })).toHaveCount(0);
  await expect(c1).toContainText(`You picked ${g1.away}`);
  expect(await stakeOf(alice.id)).toMatchObject([{ amount: 1, state: "RESERVED" }]);
  const pick = (await admin.from("predictions").select("selected_outcome, lock_reason").eq("user_id", alice.id).eq("market_id", g1.marketId).single()).data!;
  expect(pick).toEqual({ selected_outcome: "NO", lock_reason: "CONFIDENCE_COMMITTED" });
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 50 total, 49 available, 1 reserved behind your picks/);

  // E1. Feed → Post: exactly the same state on the Post.
  await page.goto(`/post/${g1.postId}`);
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked");
  await expect(page.getByText(`You picked: ${g1.away}`)).toBeVisible();
  await expect(page.locator('[data-slot="confidence-backing"]')).toHaveCount(0);

  // E2. Post → feed: pick on the feed, commit on the Post, and the feed card shows the same committed state.
  await gotoFeedReady(page);
  const c2 = card(page, g2);
  await c2.getByRole("button", { name: new RegExp(`Pick ${g2.home}`) }).click();
  await expect(c2.locator('[data-slot="confidence-backing"]')).toBeVisible();
  await page.goto(`/post/${g2.postId}`);
  await page.waitForLoadState("networkidle");
  await page.locator('[data-slot="confidence-choice"][data-amount="2"]').click();
  await page.locator('[data-slot="confidence-confirm-button"]').click();
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
  await gotoFeedReady(page);
  await expect(card(page, g2).locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
  await expect(card(page, g2)).toContainText(`You picked ${g2.home}`);
  expect((await stakeOf(alice.id)).map((s) => s.amount).sort()).toEqual([1, 2]);
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 50 total, 47 available, 3 reserved behind your picks/);
});

test("B, I, H, G: an existing unbacked Pick shows the control on load; a Call BS-locked Pick still can; a Pick inside the lock window cannot; with the capability off nothing appears", async ({ page }) => {
  test.setTimeout(240_000);
  const existing = await seedGame("existing");
  const callbs = await seedGame("callbs");
  const late = await seedGame("late");
  await pickViaDb(alice.id, existing.marketId, "YES");
  const cb = await pickViaDb(alice.id, callbs.marketId, "NO");
  await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CHALLENGE_ACCEPTED" }).eq("user_id", alice.id).eq("market_id", callbs.marketId);
  void cb;
  await pickViaDb(alice.id, late.marketId, "YES");
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", late.fixtureId); // inside the 10-minute lock window
  await loginAs(page, alice.email);
  await gotoFeedReady(page);

  // B. Existing Pick: the selector is already there; the Member does not have to re-pick.
  await expect(card(page, existing).locator('[data-slot="confidence-backing"]')).toContainText("How confident are you?");
  // I. Call BS lock: the Pick cannot change, but Confidence is still offered (the canonical rule decides, not the lock).
  await expect(card(page, callbs)).toContainText("Picks are locked for this game");
  await expect(card(page, callbs).locator('[data-slot="confidence-backing"]')).toBeVisible();
  // H. Inside the lock window: no active selector.
  await expect(card(page, late).locator('[data-slot="confidence-backing"]')).toHaveCount(0);

  // G. Capability off: the feed falls back to ordinary Picks — no container, no stale flames.
  await admin.from("platform_settings").update({ confidence_backed_picks_enabled: false }).eq("id", true);
  await gotoFeedReady(page);
  await expect(card(page, existing)).toBeVisible();
  await expect(page.locator('[data-slot="confidence-backing"]')).toHaveCount(0);
  await expect(card(page, existing)).not.toContainText(/How confident|Confidence/);
  await admin.from("platform_settings").update({ confidence_backed_picks_enabled: true }).eq("id", true);
});

test("F, K, L: a low balance disables only the unaffordable amounts; the control is usable and labelled on a phone", async ({ page }) => {
  test.setTimeout(240_000);
  const g = await seedGame("poor");
  await pickViaDb(poor.id, g.marketId, "YES");
  await loginAs(page, poor.email);
  await page.setViewportSize({ width: 375, height: 800 });
  await gotoFeedReady(page);
  const c = card(page, g);
  const backing = c.locator('[data-slot="confidence-backing"]');
  await expect(backing).toContainText("You have 🔥3 available");

  // F. Only the amounts above the available balance are disabled; the ordinary Pick buttons remain usable.
  for (const n of [1, 2, 3]) await expect(backing.getByRole("button", { name: `${n} Confidence` })).toBeEnabled();
  for (const n of [4, 5]) await expect(backing.getByRole("button", { name: `${n} Confidence` })).toBeDisabled();
  await expect(c.getByRole("button", { name: new RegExp(`Pick ${g.away}`) })).toBeEnabled();

  // L. Textual meaning for every flame; the selected state is not colour alone.
  const labels = await backing.locator('[data-slot="confidence-choice"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(labels).toEqual(["1 Confidence", "2 Confidence", "3 Confidence", "4 Confidence", "5 Confidence"]);
  await backing.getByRole("button", { name: "2 Confidence" }).click();
  await expect(backing.getByRole("button", { name: "2 Confidence" })).toHaveAttribute("aria-pressed", "true");
  await expect(backing.getByRole("alertdialog", { name: "Confirm Confidence" })).toContainText("🔥2");

  // K. Phone width: no horizontal overflow, tap targets are comfortable, choices wrap inside the card.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await backing.locator('[data-slot="confidence-choice"]').first().boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(36);
  expect(box!.width).toBeGreaterThanOrEqual(40);
  const cardBox = await c.boundingBox();
  for (const b of await backing.locator('[data-slot="confidence-choice"]').all()) {
    const bb = (await b.boundingBox())!;
    expect(bb.x + bb.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
  }
  // Confirming from the phone commits and locks the card.
  await backing.getByRole("button", { name: /^Confirm/ }).click();
  await expect(c.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 3 total, 1 available, 2 reserved behind your picks/);
});

test("J: a Sponsor sees no Member Confidence UI", async ({ page }) => {
  test.setTimeout(120_000);
  const sponsor = await createSponsorLogin();
  await loginAsSponsor(page, sponsor.email);
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="confidence-backing"]')).toHaveCount(0);
  await page.goto("/feed").catch(() => undefined);
  await expect(page.locator('[data-slot="confidence-backing"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
});

test("Shell summary: the old pill under the logo is gone; a labelled Confidence block (total, available, reserved) sits in the lower navigation where Wallet was, links to the Confidence page, works on a phone, and is absent for a Sponsor, a signed-out visitor and when Confidence is off", async ({ page }) => {
  test.setTimeout(240_000);
  const m = await createMember("shell");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  // A meaningful state: 🔥50 total, 🔥32 available, 🔥18 reserved behind a pick.
  await admin.from("platform_settings").update({ confidence_allowed_stakes: [18] }).eq("id", true);
  const g = await seedGame("shell");
  await pickViaDb(m.id, g.marketId, "YES");
  const attached = await admin.rpc("confidence_attach_stake", { p_member_id: m.id, p_prediction_id: (await admin.from("predictions").select("id").eq("user_id", m.id).single()).data!.id, p_amount: 18, p_idempotency_key: randomUUID() });
  expect((attached.data as Row).outcome).toBe("attached");

  await loginAs(page, m.email);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoFeedReady(page);
  const rail = page.locator('aside[aria-label="Navigation"]');
  // The old small pill directly under the logo is gone …
  await expect(rail.locator(':scope > a[data-slot="shell-confidence"]')).toHaveCount(0);
  // … and the Confidence block is in the lower navigation section (the one holding Settings, Rules and Log out), as a labelled, three-figure summary.
  const block = rail.locator('nav[aria-label="Primary"] [data-slot="shell-confidence"]');
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("Confidence");
  await expect(block).toContainText("50 total");
  await expect(block).toContainText("32 available");
  await expect(block).toContainText("18 reserved behind your picks");
  await expect(block).toHaveAttribute("aria-label", "Confidence: 50 total, 32 available, 18 reserved behind your picks. Open your Confidence history");
  expect(await block.evaluate((el) => !!el.closest("div")?.querySelector('a[href="/profile/edit"]'))).toBe(true); // same section as Settings
  // Where a Wallet row still exists (money capability on), Confidence leads the section and Wallet never sits above it.
  if ((await rail.locator('a[href="/wallet"]').count()) > 0) {
    expect(await block.evaluate((el) => !!(el.compareDocumentPosition(document.querySelector('aside[aria-label="Navigation"] a[href="/wallet"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  }
  await page.screenshot({ path: `${process.env.E2E_SHOTS ?? "test-results"}/shell-confidence-desktop.png` });

  // It is a real link to the Confidence page, and the page speaks the same vocabulary.
  await block.click();
  await expect(page).toHaveURL(/\/profile\/confidence$/);
  await expect(page.locator('[data-slot="confidence-history-total"]')).toContainText("50 total");
  await expect(page.locator('[data-slot="confidence-split"]')).toContainText("32 available");
  await expect(page.locator('[data-slot="confidence-split"]')).toContainText("18 reserved behind your picks");
  await expect(rail.locator('nav[aria-label="Primary"] [data-slot="shell-confidence"]')).toHaveAttribute("aria-current", "page");

  // Phone: the total chip is in the top bar; the full summary is in the Menu, in Wallet's old place. No overflow, nothing clipped.
  await page.setViewportSize({ width: 375, height: 800 });
  await gotoFeedReady(page);
  const chip = page.locator('header [data-slot="shell-confidence"]:visible');
  await expect(chip).toHaveAttribute("aria-label", /^Confidence: 50 total, 32 available, 18 reserved behind your picks/);
  await expect(chip).toContainText("50");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Menu" }).click();
  const menuBlock = page.locator('[data-testid="auth-mobile-menu"] [data-slot="shell-confidence"]');
  await expect(menuBlock).toBeVisible();
  await expect(menuBlock).toContainText("32 available");
  await expect(menuBlock).toContainText("18 reserved behind your picks");
  const box = (await menuBlock.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: `${process.env.E2E_SHOTS ?? "test-results"}/shell-confidence-mobile-menu.png` });
  await menuBlock.click();
  await expect(page).toHaveURL(/\/profile\/confidence$/);

  // Off: nothing — no misleading amounts.
  await page.setViewportSize({ width: 1280, height: 800 });
  await admin.from("platform_settings").update({ confidence_enabled: false }).eq("id", true);
  await gotoFeedReady(page);
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_allowed_stakes: [1, 2, 3, 4, 5] }).eq("id", true);

  // Signed out: nothing.
  await page.context().clearCookies();
  await page.goto("/");
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Inline multi-market expansion: every Market of a Game is usable on the feed card itself.
async function addMarket(fixtureId: string, template: "TOTAL" | "SPREAD", line: number, label: { yes: string; no: string }) {
  const { data: first } = await admin.from("markets").select("provider").eq("fixture_id", fixtureId).limit(1).single();
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider: first!.provider, provider_market_id: `sec_${randomUUID()}`, question: "E2E secondary", status: "ACTIVE", fixture_id: fixtureId, market_template: template, yes_side: template === "TOTAL" ? null : "HOME", line_value: line,
      yes_price: 0.5, no_price: 0.5, price_outcome_labels: label, liquidity: 500, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to add market");
  return data.id as string;
}
async function fullGame(name: string, startsInMinutes = 180) {
  const g = await seedGame(name, startsInMinutes);
  const spreadId = await addMarket(g.fixtureId, "SPREAD", -2.5, { yes: "yes", no: "no" });
  const totalId = await addMarket(g.fixtureId, "TOTAL", 224, { yes: "Over 224", no: "Under 224" });
  return { ...g, spreadId, totalId };
}
const seeMore = (c: ReturnType<typeof card>) => c.locator('button[data-slot="see-more-markets"]');
const section = (c: ReturnType<typeof card>, marketId: string) => c.locator(`[data-slot="feed-market"][data-market-id="${marketId}"]`);

test("Inline markets A–I, O, P: collapsed by default; expands in place under one title; Total and Spread Picks save, reveal their own sentiment and take Confidence independently; collapse changes nothing; the market page agrees", async ({ page }) => {
  test.setTimeout(300_000);
  const m = await createMember("inline");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  const single = await seedGame("single");
  const g = await fullGame("full");
  await loginAs(page, m.email);
  await gotoFeedReady(page);

  // A. One Market: no See more markets control.
  await expect(card(page, single)).toBeVisible();
  await expect(seeMore(card(page, single))).toHaveCount(0);

  // B/D. Several Markets: collapsed by default, a See more markets button, no navigation or modal when it opens.
  const c = card(page, g);
  await expect(seeMore(c)).toHaveText(/see more markets/i);
  await expect(seeMore(c)).toHaveAttribute("aria-expanded", "false");
  await expect(c.locator('[data-slot="more-markets-panel"]')).toBeHidden();
  const urlBefore = page.url();
  await seeMore(c).click();
  await expect(page).toHaveURL(urlBefore);
  await expect(c.locator('[data-slot="more-markets-panel"]')).toBeVisible();
  await expect(c.locator('[data-slot="more-markets-panel"]').getByText("Make your prediction")).toHaveCount(1);
  await expect(c.locator('[data-slot="market-heading"]')).toHaveText(["Game Total 224", "Spread"]);
  await expect(c.getByRole("dialog")).toHaveCount(0);
  // No duplicate Moneyline: the primary's two team buttons + Over/Under + the two spread choices, nothing more.
  await expect(c.getByRole("button", { name: /^Pick / })).toHaveCount(6);
  await expect(c.getByRole("button", { name: "Pick Over 224 total points" })).toBeVisible();
  await expect(c.getByRole("button", { name: "Pick Under 224 total points" })).toBeVisible();
  await expect(c.getByRole("button", { name: new RegExp(`Pick ${g.home} minus 2\\.5`) })).toHaveText(new RegExp(`${g.home} -2\\.5`));
  await expect(c.getByRole("button", { name: new RegExp(`Pick ${g.away} plus 2\\.5`) })).toHaveText(new RegExp(`${g.away} \\+2\\.5`));

  // E. A Total Pick saves inline, reveals ITS sentiment only, and offers Confidence.
  const total = section(c, g.totalId);
  const spread = section(c, g.spreadId);
  await expect(total).toContainText("Make your pick to see how everyone else picked.");
  await total.getByRole("button", { name: "Pick Over 224 total points" }).click();
  await expect(total.locator('[data-slot="market-sentiment"]')).toContainText("Over 224 100% · Under 224 0% · 1 predicted");
  await expect(total.locator('[data-slot="confidence-backing"]')).toContainText("How confident are you?");
  await expect(spread).toContainText("Make your pick to see how everyone else picked."); // the spread has its own, still hidden
  await expect(spread.locator('[data-slot="confidence-backing"]')).toHaveCount(0);
  expect((await admin.from("confidence_prediction_stakes").select("id").eq("member_id", m.id)).data).toEqual([]);
  await expect(page).toHaveURL(urlBefore);

  // G. Confidence on the Total: explicit confirmation, atomic reserve, locked, committed amount shown.
  await total.locator('[data-slot="confidence-choice"][data-amount="2"]').click();
  await expect(total.locator('[data-slot="confidence-confirm"]')).toContainText("Over 224");
  await total.locator('[data-slot="confidence-confirm-button"]').click();
  await expect(total.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
  await expect(total.getByRole("button", { name: /^Pick / })).toHaveCount(0);
  await expect(total.locator('[data-slot="confidence-backing"]')).toHaveCount(0);

  // F/H. A Spread Pick and its own Confidence, independent of the Total's. I. The reserve adds up.
  await spread.getByRole("button", { name: new RegExp(`Pick ${g.away} plus 2\\.5`) }).click();
  await expect(spread.locator('[data-slot="market-sentiment"]')).toContainText("1 predicted");
  await expect(spread.locator('[data-slot="confidence-backing"]')).toContainText("How confident are you?");
  await spread.locator('[data-slot="confidence-choice"][data-amount="1"]').click();
  await spread.locator('[data-slot="confidence-confirm-button"]').click();
  await expect(spread.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked");
  const stakes = ((await admin.from("confidence_prediction_stakes").select("amount, state").eq("member_id", m.id)).data ?? []).map((s) => s.amount).sort();
  expect(stakes).toEqual([1, 2]);
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 50 total, 47 available, 3 reserved behind your picks/);
  expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);

  // Collapse: nothing is removed, changed or unlocked; re-expanding shows the same state.
  await seeMore(c).click();
  await expect(seeMore(c)).toHaveText(/see more markets/i);
  await expect(c.locator('[data-slot="more-markets-panel"]')).toBeHidden();
  expect((await admin.from("confidence_prediction_stakes").select("amount").eq("member_id", m.id)).data).toHaveLength(2);
  await seeMore(c).click();
  await expect(total.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
  await expect(spread.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "1 Confidence, locked");

  // The primary Market is still independent and usable: a Pick, with its own Confidence option.
  await c.locator('[data-slot="feed-market"]').first().getByRole("button", { name: new RegExp(`Pick ${g.home} to win`) }).click();
  await expect(c.locator('[data-slot="feed-market"]').first().locator('[data-slot="confidence-backing"]')).toBeVisible();

  // P. Feed -> Market page: the very same state for the secondary Market.
  await page.goto(`/markets/${g.totalId}`);
  await expect(page.getByText("You picked: Over 224")).toBeVisible();
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked");
  await gotoFeedReady(page);
  await card(page, g).locator('button[data-slot="see-more-markets"]').click();
  await expect(section(card(page, g), g.totalId).locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "2 Confidence, locked"); // and back
});

test("Inline markets J, K, M, N, O: an existing secondary Pick is shown on load; a Pick inside the lock window is refused; both capability switches fall back to plain Picks; phone widths hold", async ({ page }) => {
  test.setTimeout(300_000);
  const m = await createMember("inline2");
  await admin.rpc("confidence_bootstrap_member", { p_member_id: m.id });
  const existing = await fullGame("existing");
  const late = await fullGame("latewin", 60);
  await pickViaDb(m.id, existing.spreadId, "YES");
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", late.fixtureId); // inside the 10-minute window
  await loginAs(page, m.email);
  await gotoFeedReady(page);

  // J. Existing Pick on a secondary Market: the canonical state when opened — selected side and the Confidence option, no re-pick.
  const c = card(page, existing);
  await seeMore(c).click();
  const spread = section(c, existing.spreadId);
  await expect(spread.getByRole("button", { name: new RegExp(`Pick ${existing.home} minus 2\\.5`) })).toHaveAttribute("aria-pressed", "true");
  await expect(spread.locator('[data-slot="confidence-backing"]')).toBeVisible();
  await expect(spread.locator('[data-slot="market-sentiment"]')).toBeVisible();

  // K. Inside the lock window the server refuses a Pick on a secondary Market, and nothing is saved.
  const cl = card(page, late);
  await seeMore(cl).click();
  await section(cl, late.totalId).getByRole("button", { name: "Pick Over 224 total points" }).click();
  await expect(section(cl, late.totalId).getByRole("status").or(section(cl, late.totalId).getByRole("alert"))).toContainText(/lock/i);
  expect((await admin.from("predictions").select("id").eq("user_id", m.id).eq("market_id", late.totalId)).data).toEqual([]);

  // O. Phone width, expanded: no horizontal overflow, spread names readable inside the card, Confidence fits.
  await page.setViewportSize({ width: 375, height: 800 });
  await gotoFeedReady(page);
  const cm = card(page, existing);
  await expect(cm).toHaveCount(1); // exactly one card for the Game (waits out a streaming transition rather than measuring a doubled tree)
  await seeMore(cm).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const cardBox = (await cm.boundingBox())!;
  for (const b of await cm.locator('[data-slot="feed-market"] button:visible').all()) {
    const bb = (await b.boundingBox())!;
    expect(bb.x).toBeGreaterThanOrEqual(cardBox.x - 1);
    expect(bb.x + bb.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  }
  await expect(section(cm, existing.spreadId).locator('[data-slot="confidence-choice"]').first()).toBeVisible();
  await page.screenshot({ path: `${process.env.E2E_SHOTS ?? "test-results"}/inline-markets-mobile.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  // N. Backed Picks OFF: ordinary Picks on every Market, no selector.
  await admin.from("platform_settings").update({ confidence_backed_picks_enabled: false }).eq("id", true);
  await gotoFeedReady(page);
  const cn = card(page, existing);
  await seeMore(cn).click();
  await expect(cn.locator('[data-slot="confidence-backing"]')).toHaveCount(0);
  await section(cn, existing.totalId).getByRole("button", { name: "Pick Under 224 total points" }).click();
  await expect(section(cn, existing.totalId).locator('[data-slot="market-sentiment"]')).toBeVisible();
  await expect(cn.locator('[data-slot="confidence-backing"]')).toHaveCount(0);

  // M. Confidence OFF: Picks still work, no Confidence UI anywhere on the card.
  await admin.from("platform_settings").update({ confidence_backed_picks_enabled: true, confidence_enabled: false }).eq("id", true);
  await gotoFeedReady(page);
  const cf = card(page, existing);
  await seeMore(cf).click();
  await expect(cf).not.toContainText(/How confident|Confidence/);
  await section(cf, existing.totalId).getByRole("button", { name: "Pick Over 224 total points" }).click();
  await expect.poll(async () => ((await admin.from("predictions").select("selected_outcome").eq("user_id", m.id).eq("market_id", existing.totalId).single()).data as Row).selected_outcome).toBe("YES");
  await admin.from("platform_settings").update({ confidence_enabled: true }).eq("id", true);
});
