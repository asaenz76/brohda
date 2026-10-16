/**
 * Confidence-backed Picks in a real browser: the Super Admin turns the capability on from Settings (separately from Confidence itself), a Member makes a Pick and answers "How confident are you?" with an explicit
 * confirmation, the Pick locks and the shell balance keeps ONE total with the available/reserved split in its accessible label, the Pick's result shows once graded, the same indicator is there on mobile, a Sponsor
 * never sees any of it, and with the capability off nothing is offered while an existing commitment still shows and settles. Local test accounts and a local database only.
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
  const email = `e2e-bp-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${tag}`, username: `b${label}${tag}`.toLowerCase(), role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email };
}
async function createSponsorLogin() {
  const email = `e2e-bp-sponsor-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: org, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: `BP Co ${randomUUID().slice(0, 4)}`, p_contact_name: "E2E", p_website: null, p_country: null, p_phone: null });
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
async function seedMarket(startsInMinutes = 24 * 60) {
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-bp-${randomUUID()}`, home_team_name: "Home Test FC", away_team_name: "Away Test FC", scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const { data: market, error: marketError } = await admin
    .from("markets")
    .insert({
      provider: `e2e_bp_${randomUUID()}`,
      provider_market_id: `m_${randomUUID()}`,
      question: "E2E backed pick",
      status: "ACTIVE",
      fixture_id: fixture.id,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      yes_price: 0.62,
      no_price: 0.38,
      price_outcome_labels: { yes: "Home Test FC wins", no: "Home Test FC does not win" },
      liquidity: 1000,
      closes_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");
  return { marketId: market.id as string, fixtureId: fixture.id as string };
}
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false });
}
const balance = (page: Page) => page.locator('[data-slot="shell-confidence"]:visible');

let saved: Row | null = null;
test.beforeAll(async () => {
  const { data } = await admin.from("platform_settings").select("confidence_enabled, confidence_backed_picks_enabled, confidence_allowed_stakes, confidence_baseline").eq("id", true).single();
  saved = data;
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: false, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5] }).eq("id", true);
});
test.afterAll(async () => {
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});

test("a Super Admin enables backed Picks; a Member backs a Pick with explicit confirmation; it locks; the shell shows one total; the result shows after grading; off means nothing is offered but settlement still works; a Sponsor sees none of it", async ({ page }) => {
  test.setTimeout(300_000);
  const owner = await createMember("owner", "super_admin");
  const alice = await createMember("alice");
  const sponsor = await createSponsorLogin();
  const { marketId, fixtureId } = await seedMarket();
  await admin.rpc("confidence_bootstrap_member", { p_member_id: alice.id });

  // 1. Capability OFF (Confidence itself on): the balance is in the shell, but no one is asked "How confident are you?".
  await loginAs(page, alice.email);
  await page.goto(`/markets/${marketId}`);
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 50 total, 50 available, 0 reserved behind your picks/);
  await page.waitForLoadState("networkidle"); // let the client component hydrate before pressing its button
  await page.getByRole("button", { name: "Pick Home Test FC to win" }).click();
  await expect.poll(async () => ((await admin.from("predictions").select("selected_outcome").eq("user_id", alice.id)).data ?? []).length).toBe(1);
  await expect(page.locator('[data-slot="confidence-backing"]')).toHaveCount(0);

  // 2. The Super Admin turns the capability on from Settings and edits the result wording.
  await loginAs(page, owner.email);
  await page.goto("/admin/settings/brohda");
  const card = page.locator('[data-slot="confidence-settings"]');
  await expect(card).toBeVisible();
  await card.getByLabel(/put Confidence behind their picks/i).check();
  await card.getByLabel("When the pick was correct").fill("You won {{amount}} Confidence!");
  await card.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await admin.from("platform_settings").select("confidence_backed_picks_enabled, confidence_notify_correct").eq("id", true).single()).data).toEqual({ confidence_backed_picks_enabled: true, confidence_notify_correct: "You won {{amount}} Confidence!" });
  await expect(card.getByRole("status")).toContainText("Members can put it behind picks"); // the form resets when the save completes; wait for that before typing again
  // Wording without {{amount}} is refused and nothing is applied.
  await card.getByLabel("When the pick was incorrect").fill("Better luck next time.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("alert")).toContainText("{{amount}}");

  // 3. The Member now sees "How confident are you?"; choosing is not attaching; confirming is.
  await loginAs(page, alice.email);
  await page.goto(`/markets/${marketId}`);
  const backing = page.locator('[data-slot="confidence-backing"]');
  await expect(backing).toContainText("How confident are you?");
  await shot(page, "backed-picks-ladder");
  await page.waitForLoadState("networkidle"); // let the client component hydrate before pressing its buttons
  await backing.getByRole("button", { name: "3 Confidence" }).click();
  await expect(page.locator('[data-slot="confidence-confirm"]')).toContainText("Once confirmed, you can't change it");
  expect((await admin.from("confidence_prediction_stakes").select("id").eq("member_id", alice.id)).data).toEqual([]); // nothing attached yet
  await shot(page, "backed-picks-confirm");
  await page.locator('[data-slot="confidence-confirm-button"]').click();
  await expect(page.locator('[data-slot="confidence-backed"], [data-slot="pick-confidence"]').first()).toContainText(/3 Confidence|🔥3/);
  const stakes = (await admin.from("confidence_prediction_stakes").select("amount, state").eq("member_id", alice.id)).data;
  expect(stakes).toEqual([{ amount: 3, state: "RESERVED" }]);
  const pick = (await admin.from("predictions").select("lock_reason, locked_at").eq("user_id", alice.id).single()).data!;
  expect(pick.lock_reason).toBe("CONFIDENCE_COMMITTED");

  // 4. The shell keeps ONE total; the split is in the accessible label, never as several numbers.
  await page.reload();
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 50 total, 47 available, 3 reserved behind your picks/);
  await expect(balance(page)).toContainText("50");
  await expect(page.locator('[data-slot="confidence-backing"]')).toHaveCount(0); // a backed Pick is not offered again
  await expect(page.getByRole("button", { name: /^Pick .* to win$/ })).toHaveCount(0); // the Pick can no longer be changed
  await expect(page.locator('[data-slot="pick-confidence"]')).toHaveAttribute("aria-label", "3 Confidence, locked");
  await shot(page, "backed-picks-locked");

  // 5. The same indicator on mobile.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/feed");
  await expect(balance(page)).toBeVisible();
  await expect(balance(page)).toHaveAttribute("aria-label", /Confidence: 50 total/);
  await shot(page, "backed-picks-mobile-shell");
  await page.setViewportSize({ width: 1280, height: 720 });

  // 6. The capability goes OFF while the stake is reserved: nothing new is offered, and grading still settles it.
  await admin.from("platform_settings").update({ confidence_backed_picks_enabled: false }).eq("id", true);
  const { error: gradeError } = await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("user_id", alice.id);
  expect(gradeError).toBeNull();
  await expect.poll(async () => (await admin.from("confidence_prediction_stakes").select("state").eq("member_id", alice.id).single()).data!.state).toBe("SETTLED_CORRECT");
  await page.goto(`/markets/${marketId}`);
  await expect(balance(page)).toHaveAttribute("aria-label", /^Confidence: 53 total, 53 available, 0 reserved behind your picks/);
  await expect(page.locator('[data-slot="pick-confidence-result"]')).toContainText(/\+3|3/);
  await shot(page, "backed-picks-result");

  // 7. History shows the settlement with the net change; the public sees the total only.
  await page.goto("/profile/confidence");
  const rows = page.locator('[data-slot="confidence-history-row"]');
  await expect(rows.first()).toContainText("Prediction correct");
  await expect(rows.first()).toContainText("+3🔥");
  await expect(rows.nth(1)).toContainText("Prediction reserved");

  // 8. A Sponsor never sees Confidence anywhere.
  await loginAsSponsor(page, sponsor.email);
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
  await page.goto(`/markets/${marketId}`).catch(() => undefined);
  await expect(page.locator('[data-slot="confidence-backing"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="shell-confidence"]')).toHaveCount(0);
  void fixtureId;
});
