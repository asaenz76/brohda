/**
 * E2E: Brohda 2.1 M6 — the weekly leaderboard through the real UI.
 * Real Picks (made through set_pick, then graded to the end state the grading job leaves) on Games played this week; the board is derived at read time from them. Free, nonmonetary, no AI.
 * Own project (it flips leaderboard_enabled, which decides whether every signed-in Member has a Leaderboard entry), and it isolates itself from every other suite's Members by raising the weekly minimum to 12
 * through the real Super Admin card — only the Members seeded here have that many decided picks this week.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 6);
const MIN = 12;
const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[] };
const GAMES = 26;

interface Person { id: string; email: string; name: string; username: string }

async function person(label: string, role: "player" | "super_admin" = "player"): Promise<Person> {
  const email = `m6-${label}-${suffix}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser");
  const name = `M6 ${label} ${suffix}`;
  const username = `m6${label}${suffix}`;
  const { error: pe } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: name, username, role, is_active: true });
  if (pe) throw pe;
  seeded.users.push(data.user.id);
  return { id: data.user.id, email, name, username };
}

async function login(page: Page, email: string, landing: RegExp = /\/feed$/) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(landing);
}

/** `GAMES` Games played earlier THIS week (Costa Rica's Monday-to-Monday week), each with a Moneyline Market. */
async function seedGames() {
  const { data } = await admin.rpc("platform_week_bounds", { p_at: new Date().toISOString() });
  const weekStart = new Date((data as Array<{ week_start: string }>)[0].week_start).getTime();
  const now = Date.now();
  const played = weekStart + Math.max(60_000, Math.floor((now - weekStart) / 2)); // inside this week, and already over
  for (let g = 0; g < GAMES; g += 1) {
    const { data: fixture, error } = await admin.from("fixtures").insert({ external_fixture_id: `e2e-m6-${randomUUID()}`, sport: "american_football", competition_name: "NFL", home_team_name: `M6H${g}${suffix}`, away_team_name: `M6A${g}${suffix}`, scheduled_start_utc: new Date(now + 86_400_000).toISOString(), internal_status: "NOT_STARTED" }).select("id").single();
    if (error) throw error;
    seeded.fixtures.push(fixture!.id);
    const { data: market } = await admin.from("markets").insert({ provider: "e2e_m6", provider_market_id: `m6_${randomUUID()}`, question: `Will M6H${g}${suffix} win?`, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, price_outcome_labels: { yes: "Home win", no: "Home do not win" } }).select("id").single();
    seeded.markets.push(market!.id);
  }
  return played;
}

/** `correct` + `incorrect` decided picks for a Member, on the first Games, graded the way the grading job leaves them. */
async function pickRecord(userId: string, correct: number, incorrect: number, playedAt: number) {
  const results = [...Array(correct).fill("CORRECT"), ...Array(incorrect).fill("INCORRECT")] as Array<"CORRECT" | "INCORRECT">;
  for (const [i, result] of results.entries()) {
    const marketId = seeded.markets[i];
    const pick = await admin.rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
    if (pick.error) throw pick.error;
    const { error } = await admin.from("predictions").update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: result === "CORRECT" ? "YES" : "NO", graded_at: new Date().toISOString() }).eq("market_id", marketId).eq("user_id", userId);
    if (error) throw error;
  }
  void playedAt;
}

async function playGames(playedAt: number) {
  const { error } = await admin.from("fixtures").update({ scheduled_start_utc: new Date(playedAt).toISOString(), internal_status: "COMPLETED", home_score: 20, away_score: 10 }).in("id", seeded.fixtures);
  if (error) throw error;
}

const setPolicy = (patch: Record<string, unknown>) => admin.from("platform_settings").update(patch).eq("id", true);
const reset = () => setPolicy({ leaderboard_enabled: false, leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: 20 });

test.beforeAll(reset);
test.afterAll(async () => {
  await reset();
  for (const id of seeded.users) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  await admin.from("predictions").delete().in("market_id", seeded.markets);
  await admin.from("markets").delete().in("id", seeded.markets);
  await admin.from("fixtures").delete().in("id", seeded.fixtures);
});

test.describe("The weekly leaderboard", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  const people = {} as Record<"ana" | "fer" | "beto" | "cami" | "eli" | "dani" | "staff", Person>;

  test("is invisible while it is off: no navigation entry, and /leaderboard still sends a visitor to their profile", async ({ page }) => {
    people.dani = await person("dani");
    await login(page, people.dani.email);
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Leaderboard" })).toHaveCount(0);
    await page.goto("/leaderboard");
    await expect(page).toHaveURL(/\/profile$/);
  });

  test("a Super Admin turns it on and sets the minimum through one audited card; nobody's rank can be set by hand", async ({ page }) => {
    people.staff = await person("staff", "super_admin");
    await login(page, people.staff.email, /\/(feed|admin\/.*)$/);
    await page.goto("/admin/settings/brohda");
    const card = page.locator('[data-slot="leaderboard-policy"]');
    await expect(card.getByRole("heading", { name: "Weekly leaderboard" })).toBeVisible();
    // The card controls policy only: one switch and two numbers (the minimum, the list size). There is no control that sets a Member's rank, score or record.
    await expect(card.locator("input")).toHaveCount(3);
    await expect(card.getByRole("textbox")).toHaveCount(0);
    await card.getByLabel("Show the weekly leaderboard").check();
    await card.getByLabel("Decided Picks needed this week to be ranked").fill(String(MIN));
    await card.getByLabel("Members listed").fill("50");
    await card.getByRole("button", { name: "Save leaderboard" }).click();
    await expect(card.getByText("Saved.")).toBeVisible();
    const { data } = await admin.from("platform_settings").select("leaderboard_enabled, leaderboard_weekly_min_decided_picks, leaderboard_top_n").eq("id", true).single();
    expect(data).toEqual({ leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: MIN, leaderboard_top_n: 50 });
    const { data: logs } = await admin.from("audit_logs").select("after, actor_id").eq("action", "settings.leaderboard_policy_updated").order("created_at", { ascending: false }).limit(1);
    expect(logs?.[0].actor_id).toBe(people.staff.id);
    expect(logs?.[0].after).toEqual({ leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: MIN, leaderboard_top_n: 50 });
  });

  test("ranks real records: accuracy first, more correct breaks a tie, identical records share a rank, staff are never ranked", async ({ page }) => {
    const playedAt = await seedGames();
    people.ana = await person("ana");
    people.fer = await person("fer");
    people.beto = await person("beto");
    people.cami = await person("cami");
    people.eli = await person("eli");
    // 12–0 twice (a tie), 12–2 (86%), 13–5 (72%), 12–12 (50%), and a staff account with the best record of all (never ranked); Dani has only 3 picks.
    await pickRecord(people.ana.id, 12, 0, playedAt);
    await pickRecord(people.fer.id, 12, 0, playedAt);
    await pickRecord(people.beto.id, 12, 2, playedAt);
    await pickRecord(people.cami.id, 13, 5, playedAt);
    await pickRecord(people.eli.id, 12, 12, playedAt);
    await pickRecord(people.staff.id, 20, 0, playedAt);
    await pickRecord(people.dani.id, 3, 0, playedAt);
    await playGames(playedAt);

    await login(page, people.beto.email);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: "Leaderboard" }).click();
    await expect(page).toHaveURL(/\/leaderboard$/);
    await expect(page.getByRole("heading", { level: 1, name: "Leaderboard" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Weekly leaderboard" })).toBeVisible();
    await expect(page.locator('[data-slot="leaderboard-week"]')).toContainText(/[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2} · .+ left · resets Monday 12:00 AM CST/);
    await expect(page.locator('[data-slot="leaderboard-rule"]')).toContainText(`${MIN} decided Picks this week to qualify. Ranked by accuracy, then most correct.`);

    const row = (p: Person) => page.locator('[data-slot="leaderboard-row"]').filter({ hasText: p.name });
    await expect(row(people.ana)).toContainText("12–0");
    await expect(row(people.ana)).toContainText("100%");
    await expect(row(people.beto)).toContainText("12–2");
    await expect(row(people.beto)).toContainText("86%");
    await expect(row(people.cami)).toContainText("13–5");
    await expect(row(people.cami)).toContainText("72%");
    await expect(row(people.eli)).toContainText("12–12");
    await expect(row(people.eli)).toContainText("50%");

    const rank = async (p: Person) => Number(await row(p).getAttribute("data-rank"));
    const [ra, rf, rb, rc, re] = [await rank(people.ana), await rank(people.fer), await rank(people.beto), await rank(people.cami), await rank(people.eli)];
    expect(ra).toBe(rf); // identical 12–0 records share a rank ...
    await expect(row(people.ana)).toContainText("Tied");
    await expect(row(people.fer)).toContainText("Tied");
    expect(rf).toBeLessThan(rb); // ... and the tie is ahead of 12–2, then 13–5, then 12–12 (a tied pair takes two places, so the next rank skips one)
    expect(rb).toBe(ra + 2);
    expect(rb).toBeLessThan(rc);
    expect(rc).toBeLessThan(re);
    // A Member's own row is marked, and their standing card agrees with it.
    await expect(row(people.beto)).toContainText("You");
    await expect(page.locator('[data-slot="leaderboard-me"]')).toContainText(`#${rb}`);
    await expect(page.locator('[data-slot="leaderboard-me"]')).toContainText("12–2");
    await expect(page.locator('[data-slot="leaderboard-me"]')).toContainText("qualified");
    // The staff account is not on the board, however good its record.
    await expect(page.locator('[data-slot="leaderboard-row"]').filter({ hasText: people.staff.name })).toHaveCount(0);
    // Real outcomes only: no points, no prizes, no money.
    await expect(page.locator('[data-slot="weekly-leaderboard"]')).not.toContainText(/\bpoints?\b|\bxp\b|prize|reward|earn|\bbets?\b|betting|wager|\$|badge/i);
  });

  test("the board links to profiles, and a profile's 'This week' agrees with the board", async ({ page }) => {
    await login(page, people.beto.email);
    await page.goto("/leaderboard");
    await page.locator('[data-slot="leaderboard-row"]').filter({ hasText: people.cami.name }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/profile/${people.cami.username}$`));
    await expect(page.locator('[data-slot="record-week"]')).toContainText("13–5");
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("13–5");
  });

  test("is for signed-in Members only: a signed-out visitor is sent to log in", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/leaderboard");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('[data-slot="weekly-leaderboard"]')).toHaveCount(0);
  });

  test("a Member below the minimum sees progress, not a rank; staff are told they are not ranked", async ({ page }) => {
    await login(page, people.dani.email);
    await page.goto("/leaderboard");
    const me = page.locator('[data-slot="leaderboard-me"]');
    await expect(me).toHaveAttribute("data-state", "unqualified");
    await expect(me).toContainText(`3 of ${MIN} Picks needed to qualify`);
    await expect(me).toContainText(`You need ${MIN - 3} more Picks`);
    await expect(me).toContainText("3–0");
    await expect(me).toContainText("Not ranked yet");
    await expect(page.locator('[data-slot="leaderboard-row"]').filter({ hasText: people.dani.name })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Make a Pick" })).toBeVisible();

    await login(page, people.staff.email, /\/(feed|admin\/.*)$/);
    await page.goto("/leaderboard");
    await expect(page.locator('[data-slot="leaderboard-me"]')).toContainText("Staff and deactivated accounts aren't ranked.");
  });

  test("a Member outside the top N still sees their own position, record and the total", async ({ page }) => {
    await setPolicy({ leaderboard_top_n: 3 });
    await login(page, people.eli.email);
    await page.goto("/leaderboard");
    await expect(page.locator('[data-slot="leaderboard-row"]')).toHaveCount(3);
    await expect(page.locator('[data-slot="leaderboard-me"]')).toContainText("12–12");
    await expect(page.locator('[data-slot="leaderboard-me"]')).toContainText("50%");
    await expect(page.locator('[data-slot="leaderboard-outside"]')).toContainText(/#\d+ of \d+ ranked this week, below the top 3 shown\./);
    await setPolicy({ leaderboard_top_n: 50 });
  });

  test("works on a phone: the entry is in the Menu, nothing overflows, the list is a labelled list", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, people.cami.email);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("link", { name: "Leaderboard" }).click();
    await expect(page).toHaveURL(/\/leaderboard$/);
    await expect(page.getByRole("list", { name: /Weekly leaderboard, top \d+/ })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await expect(page.locator('[data-slot="leaderboard-me"]')).toContainText("13–5");
  });

  test("turning it off removes the entry and the page, and changes no one's history", async ({ page }) => {
    const before = await admin.from("predictions").select("id", { count: "exact", head: true }).in("market_id", seeded.markets);
    await setPolicy({ leaderboard_enabled: false });
    await login(page, people.cami.email);
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Leaderboard" })).toHaveCount(0);
    await page.goto("/leaderboard");
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("13–5"); // the record is still there
    const after = await admin.from("predictions").select("id", { count: "exact", head: true }).in("market_id", seeded.markets);
    expect(after.count).toBe(before.count);
  });
});
