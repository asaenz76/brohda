/**
 * Sponsored Game Posts in a real browser: a sponsor drafts and submits, Super Admin confirms payment and approves, the SAME Game Post then shows
 * "Sponsored · Presented by …" for members, the switch hides it instantly without touching the Post, and the commercial surfaces are closed to
 * everyone who shouldn't see them. Test accounts and a local database only; no real payment exists in any of it.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

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
  const sponsorUser = await createUser("sponsor");
  const superUser = await createUser("super", "super_admin");
  const member = await createUser("member");
  const { data: sponsor } = await admin.from("sponsors").insert({ display_name: `Acme E2E ${suffix}`, logo_path: `${randomUUID()}/logo.webp` }).select("id").single();
  await admin.from("sponsor_users").insert({ sponsor_id: sponsor!.id, user_id: sponsorUser.id });
  await setEnabled(true);
  await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 250000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const destination = "https://acme.example.com/e2e-promo";

  try {
    // --- Sponsor: finds the Game, drafts, submits ---------------------------------------------------------------------------------------------
    await loginAs(page, sponsorUser.email);
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
    expect((await page.goto("/sponsor"))?.status()).toBe(404);
    expect((await page.goto(`/sponsor/${sponsorshipId}`))?.status()).toBe(404);
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
  const sponsorUser = await createUser("sponsoroff");
  const superUser = await createUser("superoff", "super_admin");
  const { data: sponsor } = await admin.from("sponsors").insert({ display_name: `Off Co ${suffix}`, logo_path: `${randomUUID()}/logo.webp` }).select("id").single();
  await admin.from("sponsor_users").insert({ sponsor_id: sponsor!.id, user_id: sponsorUser.id });
  await setEnabled(true);
  await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 1000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const { data: draft } = await admin.rpc("sponsor_create_sponsorship", { p_user_id: sponsorUser.id, p_sponsor_id: sponsor!.id, p_inventory_id: (await admin.from("sponsorship_inventory").select("id").eq("post_id", game.postId).single()).data!.id, p_campaign_name: "Existing" });
  const draftId = (Array.isArray(draft) ? draft[0] : draft).id as string;
  await setEnabled(false);
  try {
    await loginAs(page, sponsorUser.email);
    await page.goto("/sponsor");
    await expect(page.getByRole("status")).toContainText("aren't open right now");
    await expect(page.getByRole("link", { name: "Browse available Games" })).toHaveCount(0);
    await page.goto("/sponsor/games");
    await expect(page.getByRole("status")).toContainText("aren't open right now");
    await expect(page.getByRole("button", { name: "Start sponsorship" })).toHaveCount(0);
    await page.goto(`/sponsor/${draftId}`);
    await expect(page.getByText("Draft", { exact: true })).toBeVisible(); // history readable
    await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0); // no editor, no submit
  } finally {
    await cleanup(game);
  }
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
  const a = await createUser("isoa");
  const b = await createUser("isob");
  const { data: sa } = await admin.from("sponsors").insert({ display_name: `Alpha ${suffix}` }).select("id").single();
  const { data: sb } = await admin.from("sponsors").insert({ display_name: `Beta ${suffix}` }).select("id").single();
  await admin.from("sponsor_users").insert([{ sponsor_id: sa!.id, user_id: a.id }, { sponsor_id: sb!.id, user_id: b.id }]);
  await setEnabled(true);
  const { data: inv } = await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: superUser.id, p_post_id: game.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 1000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 6 * HOUR).toISOString() });
  const invId = (Array.isArray(inv) ? inv[0] : inv).id as string;
  const { data: created } = await admin.rpc("sponsor_create_sponsorship", { p_user_id: a.id, p_sponsor_id: sa!.id, p_inventory_id: invId, p_campaign_name: "Alpha campaign" });
  const alphaId = (Array.isArray(created) ? created[0] : created).id as string;
  try {
    await loginAs(page, b.email);
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

