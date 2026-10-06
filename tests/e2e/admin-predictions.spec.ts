/**
 * E2E coverage for /admin/predictions: the operator table names the user,
 * the Game and the Market (with the short ids kept beside them), stays a
 * compact table, and scrolls sideways at narrow widths instead of squashing
 * Match and Market. Read-only page; seeded through the app's own tables.
 */
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);
const HOME = `Admin Table Home ${suffix}`;
const AWAY = `Admin Table Away ${suffix}`;
const QUESTION = `Will ${HOME} win?`;
const USERNAME = `admtable${suffix}`;
const seeded = { users: [] as string[], fixtureId: "", marketId: "", viewerId: "" };
let adminEmail = "";

test.beforeAll(async () => {
  adminEmail = `adm-table-${suffix}@test.local`;
  const a = await admin.auth.admin.createUser({ email: adminEmail, password: PASSWORD, email_confirm: true });
  await admin.from("user_profiles").insert({ id: a.data.user!.id, display_name: "Admin Table Operator", username: `op${suffix}`, role: "super_admin", is_active: true });
  const p = await admin.auth.admin.createUser({ email: `adm-table-p-${suffix}@test.local`, password: PASSWORD, email_confirm: true });
  seeded.viewerId = p.data.user!.id;
  await admin.from("user_profiles").insert({ id: seeded.viewerId, display_name: "Predictor", username: USERNAME, role: "player", is_active: true });
  seeded.users.push(a.data.user!.id, seeded.viewerId);
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-admtable-${randomUUID()}`, sport: "american_football", home_team_name: HOME, away_team_name: AWAY, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + 48 * 3600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  seeded.fixtureId = fixture!.id;
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "e2e_admtable", provider_market_id: `admtable_${randomUUID()}`, question: QUESTION, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {} })
    .select("id")
    .single();
  seeded.marketId = market!.id;
  await admin
    .rpc("set_pick", { p_user_id: seeded.viewerId, p_market_id: seeded.marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
});

test.afterAll(async () => {
  await admin.from("predictions").delete().eq("market_id", seeded.marketId);
  await admin.from("markets").delete().eq("id", seeded.marketId);
  await admin.from("fixtures").delete().eq("id", seeded.fixtureId);
  for (const id of seeded.users) await admin.auth.admin.deleteUser(id);
});

async function openTable(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
  await page.goto("/admin/predictions");
  await expect(page.getByRole("columnheader", { name: "Match" })).toBeVisible();
  return page.getByRole("row").filter({ hasText: QUESTION });
}

test.describe("Admin predictions table", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("names the user, the Game and the Market, with the short ids beside them", async ({ page }) => {
    const row = await openTable(page);
    await expect(row).toHaveCount(1);
    await expect(page.getByRole("columnheader")).toHaveText(["Created", "User", "Match", "Market", "Selected", "Snapshot (YES / NO)", "State", "Result", "Graded"]);
    const cells = row.getByRole("cell");
    await expect(cells.nth(1)).toContainText(USERNAME);
    await expect(cells.nth(1)).toContainText(seeded.viewerId.slice(0, 8));
    await expect(cells.nth(1).getByTitle(seeded.viewerId)).toBeVisible(); // the full id is one hover away
    await expect(cells.nth(2)).toContainText(`${AWAY} @ ${HOME}`);
    await expect(cells.nth(3)).toContainText(QUESTION);
    await expect(cells.nth(3)).toContainText(seeded.marketId.slice(0, 8));
    await expect(cells.nth(3).getByTitle(seeded.marketId)).toBeVisible();
    // Selected: the human label leads, the canonical stored value stays beside it for diagnostics.
    await expect(cells.nth(4)).toContainText(HOME);
    await expect(cells.nth(4)).toContainText("YES");
    // No email anywhere on the page.
    expect(await page.locator("main").innerText()).not.toContain("@test.local");
  });

  test("stays a compact table that scrolls sideways at narrow widths and never makes the page scroll", async ({ page }) => {
    const row = await openTable(page);
    await expect(row).toHaveCount(1);
    await page.setViewportSize({ width: 800, height: 900 });
    const scroller = page.locator("table").locator("xpath=..");
    const { sw, cw } = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(sw, "the table keeps its width and scrolls inside its own container").toBeGreaterThan(cw);
    const matchBox = (await page.getByRole("columnheader", { name: "Match" }).boundingBox())!;
    expect(matchBox.width, "Match isn't squashed").toBeGreaterThanOrEqual(80);
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(doc.sw).toBeLessThanOrEqual(doc.iw);
    // A compact row, not a card.
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.height).toBeLessThan(90);
  });

  test("a non-admin cannot open it", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(`adm-table-p-${suffix}@test.local`);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(/\/feed$/);
    await page.goto("/admin/predictions");
    await expect(page).not.toHaveURL(/\/admin\/predictions$/);
  });
});
