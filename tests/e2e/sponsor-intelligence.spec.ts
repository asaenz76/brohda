/**
 * Sponsor Intelligence in a real browser: OFF by default (a Sponsor sees nothing), Super Admin switches it on from Settings → Brohda → Sponsorship, the Sponsor then sees aggregate
 * results for their OWN campaign only — with small-cohort figures withheld — and switching it off removes it again. Super Admin keeps the exact figures throughout.
 * Test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const HOUR = 3_600_000;

test.describe.configure({ mode: "serial" });

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function createUser(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-intel-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${Math.floor(Math.random() * 100000)}`, username: `in${label}${Date.now()}${Math.floor(Math.random() * 1000)}`, role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email };
}

async function createSponsorLogin(name: string) {
  const email = `e2e-intel-sponsor-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: org, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: name, p_contact_name: "E2E Contact", p_website: null, p_country: null, p_phone: null });
  if (accountError) throw accountError;
  const sponsorId = (Array.isArray(org) ? org[0] : org).id as string;
  await admin.from("sponsors").update({ status: "ACTIVE", logo_path: `${randomUUID()}/logo.webp` }).eq("id", sponsorId);
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

async function saveIntelligence(page: Page, opts: { enabled: boolean; minCohort: number }) {
  await page.goto("/admin/settings/brohda");
  const form = page.locator('[data-slot="sponsor-intelligence-form"]');
  await expect(form).toBeVisible();
  const toggle = form.getByLabel("Sponsors can see campaign results");
  if ((await toggle.isChecked()) !== opts.enabled) await toggle.click();
  await form.getByLabel("Hide figures under this many Members").fill(String(opts.minCohort));
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("status")).toBeVisible();
  await expect(page.locator('[data-slot="sponsor-intelligence-state"]')).toHaveText(opts.enabled ? "On" : "Off");
  await shot(page, '[data-slot="sponsor-intelligence"]', `settings-${opts.enabled ? "on" : "off"}`);
}


// E2E_SHOTS=<dir> saves screenshots of the new cards for a visual check; normal runs skip it.
async function shot(page: Page, selector: string, name: string, mobile = false) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(selector).first().screenshot({ path: `${dir}/${name}${mobile ? "-mobile" : ""}.png` });
  if (mobile) await page.setViewportSize({ width: 1280, height: 720 });
}

let saved: Row | null = null;
test.beforeAll(async () => {
  const { data } = await admin.from("platform_settings").select("sponsorship_enabled, sponsor_intelligence_enabled, sponsor_intelligence_min_cohort, sponsor_intelligence_affinity_lookback_days").eq("id", true).single();
  saved = data;
  await admin.from("platform_settings").update({ sponsorship_enabled: true, sponsor_intelligence_enabled: false, sponsor_intelligence_min_cohort: 10, sponsor_intelligence_affinity_lookback_days: 90 }).eq("id", true);
});
test.afterAll(async () => {
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});

test("off by default; Super Admin turns it on; the Sponsor sees only suppressed aggregates for their own campaign; turning it off removes them", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 6);
  const superAdmin = await createUser("admin", "super_admin");
  const sponsor = await createSponsorLogin(`Intel Co ${suffix}`);
  const otherSponsor = await createSponsorLogin(`Other Co ${suffix}`);
  const members = [await createUser("a"), await createUser("b"), await createUser("c")];

  // A published Game Post and a draft campaign whose window opened an hour ago.
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ provider: "api_nfl", external_fixture_id: `e2e-intel-${randomUUID()}`, sport: "american_football", home_team_name: `Intel Home ${suffix}`, away_team_name: `Intel Away ${suffix}`, competition_name: "NFL", competition_external_id: "1", scheduled_start_utc: new Date(Date.now() + 24 * HOUR).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  const inv = await admin.rpc("admin_set_sponsorship_inventory", {
    p_admin_id: superAdmin.id, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 100000, p_currency: "USD",
    p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString(),
  });
  expect(inv.error, inv.error?.message).toBeNull();
  const inventoryId = (Array.isArray(inv.data) ? inv.data[0] : inv.data).id as string;
  const created = await admin.rpc("sponsor_create_sponsorship", { p_user_id: sponsor.id, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inventoryId, p_campaign_name: "Intel campaign" });
  expect(created.error, created.error?.message).toBeNull();
  const sponsorshipId = (Array.isArray(created.data) ? created.data[0] : created.data).id as string;
  for (const m of members) await admin.from("sponsorship_exposure_events").insert({ sponsorship_id: sponsorshipId, post_id: post!.id, event_type: "IMPRESSION", user_id: m.id });
  // One Market with a clear split: three Members pick the home side, three the away side (all six are Members; only the first three were counted as viewers).
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "api_nfl", provider_market_id: `in_${randomUUID()}`, question: "q?", status: "ACTIVE", fixture_id: fixture!.id, yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, market_template: "MONEYLINE", yes_side: "HOME", line_value: null })
    .select("id")
    .single();
  const pickers = [...members, await createUser("d"), await createUser("e"), await createUser("f")];
  for (const [i, m] of pickers.entries()) {
    await admin.from("predictions").insert({
      user_id: m.id, market_id: market!.id, selected_outcome: i < 3 ? "YES" : "NO", yes_probability_snapshot: 0.6, no_probability_snapshot: 0.4, market_question_snapshot: "q?", market_close_at_snapshot: null, market_status_snapshot: "ACTIVE", lifecycle_state: "PENDING", idempotency_key: randomUUID(),
    });
  }

  const results = page.locator('[data-slot="sponsor-results"]');

  // 1. OFF by default: the Sponsor sees no results card, not even a hint.
  await loginAsSponsor(page, sponsor.email);
  await page.goto(`/sponsor/${sponsorshipId}`);
  await expect(page.getByRole("heading", { name: "Sponsorship", exact: true })).toBeVisible();
  await expect(results).toHaveCount(0);

  // 2. Super Admin switches it on at the default threshold (10): three Members is below it.
  await loginAs(page, superAdmin.email);
  await saveIntelligence(page, { enabled: true, minCohort: 10 });

  // 3. The Sponsor now sees Results — but the small figure is withheld, with the reason stated.
  await loginAsSponsor(page, sponsor.email);
  await page.goto(`/sponsor/${sponsorshipId}`);
  await expect(results).toBeVisible();
  await expect(page.locator('[data-slot="metric-uniqueViewers"]')).toContainText("Not enough data yet");
  await expect(page.locator('[data-slot="privacy-note"]')).toContainText("fewer than 10 Members");
  await shot(page, '[data-slot="sponsor-results"]', "sponsor-results-suppressed");
  await shot(page, '[data-slot="sponsor-results"]', "sponsor-results-suppressed", true);
  // Nothing on the page can name an individual Member.
  const body = await results.innerText();
  for (const m of members) expect(body).not.toContain(m.email);

  // 4. Super Admin lowers the threshold to 3: now the figure is shown.
  await loginAs(page, superAdmin.email);
  await saveIntelligence(page, { enabled: true, minCohort: 3 });
  await loginAsSponsor(page, sponsor.email);
  await page.goto(`/sponsor/${sponsorshipId}`);
  await expect(page.locator('[data-slot="metric-uniqueViewers"]')).toContainText("3");
  await expect(page.locator('[data-slot="metric-uniqueViewers"]')).not.toContainText("Not enough data yet");
  // The newer figures: repeat viewers (nobody saw it on a second day), the participation rate (3 viewers, all of whom picked: 100%) and the Market split (3 vs 3).
  await expect(page.locator('[data-slot="metric-repeatViewers"]')).toContainText("0");
  await expect(page.locator('[data-slot="rate-participation"]')).toContainText("100%");
  const marketRow = page.locator('[data-slot="market-row"]').first();
  await expect(marketRow).toContainText("Moneyline");
  await expect(marketRow).toContainText("6 Members");
  await expect(page.locator('[data-slot="market-sentiment"]').first()).toContainText("50%");
  await shot(page, '[data-slot="sponsor-results"]', "sponsor-results-shown");

  // The Super Admin-only detail (exact per-side counts, exact affinity) is never on a Sponsor's page, in any form.
  const sponsorPageText = await page.locator("body").innerText();
  for (const adminOnly of ["Super Admin only", "Performance (exact)", " Members — "]) expect(sponsorPageText).not.toContain(adminOnly);
  await expect(page.locator('[data-slot="admin-results"], [data-slot="admin-markets"], [data-slot="admin-only-detail"]')).toHaveCount(0);
  // The Market line a Sponsor does see is a percentage split only — never a per-side count.
  await expect(page.locator('[data-slot="market-sentiment"]').first()).toHaveText(/\d+%.*\d+%/);
  expect(await page.locator('[data-slot="market-sentiment"]').first().innerText()).not.toMatch(/\b[A-Za-z0-9]+ 3\b(?!%)/);

  // 5. Another Sponsor cannot reach this campaign at all.
  await loginAsSponsor(page, otherSponsor.email);
  const response = await page.goto(`/sponsor/${sponsorshipId}`);
  expect(response?.status()).toBe(404);
  await expect(page.locator('[data-slot="sponsor-results"]')).toHaveCount(0);

  // 6. Super Admin sees the exact figures beside what the Sponsor sees.
  await loginAs(page, superAdmin.email);
  await page.goto(`/admin/sponsorship/${sponsorshipId}`);
  const exact = page.locator('[data-slot="admin-metric-uniqueViewers"]');
  await expect(exact.locator('[data-slot="exact"]')).toHaveText("3");
  await expect(exact.locator('[data-slot="sponsor-sees"]')).toHaveText("3");
  await expect(page.locator('[data-slot="admin-results-visibility"]')).toContainText("ON");
  await expect(page.locator('[data-slot="admin-only-detail"]')).toContainText("Super Admin only — never shown to Sponsors");
  await shot(page, '[data-slot="admin-results"]', "admin-results");

  // 7. Switching it off removes the Sponsor's results at once; Super Admin keeps the exact figures.
  await saveIntelligence(page, { enabled: false, minCohort: 3 });
  await loginAsSponsor(page, sponsor.email);
  await page.goto(`/sponsor/${sponsorshipId}`);
  await expect(page.getByRole("heading", { name: "Sponsorship", exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="sponsor-results"]')).toHaveCount(0);
  await loginAs(page, superAdmin.email);
  await page.goto(`/admin/sponsorship/${sponsorshipId}`);
  await expect(page.locator('[data-slot="admin-metric-uniqueViewers"] [data-slot="exact"]')).toHaveText("3");
  await expect(page.locator('[data-slot="admin-results-visibility"]')).toContainText("OFF");

  // Settings changes were audited.
  const { count } = await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.sponsor_intelligence_updated").eq("actor_id", superAdmin.id);
  expect(count).toBeGreaterThanOrEqual(3);

  await admin.from("sponsorship_exposure_events").delete().eq("sponsorship_id", sponsorshipId);
});
