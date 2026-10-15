/**
 * Confidence in a real browser: OFF by default (nothing visible anywhere, the history page is a 404, a direct claim is refused), a Super Admin switches it on from Settings, a Member sees their 🔥 balance and the
 * Daily Claim (active, rolling, below the baseline only), their private history, the public flame on a profile, and the admin economy page where an adjustment is recorded as a ledger entry. A Sponsor never sees it.
 * Local test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

test.describe.configure({ mode: "serial" });

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const tag = randomUUID().slice(0, 6);
  const email = `e2e-conf-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const displayName = `${label}${tag}`;
  const username = `c${label}${tag}`.toLowerCase();
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: displayName, username, role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email, displayName, username };
}

async function createSponsorLogin() {
  const email = `e2e-conf-sponsor-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: org, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: `Conf Co ${randomUUID().slice(0, 4)}`, p_contact_name: "E2E", p_website: null, p_country: null, p_phone: null });
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
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false });
}

let saved: Row | null = null;
test.beforeAll(async () => {
  const { data } = await admin.from("platform_settings").select("confidence_enabled, confidence_baseline, confidence_daily_claim_amount, confidence_daily_claim_interval_hours").eq("id", true).single();
  saved = data;
  await admin.from("platform_settings").update({ confidence_enabled: false, confidence_baseline: 50, confidence_daily_claim_amount: 1, confidence_daily_claim_interval_hours: 24 }).eq("id", true);
});
test.afterAll(async () => {
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});

test("off by default; Super Admin turns it on; a Member sees 🔥, claims once (rolling), sees private history; others see the public flame; admin adjusts through the ledger; a Sponsor never sees it", async ({ page }) => {
  test.setTimeout(300_000);
  const superAdmin = await createMember("owner", "super_admin");
  const a = await createMember("alice");
  const b = await createMember("bobby");
  const sponsor = await createSponsorLogin();

  // 1. OFF: nothing visible, the history page is a plain 404, and no account was created as a side effect.
  await loginAs(page, a.email);
  await page.goto("/profile");
  await expect(page.locator('[data-slot="confidence-card"]')).toHaveCount(0);
  expect((await page.goto("/profile/confidence"))?.status()).toBe(404);
  await page.goto(`/profile/${b.username}`);
  await expect(page.locator('[data-slot="public-confidence"]')).toHaveCount(0);
  expect((await admin.from("confidence_accounts").select("member_id").eq("member_id", a.id)).data).toEqual([]);

  // 2. Super Admin turns it on from Settings (audited).
  await loginAs(page, superAdmin.email);
  await page.goto("/admin/settings/brohda");
  const card = page.locator('[data-slot="confidence-settings"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-slot="confidence-state"]')).toHaveText("Off");
  await card.getByLabel("Members can see and earn Confidence").check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.locator('[data-slot="confidence-state"]')).toHaveText("On");
  await shot(page, "settings-confidence");
  // An invalid change is refused as a whole.
  await card.getByLabel(/Baseline/).fill("4");
  await card.getByLabel(/Daily Claim \(Confidence\)/).fill("5");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("alert")).toContainText("Daily Claim can't be larger than the baseline");
  expect((await admin.from("platform_settings").select("confidence_baseline").eq("id", true).single()).data!.confidence_baseline).toBe(50); // nothing was applied

  // 3. A Member sees the baseline once; at the baseline there is no Claim button.
  await loginAs(page, a.email);
  await page.goto("/profile");
  const mine = page.locator('[data-slot="confidence-card"]');
  await expect(mine.locator('[data-slot="confidence-total"]')).toContainText("🔥50");
  await expect(mine.locator('[data-slot="confidence-claim-button"]')).toHaveCount(0);
  expect((await admin.from("confidence_ledger_entries").select("id").eq("member_id", a.id).eq("entry_type", "INITIAL_GRANT")).data).toHaveLength(1);

  // 4. Below the baseline a claim appears; claiming is active, adds the configured amount and then waits on a real duration (never "tomorrow").
  const sa = superAdmin.id;
  await admin.rpc("admin_confidence_adjust", { p_admin_id: sa, p_member_id: a.id, p_amount: -3, p_reason_code: "CORRECTION", p_note: "e2e setup", p_idempotency_key: randomUUID() });
  await page.reload();
  await expect(mine.locator('[data-slot="confidence-total"]')).toContainText("🔥47");
  const claimButton = mine.locator('[data-slot="confidence-claim-button"]');
  await expect(claimButton).toHaveText("Claim +1🔥");
  await shot(page, "confidence-claim");
  await page.waitForLoadState("networkidle"); // let the client component hydrate before pressing its button
  await claimButton.click();
  await expect(mine.locator('[data-slot="confidence-total"]')).toContainText("🔥48");
  await expect(mine.locator('[data-slot="confidence-claim-button"]')).toHaveCount(0);
  await expect(mine.locator('[data-slot="confidence-wait"]')).toContainText(/Next Daily Claim in 2[34]h|Next Daily Claim in 23h 5\d?m/);
  await expect(mine).not.toContainText(/tomorrow/i);
  expect((await admin.from("confidence_ledger_entries").select("id").eq("member_id", a.id).eq("entry_type", "DAILY_CLAIM")).data).toHaveLength(1);
  await page.reload();
  await expect(mine.locator('[data-slot="confidence-wait"]')).toBeVisible(); // a reload cannot claim twice

  // 5. Private history: initial, adjustment, claim — newest first; no admin note or reason ever shown.
  await page.goto("/profile/confidence");
  const rows = page.locator('[data-slot="confidence-history-row"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Daily Claim");
  await expect(rows.nth(0)).toContainText("+1🔥");
  await expect(rows.nth(1)).toContainText("Adjustment by Brohda");
  await expect(rows.nth(1)).toContainText("−3🔥");
  await expect(rows.nth(2)).toContainText("Initial Confidence");
  await expect(page.locator("main")).not.toContainText(/e2e setup|CORRECTION|support/i);
  await shot(page, "confidence-history");

  // 6. Another Member sees only the public flame — no history — on a profile.
  await loginAs(page, b.email);
  await page.goto(`/profile/${a.username}`);
  await expect(page.locator('[data-slot="public-confidence"]')).toContainText("🔥48");
  await expect(page.getByText("Daily Claim")).toHaveCount(0);

  // 7. Super Admin: the economy page and one Member's ledger, where an adjustment is a new entry and a reversal is a compensating one.
  await loginAs(page, superAdmin.email);
  await page.goto("/admin/confidence");
  await expect(page.locator('[data-slot="economy"]')).toContainText("Total Confidence");
  await page.getByLabel("Username").fill(a.username);
  await page.getByRole("button", { name: "Look up" }).click();
  const member = page.locator('[data-slot="member-confidence"]');
  await expect(member.locator('[data-slot="member-available"]')).toContainText("🔥48");
  await page.waitForLoadState("networkidle"); // the adjustment form is a client component: let it hydrate before typing, or the browser submits it as a plain form
  await member.getByLabel(/Change/).fill("2");
  await member.getByLabel(/Note/).fill("goodwill after a support case");
  await member.getByRole("button", { name: "Record adjustment" }).click();
  await expect.poll(async () => Number((await admin.from("confidence_accounts").select("available").eq("member_id", a.id).single()).data!.available)).toBe(50);
  await page.reload();
  await expect(member.locator('[data-slot="ledger-entry"][data-type="ADMIN_ADJUSTMENT"]').first()).toContainText("goodwill after a support case");
  await shot(page, "admin-confidence");

  // 8. A Sponsor never sees Confidence.
  await loginAsSponsor(page, sponsor.email);
  await page.goto("/profile/confidence");
  await expect(page).not.toHaveURL(/\/profile\/confidence/);
  await expect(page.locator('[data-slot="confidence-card"]')).toHaveCount(0);
});
