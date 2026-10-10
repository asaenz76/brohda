/**
 * Sponsored Game Posts in a real browser: a sponsor drafts and submits, Super Admin confirms payment and approves, the SAME Game Post then shows
 * "Sponsored · Presented by …" for members, the switch hides it instantly without touching the Post, and the commercial surfaces are closed to
 * everyone who shouldn't see them. Test accounts and a local database only; no real payment exists in any of it.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import http from "node:http";
import { OnvoSandbox } from "../helpers/onvo-sandbox";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const HOUR = 3_600_000;

test.describe.configure({ mode: "serial" });

async function createUser(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-spons-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${Math.floor(Math.random() * 100000)}`, username: `sp${label}${Date.now()}${Math.floor(Math.random() * 1000)}`, role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email };
}

/** A SPONSOR login (no member profile) with its organization — the same database function the signup action uses. */
async function createSponsorLogin(displayName: string, status: "PENDING_REVIEW" | "ACTIVE" = "ACTIVE") {
  const email = `e2e-spons-login-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: org, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: displayName, p_contact_name: "E2E Contact", p_website: null, p_country: null, p_phone: null });
  if (accountError) throw accountError;
  const sponsorId = (Array.isArray(org) ? org[0] : org).id as string;
  await admin.from("sponsors").update({ status, logo_path: `${randomUUID()}/logo.webp` }).eq("id", sponsorId);
  return { id: data.user.id as string, email, sponsorId };
}

async function loginAsSponsor(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/sponsor/login");
  await page.getByLabel("Business email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/sponsor$/);
}

async function loginAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

const setEnabled = async (enabled: boolean) => {
  const { error } = await admin.from("platform_settings").update({ sponsorship_enabled: enabled }).eq("id", true);
  if (error) throw error;
};

async function seedGamePost(suffix: string) {
  const home = `Gridiron Home ${suffix}`;
  const away = `Gridiron Away ${suffix}`;
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ provider: "api_nfl", external_fixture_id: `e2e-spons-${randomUUID()}`, sport: "american_football", home_team_name: home, away_team_name: away, competition_name: "NFL", competition_external_id: "1", scheduled_start_utc: new Date(Date.now() + 24 * HOUR).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "api_nfl", provider_market_id: `sp_${randomUUID()}`, question: "q?", status: "ACTIVE", fixture_id: fixture!.id, yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, market_template: "MONEYLINE", yes_side: "HOME", line_value: null })
    .select("id")
    .single();
  const { data: total } = await admin
    .from("markets")
    .insert({ provider: "api_nfl", provider_market_id: `sp_t_${randomUUID()}`, question: "t?", status: "ACTIVE", fixture_id: fixture!.id, yes_price: 0.5, no_price: 0.5, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, market_template: "TOTAL", yes_side: null, line_value: 44.5 })
    .select("id")
    .single();
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  return { fixtureId: fixture!.id as string, marketId: market!.id as string, totalMarketId: total!.id as string, postId: post!.id as string, home, away };
}

async function cleanup(game: { fixtureId: string; marketId: string; postId: string }) {
  const { data: sponsorships } = await admin.from("sponsorships").select("id").eq("post_id", game.postId);
  const ids = (sponsorships ?? []).map((s) => s.id);
  if (ids.length) {
    await admin.from("sponsorship_exposure_events").delete().in("sponsorship_id", ids);
    await admin.from("sponsorship_payment_events").delete().in("sponsorship_id", ids);
    await admin.from("sponsorship_approvals").delete().in("sponsorship_id", ids).then(() => undefined, () => undefined);
  }
}

test("sponsor drafts and submits → Super Admin confirms payment and approves → the same Game Post shows the sponsor → the switch hides it → a stranger can't see any of it", async ({ page }) => {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const sponsorUser = await createSponsorLogin(`Acme E2E ${suffix}`);
  const superUser = await createUser("super", "super_admin");
  const member = await createUser("member");
  await setEnabled(true);
  await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 250000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const destination = "https://acme.example.com/e2e-promo";

  try {
    // --- Sponsor: finds the Game, drafts, submits ---------------------------------------------------------------------------------------------
    await loginAsSponsor(page, sponsorUser.email);
    await page.goto("/sponsor/games");
    const card = page.locator("div").filter({ hasText: `Gridiron Away ${suffix} @ Gridiron Home ${suffix}` }).filter({ has: page.getByRole("button", { name: "Start sponsorship" }) }).last();
    await expect(card).toContainText("$2,500.00");
    await card.getByRole("button", { name: "Start sponsorship" }).click();
    await expect(page).toHaveURL(/\/sponsor\/[0-9a-f-]{36}$/);
    const sponsorshipId = page.url().split("/").pop()!;
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();

    await page.getByLabel("Destination link").fill("javascript:alert(1)");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText(/full web address starting with https/i)).toBeVisible(); // malicious scheme refused with a readable message

    await page.getByLabel("Destination link").fill(destination);
    await page.getByLabel("Call-to-action text (optional)").fill("Learn more");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Submitted — awaiting payment and review")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "awaiting payment and review" })).toBeVisible();
    // Nothing public yet.
    await page.goto("/feed");
    await expect(page.locator("article").filter({ hasText: game.home }).locator('[data-slot="sponsored-label"]')).toHaveCount(0);

    // --- A different member cannot see the commercial area ------------------------------------------------------------------------------------
    await loginAs(page, member.email);
    await page.goto("/sponsor");
    await expect(page).toHaveURL(/\/feed$/); // a Member is sent back to the Member product, never shown the Sponsor area
    await page.goto(`/sponsor/${sponsorshipId}`);
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto("/admin/sponsorship");
    await expect(page).toHaveURL(/\/feed$/); // not an admin: bounced

    // --- Super Admin: payment alone does not publish; approval then does ----------------------------------------------------------------------
    await loginAs(page, superUser.email);
    await page.goto(`/admin/sponsorship/${sponsorshipId}`);
    await expect(page.getByRole("status").filter({ hasText: "Submitted — awaiting payment and review" })).toBeVisible();
    await page.getByLabel("Payment reference").fill("INV-E2E-1");
    await page.getByRole("button", { name: "Mark payment received" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Payment received — awaiting Brohda approval" })).toBeVisible();
    await page.goto("/feed");
    await expect(page.locator("article").filter({ hasText: game.home }).locator('[data-slot="sponsored-label"]')).toHaveCount(0); // paid, not approved: still dark

    await page.goto(`/admin/sponsorship/${sponsorshipId}`);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Live/ })).toBeVisible();

    // --- Members now see the sponsorship on the SAME Game Post ---------------------------------------------------------------------------------
    await loginAs(page, member.email);
    await page.goto("/feed");
    const article = page.locator("article").filter({ hasText: game.home }).first();
    const label = article.locator('[data-slot="sponsored-label"]');
    await expect(label).toContainText("Sponsored");
    await expect(label).toContainText(`Presented by`);
    await expect(label).toContainText(`Acme E2E ${suffix}`);
    const cta = label.getByRole("link", { name: /Learn more/ });
    await expect(cta).toHaveAttribute("href", `/sponsorship/click/${sponsorshipId}`);
    await expect(cta).toHaveAttribute("rel", /sponsored/);
    await expect(cta).toHaveAttribute("target", "_blank");
    await expect(article.getByTestId("prediction-actions")).toBeVisible(); // the Pick controls are untouched
    // SEE MORE MARKETS and the sponsor line coexist: both visible, different places, neither covering the other, at the narrowest width too.
    const more = article.getByRole("link", { name: /^See more markets/i });
    await expect(more).toBeVisible();
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const [lb, mb] = [(await label.boundingBox())!, (await more.boundingBox())!];
      expect(lb.y + lb.height).toBeLessThanOrEqual(mb.y); // sponsor line above the action
      expect(mb.x + mb.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(cta).toBeVisible(); // the sponsor CTA is still its own, separate link
    // The first-party click path redirects to the approved destination (and records it).
    const click = await page.request.get(`/sponsorship/click/${sponsorshipId}`, { maxRedirects: 0 });
    expect(click.status()).toBe(302);
    expect(click.headers()["location"]).toBe(destination);

    // One Game, one Post, one conversation: the Post page shows the same sponsor and the same Market.
    await article.getByRole("link", { name: new RegExp(game.home) }).first().click();
    await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
    await expect(page.locator('[data-slot="sponsored-label"]')).toContainText(`Acme E2E ${suffix}`);
    // An impression is recorded for a member who actually sees it (half visible for a second), once.
    await expect.poll(async () => (await admin.from("sponsorship_exposure_events").select("id").eq("sponsorship_id", sponsorshipId).eq("event_type", "IMPRESSION")).data?.length ?? 0, { timeout: 15_000 }).toBe(1);

    // --- The switch: OFF hides it everywhere at once, nothing else changes; ON restores what is still valid --------------------------------
    await setEnabled(false);
    await page.goto("/feed");
    const offArticle = page.locator("article").filter({ hasText: game.home }).first();
    await expect(offArticle).toBeVisible();
    await expect(offArticle.locator('[data-slot="sponsored-label"]')).toHaveCount(0);
    await expect(offArticle.getByTestId("prediction-actions")).toBeVisible();
    expect((await page.request.get(`/sponsorship/click/${sponsorshipId}`, { maxRedirects: 0 })).status()).toBe(404);
    const row = (await admin.from("sponsorships").select("lifecycle, payment_status, review_status").eq("id", sponsorshipId).single()).data;
    expect(row).toEqual({ lifecycle: "LIVE", payment_status: "PAID", review_status: "APPROVED" }); // history untouched
    await setEnabled(true);
    await page.goto("/feed");
    await expect(page.locator("article").filter({ hasText: game.home }).first().locator('[data-slot="sponsored-label"]')).toBeVisible();

    // --- Super Admin suspends: gone at once, Post untouched -------------------------------------------------------------------------------------
    await loginAs(page, superUser.email);
    await page.goto(`/admin/sponsorship/${sponsorshipId}`);
    await page.getByLabel(/Reason \/ note/).fill("E2E suspension");
    await page.getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Suspended" })).toBeVisible();
    await loginAs(page, member.email);
    await page.goto("/feed");
    await expect(page.locator("article").filter({ hasText: game.home }).first().locator('[data-slot="sponsored-label"]')).toHaveCount(0);

    // The audit trail is on the admin page.
    await loginAs(page, superUser.email);
    await page.goto(`/admin/sponsorship/${sponsorshipId}`);
    await expect(page.getByRole("region", { name: "Audit history" })).toContainText("payment_confirmed");
    await expect(page.getByRole("region", { name: "Audit history" })).toContainText("approved");
    await expect(page.getByRole("region", { name: "Audit history" })).toContainText("suspended");
  } finally {
    await setEnabled(false);
    await cleanup(game);
  }
});

test("with Sponsored Game Posts OFF a sponsor can read their history but cannot start or submit anything", async ({ page }) => {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const sponsorUser = await createSponsorLogin(`Off Co ${suffix}`);
  const sponsor = { id: sponsorUser.sponsorId };
  const superUser = await createUser("superoff", "super_admin");
  await setEnabled(true);
  await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 1000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const { data: draft } = await admin.rpc("sponsor_create_sponsorship", { p_user_id: sponsorUser.id, p_sponsor_id: sponsor.id, p_inventory_id: (await admin.from("sponsorship_inventory").select("id").eq("post_id", game.postId).single()).data!.id, p_campaign_name: "Existing" });
  const draftId = (Array.isArray(draft) ? draft[0] : draft).id as string;
  await setEnabled(false);
  try {
    await loginAsSponsor(page, sponsorUser.email);
    await page.goto("/sponsor");
    await expect(page.getByRole("status").filter({ hasText: "aren't open right now" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Browse available Games" })).toHaveCount(0);
    await page.goto("/sponsor/games");
    await expect(page.getByRole("status").filter({ hasText: "aren't open right now" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start sponsorship" })).toHaveCount(0);
    await page.goto(`/sponsor/${draftId}`);
    await expect(page.getByText("Draft", { exact: true })).toBeVisible(); // history readable
    await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0); // no editor, no submit
  } finally {
    await cleanup(game);
  }
});

test("the public Sponsorship page follows the capability: a plain 'not open right now' notice when OFF, none when ON — and the call to action is the Sponsor signup either way", async ({ page }) => {
  try {
    await setEnabled(false);
    await page.goto("/sponsorship");
    await expect(page.locator('[data-slot="sponsorship-closed"]')).toContainText("not open right now");
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);
    for (const cta of await page.getByRole("link", { name: "Become a Sponsor" }).all()) await expect(cta).toHaveAttribute("href", "/sponsor/signup");
    // The Sponsor application itself is not a campaign: it still works while campaigns are closed (the account is reviewed first).
    await page.getByRole("link", { name: "Become a Sponsor" }).first().click();
    await expect(page.getByRole("button", { name: "Apply to sponsor" })).toBeVisible();

    await setEnabled(true);
    await page.goto("/sponsorship");
    await expect(page.locator('[data-slot="sponsorship-closed"]')).toHaveCount(0);
    for (const cta of await page.getByRole("link", { name: "Become a Sponsor" }).all()) await expect(cta).toHaveAttribute("href", "/sponsor/signup");
  } finally {
    await setEnabled(false);
  }
});

// --- refund policy: what a Sponsor is told before cancelling, the frozen decision, and what Super Admin sees ----------------------------------------------------

async function paidCampaign(kickoffInHours: number, label: string) {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const sponsor = await createSponsorLogin(`${label} ${suffix}`);
  const superUser = await createUser(`${label}super`, "super_admin");
  await setEnabled(true);
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + kickoffInHours * HOUR).toISOString() }).eq("id", game.fixtureId);
  const { data: inv } = await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 90000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + (kickoffInHours + 6) * HOUR).toISOString() });
  const invId = (Array.isArray(inv) ? inv[0] : inv).id as string;
  const rpcRow = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const created = await rpcRow("sponsor_create_sponsorship", { p_user_id: sponsor.id, p_sponsor_id: sponsor.sponsorId, p_inventory_id: invId, p_campaign_name: `${label} campaign` });
  await rpcRow("sponsor_update_sponsorship", { p_user_id: sponsor.id, p_id: created.id, p_fields: { presented_by: "Refund Co", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://refund.example.com/promo" } });
  await rpcRow("sponsor_submit_sponsorship", { p_user_id: sponsor.id, p_id: created.id });
  await rpcRow("admin_mark_sponsorship_paid", { p_admin_id: superUser.id, p_id: created.id, p_reference: "INV-REFUND", p_note: "bank transfer", p_idempotency_key: randomUUID() });
  const { data: rev } = await admin.from("sponsorships").select("revision").eq("id", created.id).single();
  await rpcRow("admin_approve_sponsorship", { p_admin_id: superUser.id, p_id: created.id, p_expected_revision: rev!.revision });
  return { game, sponsor, superUser, sponsorshipId: created.id as string, invId };
}

test("a Sponsor cancelling a paid campaign 24h before kickoff is told it is refund-eligible, with the exact deadline, confirms explicitly — payment stays PAID, the Game is released, and Super Admin sees the frozen decision", async ({ page }) => {
  const c = await paidCampaign(24, "Early");
  try {
    await loginAsSponsor(page, c.sponsor.email);
    await page.goto(`/sponsor/${c.sponsorshipId}`);
    const panel = page.locator('[data-slot="cancel-sponsorship"]');
    await expect(panel).toContainText("Refunds for Sponsor-initiated cancellations are available only when the Sponsorship is cancelled at least 12 hours before scheduled Game kickoff.");
    await expect(panel.locator('[data-slot="refund-deadline"]')).toBeVisible();
    await expect(panel.locator('[data-slot="cancel-consequence"]')).toHaveText("This cancellation is currently refund-eligible.");
    await panel.getByRole("button", { name: "Cancel sponsorship…" }).click();
    const confirm = panel.getByRole("button", { name: "Confirm cancellation" });
    await expect(confirm).toBeDisabled(); // an explicit confirmation is required
    await panel.getByLabel(/I understand this cancellation is currently refund-eligible/).check();
    await confirm.click();
    await expect(page.locator('[data-slot="cancellation-outcome"]')).toContainText("refund-eligible; Brohda processes the refund separately");

    const { data: row } = await admin.from("sponsorships").select("lifecycle, payment_status").eq("id", c.sponsorshipId).single();
    expect(row).toEqual({ lifecycle: "CANCELLED", payment_status: "PAID" }); // eligible is not refunded
    expect((await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", c.sponsorshipId).in("event_type", ["REFUND_PENDING", "REFUNDED"])).data).toEqual([]);
    expect((await admin.from("sponsorships").select("id").eq("inventory_id", c.invId).in("lifecycle", ["SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED"])).data).toEqual([]); // the slot is free again

    await loginAs(page, c.superUser.email);
    await page.goto(`/admin/sponsorship/${c.sponsorshipId}`);
    const guidance = page.locator('[data-slot="refund-guidance"]');
    await expect(guidance.locator('[data-slot="cancellation-record"]')).toContainText("Refund eligible");
    await expect(guidance.locator('[data-slot="cancellation-record"]')).toContainText("Cancelled by the Sponsor");
    await expect(guidance.locator('[data-slot="cancellation-record"]')).toContainText("refund cutoff (12h before)");
    await expect(guidance).toContainText("Payment: Paid");
    await expect(guidance).toContainText("No refund recorded");
    await expect(guidance).not.toContainText(/stripe|paypal|onvo/i);
  } finally {
    await setEnabled(false);
    await cleanup(c.game);
  }
});

test("six hours before kickoff the Sponsor is told plainly it is NOT refund-eligible, may still cancel, and the Game is still released", async ({ page }) => {
  const c = await paidCampaign(6, "Late");
  try {
    await loginAsSponsor(page, c.sponsor.email);
    await page.goto(`/sponsor/${c.sponsorshipId}`);
    const panel = page.locator('[data-slot="cancel-sponsorship"]');
    await expect(panel.locator('[data-slot="cancel-consequence"]')).toHaveText("This cancellation is not eligible for a refund.");
    await expect(panel).toContainText("non-refundable");
    await panel.getByRole("button", { name: "Cancel sponsorship…" }).click();
    await panel.getByLabel(/not eligible for a refund and the payment is non-refundable/).check();
    await panel.getByRole("button", { name: "Confirm cancellation" }).click();
    await expect(page.locator('[data-slot="cancellation-outcome"]')).toContainText("not eligible for a refund");
    expect((await admin.from("sponsorships").select("lifecycle, payment_status").eq("id", c.sponsorshipId).single()).data).toEqual({ lifecycle: "CANCELLED", payment_status: "PAID" });
    expect((await admin.from("sponsorships").select("id").eq("inventory_id", c.invId).in("lifecycle", ["SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED"])).data).toEqual([]);

    await loginAs(page, c.superUser.email);
    await page.goto(`/admin/sponsorship/${c.sponsorshipId}`);
    await expect(page.locator('[data-slot="cancellation-record"]')).toContainText("Not refund eligible");
  } finally {
    await setEnabled(false);
    await cleanup(c.game);
  }
});

test("if the refund deadline passes while the Sponsor is reading, nothing is cancelled — they are asked to review the updated notice, never surprised afterwards", async ({ page }) => {
  const c = await paidCampaign(13, "Race");
  try {
    await loginAsSponsor(page, c.sponsor.email);
    await page.goto(`/sponsor/${c.sponsorshipId}`);
    const panel = page.locator('[data-slot="cancel-sponsorship"]');
    await expect(panel.locator('[data-slot="cancel-consequence"]')).toHaveText("This cancellation is currently refund-eligible.");
    await panel.getByRole("button", { name: "Cancel sponsorship…" }).click();
    await panel.getByLabel(/currently refund-eligible/).check();
    // The deadline passes (the Game is now 6h away) before the Sponsor confirms.
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 6 * HOUR).toISOString() }).eq("id", c.game.fixtureId);
    await panel.getByRole("button", { name: "Confirm cancellation" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "refund cancellation deadline changed" })).toBeVisible();
    expect((await admin.from("sponsorships").select("lifecycle").eq("id", c.sponsorshipId).single()).data!.lifecycle).not.toBe("CANCELLED");
    await expect(page.locator('[data-slot="cancel-consequence"]')).toHaveText("This cancellation is not eligible for a refund."); // the refreshed notice
  } finally {
    await setEnabled(false);
    await cleanup(c.game);
  }
});

test("Super Admin cancelling states WHY: the cause decides refund eligibility (a Brohda decision at T-6h is eligible; a Sponsor breach is not) and nothing refunds by itself", async ({ page }) => {
  const a = await paidCampaign(6, "Brohdacause");
  const b = await paidCampaign(6, "Breachcause");
  try {
    await loginAs(page, a.superUser.email);
    await page.goto(`/admin/sponsorship/${a.sponsorshipId}`);
    await page.getByLabel(/Reason \/ note/).fill("Brohda cancelled");
    await page.getByLabel("Cancellation cause").selectOption({ value: "BROHDA_CANCELLED_NO_BREACH" });
    await page.getByRole("button", { name: "Cancel sponsorship" }).click();
    await expect(page.locator('[data-slot="cancellation-record"]')).toContainText("Refund eligible");
    await expect(page.locator('[data-slot="cancellation-record"]')).toContainText("Cancelled by Brohda");

    await page.goto(`/admin/sponsorship/${b.sponsorshipId}`);
    await page.getByLabel(/Reason \/ note/).fill("prohibited content");
    await page.getByLabel("Cancellation cause").selectOption({ value: "SPONSOR_BREACH" });
    await page.getByRole("button", { name: "Cancel sponsorship" }).click();
    await expect(page.locator('[data-slot="cancellation-record"]')).toContainText("Not refund eligible");
    for (const id of [a.sponsorshipId, b.sponsorshipId]) expect((await admin.from("sponsorships").select("payment_status").eq("id", id).single()).data!.payment_status).toBe("PAID");
  } finally {
    await setEnabled(false);
    await cleanup(a.game);
    await cleanup(b.game);
  }
});

// --- ONVO sponsorship payments (TEST mode, against the local deterministic sandbox — never the real API) ---------------------------------------------------------

const ONVO_KEY = "onvo_test_secret_key_e2e";
const ONVO_WEBHOOK_SECRET = "webhook_secret_e2e";
const ONVO_PORT = 54399;

async function unpaidCampaign(kickoffInHours: number, label: string) {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const sponsor = await createSponsorLogin(`${label} ${suffix}`);
  const superUser = await createUser(`${label}super`, "super_admin");
  await setEnabled(true);
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + kickoffInHours * HOUR).toISOString() }).eq("id", game.fixtureId);
  const rpcRow = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const inv = await rpcRow("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 90000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + (kickoffInHours + 6) * HOUR).toISOString() });
  const created = await rpcRow("sponsor_create_sponsorship", { p_user_id: sponsor.id, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: `${label} campaign` });
  await rpcRow("sponsor_update_sponsorship", { p_user_id: sponsor.id, p_id: created.id, p_fields: { presented_by: "Pay Co", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://pay.example.com/promo" } });
  await rpcRow("sponsor_submit_sponsorship", { p_user_id: sponsor.id, p_id: created.id });
  return { game, sponsor, superUser, sponsorshipId: created.id as string, postId: game.postId };
}

test.describe("ONVO TEST payments", () => {
  let sandbox: OnvoSandbox;
  let server: http.Server;

  test.beforeAll(async () => {
    sandbox = new OnvoSandbox(ONVO_KEY, `http://127.0.0.1:${ONVO_PORT}`, "test");
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${ONVO_PORT}`);
        if (req.method === "GET" && url.pathname.startsWith("/pay/")) {
          res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>Sandbox checkout</h1></body></html>");
          return;
        }
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const out = await sandbox.handle(req.method ?? "GET", url.pathname, (req.headers.authorization as string | undefined) ?? null, body).catch(() => ({ status: 500, json: {} }));
        res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(ONVO_PORT, "127.0.0.1", resolve));
    // Online payments are operational configuration: switched on for these tests by the same platform setting a Super Admin edits, and switched back off after.
    await admin.from("platform_settings").update({ sponsorship_online_payments_enabled: true, sponsorship_online_payment_provider: "ONVO" }).eq("id", true);
  });
  test.afterAll(async () => {
    await admin.from("platform_settings").update({ sponsorship_online_payments_enabled: false, sponsorship_online_payment_provider: null }).eq("id", true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a Sponsor pays with ONVO (test) → the amount is the server's, the browser can't change it → the webhook marks it PAID → it is still NOT live until Super Admin approves", async ({ page }) => {
    const c = await unpaidCampaign(24, "Onvo");
    try {
      await loginAsSponsor(page, c.sponsor.email);
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      const panel = page.locator('[data-slot="sponsor-payment"]');
      await expect(panel).toContainText("$900.00");
      expect(await panel.innerText()).not.toMatch(/onvo/i); // a Sponsor never sees a provider brand
      await expect(panel.locator('[data-slot="payment-status"]')).toHaveText("Awaiting payment.");
      // The browser tries to smuggle in a different amount: there is no amount field, and anything added is ignored.
      await page.evaluate(() => {
        const form = document.querySelector('[data-slot="sponsor-payment"] form')!;
        for (const name of ["amount", "unitAmount", "price", "currency"]) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = "1";
          form.appendChild(input);
        }
      });
      await panel.getByRole("button", { name: "Pay now" }).click();
      await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${ONVO_PORT}/pay/cs_`));
      const create = sandbox.requests.filter((q) => q.method === "POST" && q.path === "/v1/checkout/sessions/one-time-link").at(-1)!;
      expect(create.body).toMatchObject({ lineItems: [{ quantity: 1, unitAmount: 90000, currency: "USD" }] });
      expect(JSON.stringify(create.body)).not.toContain(ONVO_KEY);

      // Coming back is NOT payment: nothing is paid yet, and the page says so.
      await page.goto(`/sponsor/${c.sponsorshipId}/payment/return?result=success`);
      await expect(page.locator('[data-slot="payment-return-status"]')).toHaveText("Payment pending.");
      expect((await admin.from("sponsorships").select("payment_status").eq("id", c.sponsorshipId).single()).data!.payment_status).toBe("PENDING");

      // A webhook without the secret (or with a wrong one) is refused and changes nothing.
      const { data: attempt } = await admin.from("commercial_payment_attempts").select("provider_session_id").eq("sponsorship_id", c.sponsorshipId).single();
      const sessionId = attempt!.provider_session_id as string;
      sandbox.pay(sessionId);
      const event = sandbox.webhook("checkout-session.succeeded", sessionId);
      expect((await page.request.post("/api/webhooks/onvo", { data: event })).status()).toBe(401);
      expect((await page.request.post("/api/webhooks/onvo", { data: event, headers: { "X-Webhook-Secret": "nope" } })).status()).toBe(401);
      expect((await admin.from("sponsorships").select("payment_status").eq("id", c.sponsorshipId).single()).data!.payment_status).toBe("PENDING");

      // The authenticated webhook (verified against the provider) marks it PAID — and a retry changes nothing.
      const ok = await page.request.post("/api/webhooks/onvo", { data: event, headers: { "X-Webhook-Secret": ONVO_WEBHOOK_SECRET } });
      expect(ok.status()).toBe(200);
      expect((await ok.json()).result).toBe("APPLIED_PAID");
      expect((await (await page.request.post("/api/webhooks/onvo", { data: event, headers: { "X-Webhook-Secret": ONVO_WEBHOOK_SECRET } })).json()).result).toBe("DUPLICATE");
      expect((await admin.from("sponsorships").select("payment_status, review_status, lifecycle").eq("id", c.sponsorshipId).single()).data).toEqual({ payment_status: "PAID", review_status: "PENDING", lifecycle: "SUBMITTED" });
      expect((await admin.from("sponsorship_payment_events").select("id").eq("sponsorship_id", c.sponsorshipId).eq("event_type", "PAID")).data).toHaveLength(1);

      await page.goto(`/sponsor/${c.sponsorshipId}/payment/return?result=success`);
      await expect(page.locator('[data-slot="payment-return-status"]')).toHaveText("Payment received.");
      await expect(page.getByText(/still awaiting Brohda approval/)).toBeVisible();
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await expect(page.locator('[data-slot="sponsor-payment"]')).toHaveCount(0); // nothing left to pay

      // PAID is not live: members see nothing sponsored until Super Admin approves.
      const viewer = await createUser("onvoviewer");
      await loginAs(page, viewer.email);
      await page.goto("/feed");
      await expect(page.locator("article").filter({ hasText: c.game.home }).locator('[data-slot="sponsored-label"]')).toHaveCount(0);

      // Super Admin sees the payment (TEST) and the provider status, then approves; only now does it run.
      await loginAs(page, c.superUser.email);
      await page.goto("/admin/sponsorship");
      const card = page.locator('[data-slot="online-payments-status"]');
      await expect(card.locator('[data-slot="online-payments-state"]')).toHaveText("Enabled");
      await expect(card.locator('[data-slot="provider-environment"]')).toHaveText("TEST");
      await expect(card.locator('[data-slot="online-payments-configuration"]')).toHaveText("Ready");
      await page.goto(`/admin/sponsorship/${c.sponsorshipId}`);
      const attemptRow = page.locator('[data-slot="payment-provider-panel"] [data-attempt-id]');
      await expect(attemptRow.locator('[data-slot="payment-environment"]')).toHaveText("TEST");
      await expect(attemptRow.locator('[data-slot="attempt-status"]')).toHaveText("Paid");
      await expect(attemptRow).toContainText("Test payment — no real money moved");
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: /^Live|Approved and scheduled/ })).toBeVisible();
      await loginAs(page, viewer.email);
      await page.goto("/feed");
      await expect(page.locator("article").filter({ hasText: c.game.home }).first().locator('[data-slot="sponsored-label"]')).toContainText("Pay Co");
    } finally {
      await setEnabled(false);
      await cleanup(c.game);
    }
  });

  test("a failed payment tells the Sponsor in simple words and lets them try again; deferred never reads as paid", async ({ page }) => {
    const c = await unpaidCampaign(24, "Onvofail");
    try {
      await loginAsSponsor(page, c.sponsor.email);
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await page.getByRole("button", { name: "Pay now" }).click();
      await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${ONVO_PORT}/pay/`));
      const { data: attempt } = await admin.from("commercial_payment_attempts").select("provider_session_id").eq("sponsorship_id", c.sponsorshipId).single();
      const sessionId = attempt!.provider_session_id as string;
      const headers = { "X-Webhook-Secret": ONVO_WEBHOOK_SECRET };

      const deferred = sandbox.defer(sessionId);
      expect((await (await page.request.post("/api/webhooks/onvo", { data: sandbox.webhook("payment-intent.deferred", sessionId, deferred, { withMetadata: true }), headers })).json()).result).toBe("APPLIED_PENDING");
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await expect(page.locator('[data-slot="payment-status"]')).toHaveText("Payment pending.");
      expect((await admin.from("sponsorships").select("payment_status").eq("id", c.sponsorshipId).single()).data!.payment_status).toBe("PENDING");

      const failed = sandbox.fail(sessionId);
      expect((await (await page.request.post("/api/webhooks/onvo", { data: sandbox.webhook("payment-intent.failed", sessionId, failed, { withMetadata: true }), headers })).json()).result).toBe("APPLIED_FAILED");
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await expect(page.locator('[data-slot="payment-status"]')).toHaveText("Payment failed — you can try again.");
      await expect(page.locator('[data-slot="sponsor-payment"]')).not.toContainText(/declined|processing_error|requires_payment_method/i); // no provider internals
      await page.getByRole("button", { name: "Pay now" }).click();
      await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${ONVO_PORT}/pay/`));
      expect((await admin.from("commercial_payment_attempts").select("status").eq("sponsorship_id", c.sponsorshipId).order("created_at")).data!.map((a) => a.status)).toEqual(["FAILED", "PENDING"]);
    } finally {
      await setEnabled(false);
      await cleanup(c.game);
    }
  });

  test("Super Admin turns online payments off and on from the card: Sponsors lose and regain 'Pay now', the change is audited, and the options are only installed providers", async ({ page }) => {
    const c = await unpaidCampaign(24, "Onvocfg");
    try {
      await loginAs(page, c.superUser.email);
      await page.goto("/admin/sponsorship");
      const card = page.locator('[data-slot="online-payments-status"]');
      const select = card.getByLabel("Provider for new payments");
      expect(await select.locator("option").allInnerTexts()).toEqual(["Disabled", "ONVO"]); // only what this deployment has installed
      await select.selectOption("DISABLED");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByRole("status")).toHaveText("Online payments are off.");
      await expect(card.locator('[data-slot="online-payments-state"]')).toHaveText("Disabled");

      await loginAsSponsor(page, c.sponsor.email);
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await expect(page.locator('[data-slot="sponsor-payment"]')).toBeVisible(); // manual payment instructions / status still shown
      await expect(page.getByRole("button", { name: "Pay now" })).toHaveCount(0);

      await loginAs(page, c.superUser.email);
      await page.goto("/admin/sponsorship");
      await card.getByLabel("Provider for new payments").selectOption("ONVO");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByRole("status")).toHaveText("Online payments are on.");
      await loginAsSponsor(page, c.sponsor.email);
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await expect(page.getByRole("button", { name: "Pay now" })).toBeVisible();

      const { data: logs } = await admin.from("audit_logs").select("before, after").eq("actor_id", c.superUser.id).eq("action", "settings.online_payments_updated").order("created_at");
      expect(logs).toEqual([
        { before: { enabled: true, provider: "ONVO" }, after: { enabled: false, provider: null } },
        { before: { enabled: false, provider: null }, after: { enabled: true, provider: "ONVO" } },
      ]);
    } finally {
      await setEnabled(false);
      await cleanup(c.game);
    }
  });

  test("another Sponsor, a Member and a signed-out visitor can neither see the payment option nor start a payment for someone else's sponsorship", async ({ page }) => {
    const c = await unpaidCampaign(24, "Onvoiso");
    const other = await createSponsorLogin(`Onvoother ${randomUUID().slice(0, 6)}`);
    const member = await createUser("onvoisomember");
    try {
      await loginAsSponsor(page, other.email);
      expect((await page.goto(`/sponsor/${c.sponsorshipId}`))?.status()).toBe(404);
      await expect(page.getByRole("button", { name: "Pay now" })).toHaveCount(0);
      await loginAs(page, member.email);
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await expect(page).toHaveURL(/\/feed$/);
      await page.context().clearCookies();
      await page.goto(`/sponsor/${c.sponsorshipId}`);
      await expect(page).toHaveURL(/\/sponsor\/login/);
      expect((await admin.from("commercial_payment_attempts").select("id").eq("sponsorship_id", c.sponsorshipId)).data).toEqual([]);
    } finally {
      await setEnabled(false);
      await cleanup(c.game);
    }
  });
});

test("the Super Admin settings page carries the Sponsored Game Posts switch, saves it, and audits it", async ({ page }) => {
  const superUser = await createUser("setsuper", "super_admin");
  await setEnabled(false);
  try {
    await loginAs(page, superUser.email);
    await page.goto("/admin/settings/brohda");
    const toggle = page.getByRole("switch", { name: "Sponsored Game Posts" });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await page.getByRole("button", { name: "Save Sponsorship" }).click();
    await expect(page.getByText("Saved.").last()).toBeVisible();
    expect((await admin.from("platform_settings").select("sponsorship_enabled").eq("id", true).single()).data!.sponsorship_enabled).toBe(true);
    const { data: logs } = await admin.from("audit_logs").select("before, after").eq("actor_id", superUser.id).eq("action", "settings.sponsorship_updated");
    expect(logs).toHaveLength(1);
    expect(logs![0].after.sponsorshipEnabled).toBe(true);
  } finally {
    await setEnabled(false);
  }
});

test("a sponsor of another organization cannot open someone else's sponsorship, even with its exact URL", async ({ page }) => {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const superUser = await createUser("isosuper", "super_admin");
  const a = await createSponsorLogin(`Alpha ${suffix}`);
  const b = await createSponsorLogin(`Beta ${suffix}`);
  const sa = { id: a.sponsorId };
  await setEnabled(true);
  const { data: inv } = await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 1000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const invId = (Array.isArray(inv) ? inv[0] : inv).id as string;
  const { data: created } = await admin.rpc("sponsor_create_sponsorship", { p_user_id: a.id, p_sponsor_id: sa.id, p_inventory_id: invId, p_campaign_name: "Alpha campaign" });
  const alphaId = (Array.isArray(created) ? created[0] : created).id as string;
  try {
    await loginAsSponsor(page, b.email);
    expect((await page.goto(`/sponsor/${alphaId}`))?.status()).toBe(404);
    await page.goto("/sponsor");
    await expect(page.getByText("Alpha campaign")).toHaveCount(0);
    await expect(page.getByText(`Alpha ${suffix}`)).toHaveCount(0);
  } finally {
    await setEnabled(false);
    await cleanup(game);
  }
});

test.describe("inventory campaign window is shown in the admin's own time zone", () => {
  test.use({ timezoneId: "America/Costa_Rica" });

  test("the default end is exactly the configured hours after the kickoff shown beside it — in the same zone — and saving round-trips the instants", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const game = await seedGamePost(suffix);
    const superUser = await createUser("tzsuper", "super_admin");
    const kickoff = new Date("2030-10-11T17:00:00Z"); // 11:00 AM in Costa Rica
    await admin.from("fixtures").update({ scheduled_start_utc: kickoff.toISOString() }).eq("id", game.fixtureId);
    try {
      await loginAs(page, superUser.email);
      await page.goto("/admin/sponsorship/inventory");
      const row = page.locator("div.rounded-lg").filter({ hasText: `Gridiron Away ${suffix} @ Gridiron Home ${suffix}` }).first();
      await expect(row).toContainText("11:00 AM"); // the kickoff, in the admin's zone
      const ends = row.getByLabel(/^Ends/);
      await expect(ends).toHaveValue("2030-10-11T17:00"); // kickoff 11:00 AM + 6h = 5:00 PM the same local day, not "11:00 PM"
      await expect(row.getByLabel(/^Ends/)).toBeVisible();
      await expect(row.locator("label").filter({ hasText: /^Ends/ })).toContainText("America/Costa_Rica");

      // Saving stores the instants the admin sees: start 09:00 local, end 17:00 local.
      await row.getByLabel(/^Starts/).fill("2030-10-11T09:00");
      await row.getByRole("checkbox", { name: "Sponsorable" }).check();
      await row.getByLabel("Price").fill("100.00");
      await row.getByRole("button", { name: "Save" }).click();
      await expect(row.getByText("Saved.")).toBeVisible();
      const { data: inv } = await admin.from("sponsorship_inventory").select("starts_at, ends_at").eq("post_id", game.postId).single();
      expect(new Date(inv!.starts_at).toISOString()).toBe("2030-10-11T15:00:00.000Z"); // 09:00 Costa Rica
      expect(new Date(inv!.ends_at).toISOString()).toBe("2030-10-11T23:00:00.000Z"); // 17:00 Costa Rica
      await page.reload();
      await expect(page.locator("div.rounded-lg").filter({ hasText: `Gridiron Home ${suffix}` }).first().getByLabel(/^Ends/)).toHaveValue("2030-10-11T17:00");
    } finally {
      await admin.from("sponsorship_inventory").delete().eq("post_id", game.postId);
      await cleanup(game);
    }
  });
});

// A 1x1 PNG: a real image the upload route accepts (magic bytes checked, re-encoded server-side).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("Super Admin records a sponsor, uploads its logo and assigns a sponsorable Game — and the sponsor account finds it in its own list (there is no way to add a Member to a Sponsor)", async ({ page }) => {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const superUser = await createUser("assignsuper", "super_admin");
  const sponsorLogin = await createSponsorLogin(`Assign Account ${suffix}`);
  const stranger = await createUser("assignstranger");
  const name = `Assign Co ${suffix}`;
  await setEnabled(true);
  const { data: inv } = await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 5000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const invId = (Array.isArray(inv) ? inv[0] : inv).id as string;
  try {
    await loginAs(page, superUser.email);
    await page.goto("/admin/sponsorship/sponsors");
    await page.getByLabel("Display name").fill(name);
    await page.getByRole("button", { name: "Create sponsor without a login" }).click();
    await expect(page.getByText(/Sponsor organization created/)).toBeVisible();
    const card = page.locator("li[data-sponsor-id]").filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card.getByText("No logo")).toBeVisible();
    await expect(card.getByText(/No login — managed by Brohda/)).toBeVisible();
    // The old "Add a member" tool is gone: a Sponsor is its own account, never a Member linked to an organization.
    await expect(page.getByText(/Add a member/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Add member/i })).toHaveCount(0);

    // Logo: choose a file, press Upload, see it saved and previewed.
    await expect(card.getByRole("button", { name: "Upload logo" })).toBeDisabled(); // nothing chosen yet
    await card.getByLabel(`Logo file for ${name}`).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await card.getByRole("button", { name: "Upload logo" }).click();
    await expect(card.getByText("Logo saved.")).toBeVisible();
    await expect(card.locator('[data-slot="sponsor-logo-preview"]')).toBeVisible();
    // A non-image is refused with a readable reason.
    await card.getByLabel(`Logo file for ${name}`).setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("not an image at all") });
    await card.getByRole("button", { name: "Upload logo" }).click();
    await expect(card.getByText(/Unsupported image type/)).toBeVisible();

    // Assign the Game, from the inventory page, to the sponsor ACCOUNT.
    await page.goto("/admin/sponsorship/inventory");
    const row = page.locator("div.rounded-lg").filter({ hasText: `Gridiron Away ${suffix} @ Gridiron Home ${suffix}` }).first();
    // Choosing before the page has hydrated is undone by React; retry until the (controlled) choice sticks and the button enables.
    const chooseSponsor = () =>
      expect(async () => {
        await row.getByLabel(/^Sponsor for /).selectOption({ label: `Assign Account ${suffix}` });
        await expect(row.getByRole("button", { name: /^Assign / })).toBeEnabled({ timeout: 1500 });
      }).toPass({ timeout: 20_000 });
    await chooseSponsor();
    await row.getByRole("button", { name: /^Assign / }).click();
    await expect(row.getByText(/Assigned — the sponsor now has it as a draft/)).toBeVisible();
    await row.getByRole("link", { name: "Open it" }).click();
    await expect(page).toHaveURL(/\/admin\/sponsorship\/[0-9a-f-]{36}$/);
    await expect(page.getByText(`Assign Account ${suffix}`).first()).toBeVisible();
    // Assigning again returns the same draft (no duplicates).
    await page.goto("/admin/sponsorship/inventory");
    await chooseSponsor();
    await row.getByRole("button", { name: /^Assign / }).click();
    await expect(row.getByText(/Assigned/)).toBeVisible();
    expect((await admin.from("sponsorships").select("id").eq("post_id", game.postId)).data).toHaveLength(1);

    // The sponsor account sees it in its own area — a Member never reaches the Sponsor area.
    await loginAsSponsor(page, sponsorLogin.email);
    await expect(page.getByText(`Gridiron Away ${suffix} @ Gridiron Home ${suffix}`)).toBeVisible();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await loginAs(page, stranger.email);
    await page.goto("/sponsor");
    await expect(page).toHaveURL(/\/feed$/);
  } finally {
    await setEnabled(false);
    await cleanup(game);
    void invId;
  }
});

test("Super Admin takes an assigned draft all the way — complete it, submit on the sponsor's behalf, mark payment received, approve — and it goes live (no sponsor login needed)", async ({ page }) => {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const superUser = await createUser("completesuper", "super_admin");
  const viewer = await createUser("completeviewer");
  const { data: sponsor } = await admin.from("sponsors").insert({ display_name: `Solo Co ${suffix}`, status: "ACTIVE", logo_path: `${randomUUID()}/logo.webp` }).select("id").single(); // no members at all
  await setEnabled(true);
  const { data: inv } = await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 7500, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const invId = (Array.isArray(inv) ? inv[0] : inv).id as string;
  const { data: assigned } = await admin.rpc("admin_assign_sponsorship", { p_admin_id: superUser.id, p_sponsor_id: sponsor!.id, p_inventory_id: invId, p_campaign_name: "Solo deal" });
  const sponsorshipId = (Array.isArray(assigned) ? assigned[0] : assigned).id as string;
  try {
    await loginAs(page, superUser.email);
    await page.goto(`/admin/sponsorship/${sponsorshipId}`);
    // A draft: the page says why paying/approving is not yet possible and offers the way forward.
    await expect(page.getByText("This is still a draft")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark payment received" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

    await page.getByLabel("Destination link").fill("javascript:alert(1)");
    await page.getByRole("button", { name: "Submit on the sponsor's behalf" }).click();
    await expect(page.getByText(/full web address starting with https/i)).toBeVisible();
    await page.getByLabel("Destination link").fill("https://solo.example.com/offer");
    await page.getByLabel("Call-to-action text (optional)").fill("See the offer");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved.")).toBeVisible();
    await page.getByRole("button", { name: "Submit on the sponsor's behalf" }).click();
    // The editor's own "Submitted on the sponsor's behalf" message is transient BY DESIGN: the submit refreshes the page and a submitted sponsorship is no longer
    // editable, so the editor (and its message) unmounts. A slow CI runner could miss that flash, so the test asserts the durable result — the new state — instead.

    // Now submitted: pay and approve are there, and they work.
    await expect(page.getByRole("status").filter({ hasText: "Submitted — awaiting payment and review" })).toBeVisible();
    await page.getByLabel("Payment reference").fill("INV-SOLO-1");
    await page.getByRole("button", { name: "Mark payment received" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Payment received — awaiting Brohda approval" })).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Live/ })).toBeVisible();

    await loginAs(page, viewer.email);
    await page.goto("/feed");
    const label = page.locator("article").filter({ hasText: game.home }).first().locator('[data-slot="sponsored-label"]');
    await expect(label).toContainText(`Solo Co ${suffix}`);
    await expect(label.getByRole("link", { name: /See the offer/ })).toBeVisible();
  } finally {
    await setEnabled(false);
    await cleanup(game);
  }
});

test("pricing is Super Admin's: the sponsor sees the price but has no way to change it, and a price the Super Admin set is the price that is submitted", async ({ page }) => {
  const suffix = randomUUID().slice(0, 6);
  const game = await seedGamePost(suffix);
  const superUser = await createUser("pricesuper", "super_admin");
  const sponsorUser = await createSponsorLogin(`Price Co ${suffix}`);
  const sponsor = { id: sponsorUser.sponsorId };
  await setEnabled(true);
  const { data: inv } = await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 250000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const invId = (Array.isArray(inv) ? inv[0] : inv).id as string;
  const { data: assigned } = await admin.rpc("admin_assign_sponsorship", { p_admin_id: superUser.id, p_sponsor_id: sponsor.id, p_inventory_id: invId, p_campaign_name: "Priced" });
  const sponsorshipId = (Array.isArray(assigned) ? assigned[0] : assigned).id as string;
  try {
    await loginAs(page, superUser.email);
    await page.goto(`/admin/sponsorship/${sponsorshipId}`);
    await expect(page.getByRole("button", { name: "Set price" })).toBeDisabled(); // nothing typed: no accidental $0
    await page.getByLabel(/^Price/).fill("1999.50");
    await page.getByRole("button", { name: "Set price" }).click();
    await expect(page.getByText("Done.")).toBeVisible();

    await loginAsSponsor(page, sponsorUser.email);
    await page.goto(`/sponsor/${sponsorshipId}`);
    // The price is shown in the campaign's own Price row (the agreement panel repeats it from the same record, so scope to the row).
    await expect(page.locator("dt", { hasText: /^Price$/ }).locator("xpath=following-sibling::dd[1]")).toContainText("$1,999.50");
    await expect(page.getByText("Set by Brohda — it can't be changed here.")).toBeVisible();
    // No control anywhere on the sponsor's page edits a price.
    await expect(page.getByRole("main").getByRole("textbox", { name: /price|amount|cost/i })).toHaveCount(0);
    await expect(page.getByRole("spinbutton")).toHaveCount(0);
    await page.getByLabel("Destination link").fill("https://price.example.com");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Submitted — awaiting payment and review")).toBeVisible();
    await expect(page.locator("dt", { hasText: /^Price$/ }).locator("xpath=following-sibling::dd[1]")).toContainText("$1,999.50"); // the Super Admin's price, not the inventory's $2,500.00
    const { data: row } = await admin.from("sponsorships").select("price_cents").eq("id", sponsorshipId).single();
    expect(row!.price_cents).toBe(199950);
  } finally {
    await setEnabled(false);
    await cleanup(game);
  }
});

