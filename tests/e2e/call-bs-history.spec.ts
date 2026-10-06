/**
 * E2E: Call BS leaves a lasting, restrained record. Two real members take
 * opposing Picks, one calls BS, the other accepts, the Game is graded and the
 * resolver runs — then the record, the head-to-head and the history appear on
 * both Profiles and the Post, each reflecting only RESOLVED results. Free Call
 * BS only; prediction accuracy is never touched.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);
const A_NAME = `Andre Hist ${suffix}`;
const B_NAME = `Carlos Hist the Remarkably Long Named Rival ${suffix}`;
const A_EMAIL = `cbh-a-${suffix}@test.local`;
const B_EMAIL = `cbh-b-${suffix}@test.local`;

const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[], posts: [] as string[], A: "", B: "" };
type Game = { fixtureId: string; marketId: string; postId: string; label: string; question: string };
const games: Record<string, Game> = {};

async function createUser(email: string, displayName: string, username: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: displayName, username, role: "player", is_active: true });
  if (profileError) throw profileError;
  seeded.users.push(data.user.id);
  return data.user.id as string;
}

async function seedGame(key: string, minutesAhead: number): Promise<Game> {
  const home = `${key} Home ${suffix}`;
  const away = `${key} Away ${suffix}`;
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-cbh-${randomUUID()}`, sport: "american_football", home_team_name: home, away_team_name: away, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + minutesAhead * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  seeded.fixtures.push(fixture!.id);
  const question = `Will ${home} win?`;
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "e2e_cbh", provider_market_id: `cbh_${randomUUID()}`, question, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, price_outcome_labels: { yes: `${home} win`, no: `${home} do not win` } })
    .select("id")
    .single();
  seeded.markets.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  seeded.posts.push(post!.id);
  const game = { fixtureId: fixture!.id as string, marketId: market!.id as string, postId: post!.id as string, label: `${away} @ ${home}`, question };
  games[key] = game;
  return game;
}

async function setPick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { error } = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  if (error) throw error;
}

/** Home wins (YES) when `homeWins`: finish the Game and grade both Picks exactly as the grading job would. */
async function gradeGame(game: Game, homeWins: boolean) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeWins ? 24 : 10, away_score: homeWins ? 10 : 24 }).eq("id", game.fixtureId);
  const outcome = homeWins ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", game.marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    await admin
      .from("predictions")
      .update({ lifecycle_state: "GRADED", result: p.selected_outcome === outcome ? "CORRECT" : "INCORRECT", resolved_outcome_snapshot: outcome, graded_at: new Date().toISOString() })
      .eq("id", p.id);
  }
}

/**
 * Runs the resolver the way the scheduler would (its cron route) until THIS Market's Call BS is RESOLVED. The route can legitimately
 * answer "skipped" when another invocation holds the job's overlap lock, so one call isn't proof — what the tests need is the
 * resolved challenge, so re-invoke until it is, and fail with the resolver's own answer if it never happens.
 */
async function runResolver(page: Page, marketId: string) {
  let last = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await page.request.get("/api/cron/resolve-challenges", { headers: { authorization: "Bearer e2e-placeholder" } });
    expect(response.ok(), `resolver route status ${response.status()}`).toBe(true);
    last = await response.text();
    const { data } = await admin.from("challenges").select("status").eq("market_id", marketId).eq("status", "RESOLVED");
    if ((data ?? []).length > 0) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(`the Call BS on market ${marketId} was not resolved after 8 resolver runs; last answer: ${last}`);
}

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(iw);
}

test.beforeAll(async () => {
  await admin.from("platform_settings").update({ call_bs_enabled: true }).eq("id", true);
  seeded.A = await createUser(A_EMAIL, A_NAME, `cbha${suffix}`);
  seeded.B = await createUser(B_EMAIL, B_NAME, `cbhb${suffix}`);
  await seedGame("First", 24 * 60);
  await seedGame("Second", 24 * 60 + 5);
  // A picks YES and B picks NO on both Games (opposing sides).
  for (const g of Object.values(games)) {
    await setPick(seeded.A, g.marketId, "YES");
    await setPick(seeded.B, g.marketId, "NO");
  }
});

test.afterAll(async () => {
  // Users first (comments/notifications leave with them); resolved challenges are immutable history and can't be deleted by the service role.
  for (const id of seeded.users) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  await admin.from("predictions").delete().in("market_id", seeded.markets);
  await admin.from("posts").delete().in("id", seeded.posts);
  await admin.from("markets").delete().in("id", seeded.markets);
  await admin.from("fixtures").delete().in("id", seeded.fixtures);
});

test.describe("Call BS record, head-to-head and history", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test("before anything resolves: no record, a restrained empty state, and nothing counted for a pending or accepted Call BS", async ({ page }) => {
    await login(page, A_EMAIL);
    await page.goto("/profile");
    await expect(page.getByRole("main").getByText(/Call BS: \d/)).toHaveCount(0); // no noisy 0–0 in the identity
    await expect(page.getByRole("heading", { level: 2, name: "Call BS" })).toBeVisible();
    await expect(page.getByText("No Call BS results yet.")).toBeVisible();

    // A sends Call BS to B on the First Game: pending. B has history with nobody yet, so no head-to-head line.
    await page.goto(`/post/${games.First.postId}`);
    await expect(page.getByText(/Your Call BS record vs/)).toHaveCount(0);
    await page.getByRole("button", { name: "Call BS" }).click();
    await expect(page.getByText("Pending")).toBeVisible();
    await expect(page.getByText(/Your Call BS record vs/)).toHaveCount(0);

    // B accepts: accepted, still nothing resolved, still nothing counted.
    await login(page, B_EMAIL);
    await page.goto(`/post/${games.First.postId}`);
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("Accepted")).toBeVisible();
    await expect(page.getByText(/Your Call BS record vs/)).toHaveCount(0);
    await page.goto("/profile");
    await expect(page.getByText("No Call BS results yet.")).toBeVisible();
  });

  test("once graded and resolved: A sees 1–0, B sees 0–1, the history row links to the canonical Post, and prediction accuracy is untouched", async ({ page }) => {
    // The Home team wins -> YES -> A (who called BS, picked YES) is right.
    await gradeGame(games.First, true);
    await runResolver(page, games.First.marketId);

    await login(page, A_EMAIL);
    await page.goto("/profile");
    const main = page.getByRole("main");
    await expect(main.getByText("Call BS record: 1 win, 0 losses")).toBeAttached(); // what a screen reader hears
    await expect(main.getByText("Call BS: 1–0")).toBeVisible();
    // Prediction reputation is its own, unchanged line: 1 graded Pick, correct (the Second Game isn't graded yet).
    await expect(main.getByText("100% prediction accuracy · 1 predicted")).toBeVisible();
    await expect(main.getByText("No Call BS results yet.")).toHaveCount(0);

    const row = main.getByRole("listitem").filter({ hasText: games.First.label });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("vs");
    await expect(row).toContainText("Won");
    // Read in the Game's own language: the Market's compact label, my visible Pick (YES = the home team) and the opponent's.
    await expect(row).toContainText("Moneyline");
    await expect(row).toContainText(`You picked ${games.First.label.split(" @ ")[1]}`);
    await expect(row).toContainText(`picked ${games.First.label.split(" @ ")[0]}`);
    await expect(row).not.toContainText(/do not win|\bYES\b|\bNO\b/);
    await expect(row.getByRole("link", { name: `Open the Game: ${games.First.label}` })).toHaveAttribute("href", `/post/${games.First.postId}`);
    await row.getByRole("link", { name: `Open the Game: ${games.First.label}` }).click();
    await expect(page).toHaveURL(new RegExp(`/post/${games.First.postId}$`));

    await login(page, B_EMAIL);
    await page.goto("/profile");
    await expect(page.getByRole("main").getByText("Call BS record: 0 wins, 1 loss")).toBeAttached();
    await expect(page.getByRole("main").getByText("Call BS: 0–1")).toBeVisible();
    const bRow = page.getByRole("main").getByRole("listitem").filter({ hasText: games.First.label });
    await expect(bRow).toContainText("Lost");
    await expect(bRow).toContainText(`You picked ${games.First.label.split(" @ ")[0]}`); // B's own Profile: B picked NO = the away team
    await expect(page.getByRole("main").getByText("0 wins")).toBeAttached();
  });

  test("head-to-head: shown on the other person's Profile and beside Call BS on the next Game — and only resolved results count", async ({ page }) => {
    await login(page, A_EMAIL);
    // On B's Profile: "Your Call BS record vs <B>: 1–0".
    await page.goto(`/profile/cbhb${suffix}`);
    await expect(page.getByRole("main").getByText(`Your Call BS record against ${B_NAME}: 1 win, 0 losses`)).toBeAttached();
    await expect(page.getByRole("main").getByText(`Your Call BS record vs ${B_NAME}: 1–0`)).toBeVisible();
    // B's history, read by A, says "Picked …" (B's pick) — never "You picked". (Scoped to the Call BS section: the Predictions tab below has its own wording.)
    const section = page.getByRole("region", { name: "Call BS" });
    await expect(section).toContainText(`Picked ${games.First.label.split(" @ ")[0]}`);
    await expect(section).not.toContainText("You picked");

    // On the Second Game, beside Call BS: the previous 1–0 (not the pending one).
    await page.goto(`/post/${games.Second.postId}`);
    await expect(page.getByText(`Your Call BS record vs ${B_NAME}: 1–0`)).toBeVisible();
    await page.getByRole("button", { name: "Call BS" }).click();
    await expect(page.getByText("Pending")).toBeVisible();
    await expect(page.getByText(`Your Call BS record vs ${B_NAME}: 1–0`)).toBeVisible(); // pending isn't counted

    await login(page, B_EMAIL);
    await page.goto(`/post/${games.Second.postId}`);
    await expect(page.getByText(/Your Call BS record vs .*: 0–1/)).toBeVisible(); // B's mirror image
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("Accepted")).toBeVisible();
    await expect(page.getByText(/Your Call BS record vs .*: 0–1/)).toBeVisible(); // accepted-but-ungraded isn't counted either
  });

  test("a newly resolved challenge is reflected immediately: A goes 2–0, B 0–2, newest first", async ({ page }) => {
    await gradeGame(games.Second, true); // A right again
    await runResolver(page, games.Second.marketId);

    await login(page, A_EMAIL);
    await page.goto("/profile");
    await expect(page.getByRole("main").getByText("Call BS: 2–0")).toBeVisible();
    await expect(page.getByRole("main").getByText("100% prediction accuracy · 2 predicted")).toBeVisible();
    const rows = page.getByRole("main").getByRole("list").filter({ has: page.getByRole("link", { name: /Open the Game/ }) }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(games.Second.label); // resolved last, listed first
    await expect(rows.last()).toContainText(games.First.label);

    await page.goto(`/profile/cbhb${suffix}`);
    await expect(page.getByRole("main").getByText(`Your Call BS record vs ${B_NAME}: 2–0`)).toBeVisible();

    await login(page, B_EMAIL);
    await page.goto("/profile");
    await expect(page.getByRole("main").getByText("Call BS: 0–2")).toBeVisible();

    // The resolver running again changes nothing.
    await page.request.get("/api/cron/resolve-challenges", { headers: { authorization: "Bearer e2e-placeholder" } });
    await page.reload();
    await expect(page.getByRole("main").getByText("Call BS: 0–2")).toBeVisible();
  });

  test("no ranking furniture: no percentage, rank, XP, tier, badge or leaderboard anywhere near the record", async ({ page }) => {
    await login(page, A_EMAIL);
    await page.goto("/profile");
    const text = await page.getByRole("main").innerText();
    expect(text).not.toMatch(/call bs[^\n]*%|\b(rank|xp|tier|badge|trophy|achievement|elo|rating|streak)\b/i);
    expect(text).not.toMatch(/leaderboard/i);
    // Money never appears in the Call BS record (no stakes, wins in dollars, profit).
    expect(text).not.toMatch(/\$\d|profit|stake|payout/i);
  });

  for (const width of [375, 360, 320]) {
    test(`${width}px: the history is stacked social rows — long names wrap, nothing scrolls sideways`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await ctx.newPage();
      await login(page, A_EMAIL);
      await page.goto("/profile");
      await expect(page.getByRole("main").getByText("Call BS: 2–0")).toBeVisible();
      await expectNoHorizontalScroll(page, `${width} own profile`);
      await page.goto(`/profile/cbhb${suffix}`);
      await expect(page.getByRole("main").getByText(/Your Call BS record vs/)).toBeVisible();
      await expectNoHorizontalScroll(page, `${width} opponent profile`);
      expect(await page.locator("table").count()).toBe(0);
      await ctx.close();
    });
  }
});
