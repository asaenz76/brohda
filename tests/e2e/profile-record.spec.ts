/**
 * E2E: Brohda 2.1 M5 — a Member's record on the own and public Profile, through the real UI.
 * Real Picks graded through the same lifecycle the app uses; the record is derived at read time (nothing stored). Free, nonmonetary, no AI.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);
const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[] };

async function member(label: string) {
  const email = `m5-${label}-${suffix}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser");
  const { error: pe } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `M5 ${label} ${suffix}`, username: `m5${label}${suffix}`, role: "player", is_active: true });
  if (pe) throw pe;
  seeded.users.push(data.user.id);
  return { id: data.user.id as string, email, name: `M5 ${label} ${suffix}`, username: `m5${label}${suffix}` };
}

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

/** One graded Pick on its own Game, played `hoursAgo` hours ago. `result` VOID is graded void. */
async function gradedPick(userId: string, key: string, result: "CORRECT" | "INCORRECT" | "VOID", hoursAgo: number) {
  const { data: fixture } = await admin.from("fixtures").insert({ external_fixture_id: `e2e-m5-${randomUUID()}`, sport: "american_football", competition_name: "NFL", home_team_name: `M5H${key}${suffix}`, away_team_name: `M5A${key}${suffix}`, scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" }).select("id").single();
  seeded.fixtures.push(fixture!.id);
  const { data: market } = await admin.from("markets").insert({ provider: "e2e_m5", provider_market_id: `m5_${randomUUID()}`, question: `Will M5H${key}${suffix} win?`, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, price_outcome_labels: { yes: "Home win", no: "Home do not win" } }).select("id").single();
  seeded.markets.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  void post;
  const pick = await admin.rpc("set_pick", { p_user_id: userId, p_market_id: market!.id, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
  if (pick.error) throw pick.error;
  // The Game was played `hoursAgo` hours ago and the Pick is graded: the same end state the grading job leaves.
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), internal_status: "COMPLETED", home_score: 20, away_score: 10 }).eq("id", fixture!.id);
  const outcome = result === "CORRECT" ? "YES" : result === "INCORRECT" ? "NO" : null;
  const { error } = await admin.from("predictions").update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: outcome, graded_at: new Date().toISOString() }).eq("market_id", market!.id).eq("user_id", userId);
  if (error) throw error;
}

test.beforeAll(async () => {
  await admin.from("platform_settings").update({ leaderboard_min_decided_picks: 5 }).eq("id", true);
});

test.afterAll(async () => {
  for (const id of seeded.users) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  await admin.from("predictions").delete().in("market_id", seeded.markets);
  await admin.from("markets").delete().in("id", seeded.markets);
  await admin.from("fixtures").delete().in("id", seeded.fixtures);
});

test.describe("A Member's record", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test("a veteran-enough Member: raw record first, then percentage, form, streak, best streak, sport — on the public and the own profile", async ({ page }) => {
    const subject = await member("vet");
    const viewer = await member("viewer");
    // Played oldest -> newest: C, C, I, C, void, C, C, I, C  => decided 8: 6-2 (75%), last 8: 6-2, newest pick correct, best run 3.
    const seq: Array<"CORRECT" | "INCORRECT" | "VOID"> = ["CORRECT", "CORRECT", "INCORRECT", "CORRECT", "VOID", "CORRECT", "CORRECT", "INCORRECT", "CORRECT"];
    for (const [i, r] of seq.entries()) await gradedPick(subject.id, `v${i}`, r, 100 - i * 5);

    await login(page, viewer.email);
    await page.goto(`/profile/${subject.username}`);
    const card = page.locator('[data-slot="record-card"]');
    await expect(card.locator('[data-slot="record-picks"]')).toContainText("6–2");
    await expect(card.locator('[data-slot="record-picks"]')).toContainText("75% correct");
    await expect(card.locator('[data-slot="record-picks"]')).toContainText("1 void");
    await expect(card.locator('[data-slot="record-form"]')).toContainText("6–2");
    await expect(card.locator('[data-slot="record-form"]')).toContainText("Last 8");
    await expect(card.locator('[data-slot="record-streak"]')).toContainText("Last pick correct");
    await expect(card.locator('[data-slot="record-streak"]')).toContainText("Best: 3 correct in a row");
    await expect(card.locator('[data-slot="record-by-sport"]')).toContainText("NFL");
    await expect(card.locator('[data-slot="record-by-sport"]')).toContainText("6–2");
    await expect(card.locator('[data-slot="record-by-sport"]')).toContainText("8 decided");
    // The identity line above agrees with the card (same numbers, same rule).
    await expect(page.getByRole("main").getByText("75% prediction accuracy · 9 predicted")).toBeVisible();
    // Free for everyone: no paywall, no points, no levels, no money.
    await expect(card).not.toContainText(/upgrade|premium|brohda\+|points|level|badge|xp|\$/i);

    // Their own view of the same record.
    await login(page, subject.email);
    await page.goto("/profile");
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("6–2");
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("75% correct");
  });

  test("a tiny sample reads as a record, never as a percentage — in the card and in the identity line", async ({ page }) => {
    const subject = await member("tiny");
    const viewer = await member("tinyviewer");
    await gradedPick(subject.id, "t0", "CORRECT", 5);
    await login(page, viewer.email);
    await page.goto(`/profile/${subject.username}`);
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("1–0");
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("1 decided");
    await expect(page.locator('[data-slot="record-card"]')).not.toContainText("%");
    await expect(page.getByRole("main").getByText("1–0 prediction record · 1 predicted")).toBeVisible();
    await expect(page.getByRole("main").getByText(/100%/)).toHaveCount(0);
  });

  test("a new Member gets an invitation, and visitors a plain statement — no wall of zeros", async ({ page }) => {
    const fresh = await member("fresh");
    const viewer = await member("freshviewer");
    await login(page, fresh.email);
    await page.goto("/profile");
    await expect(page.locator('[data-slot="record-empty"]')).toContainText("Your record starts with your first pick.");
    await expect(page.getByText("0–0")).toHaveCount(0);
    await login(page, viewer.email);
    await page.goto(`/profile/${fresh.username}`);
    await expect(page.locator('[data-slot="record-empty"]')).toContainText("No graded picks yet.");
  });

  test("history is paged: 20 a page, Older / Newer, and a visited profile shows settled results only", async ({ page }) => {
    const subject = await member("pager");
    const viewer = await member("pagerviewer");
    for (let i = 0; i < 21; i += 1) await gradedPick(subject.id, `p${i}`, "CORRECT", 200 - i);
    await login(page, viewer.email);
    await page.goto(`/profile/${subject.username}`);
    const rows = page.getByRole("main").locator("p", { hasText: /^Correct$/ });
    await expect(rows).toHaveCount(20);
    const pager = page.locator('[data-slot="predictions-pager"]');
    await expect(pager).toContainText("Page 1");
    await pager.getByRole("link", { name: "Older" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(rows).toHaveCount(1);
    await expect(page.locator('[data-slot="predictions-pager"]').getByRole("link", { name: "Newer" })).toBeVisible();
    await expect(page.locator('[data-slot="predictions-pager"]').getByRole("link", { name: "Older" })).toHaveCount(0);
  });

  test("on a phone: the record is readable at a glance and nothing overflows", async ({ page }) => {
    const subject = await member("phone");
    const viewer = await member("phoneviewer");
    for (let i = 0; i < 6; i += 1) await gradedPick(subject.id, `m${i}`, i % 3 === 2 ? "INCORRECT" : "CORRECT", 50 - i);
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, viewer.email);
    await page.goto(`/profile/${subject.username}`);
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("4–2");
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(sw).toBeLessThanOrEqual(iw);
    // The form chips have a text equivalent for a screen reader.
    await expect(page.locator('[data-slot="record-form"] [role="img"]')).toHaveAttribute("aria-label", /Most recent first: (correct|incorrect)/);
  });
});
