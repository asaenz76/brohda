/**
 * E2E: Brohda 2.1 M7 — a brand-new sports fan, from arrival to first Pick to the result, through the real UI.
 *   A. signed-out visitor taps a side -> sign-up (names the Game) -> back on the Game with "You chose X" -> explicit Confirm -> exactly one Pick (nothing is saved before Confirm), at 375 px and desktop;
 *   B. direct sign-up -> feed -> first Pick ("Pick made. It counts toward your Record…") -> profile says the Record starts when the game ends -> the Pick persists across reload and on the Post;
 *   C. the first Pick graded by the REAL grading job -> the "result is in" notification -> the result page shows the Record and a way to the next Pick; the finished Game's conversation talks about the result.
 * Free, nonmonetary, no AI. Games are seeded straight into the canonical tables, exactly as the other specs do.
 * Own Playwright project: it needs the production-shaped Pick policy (optional Confidence, the two-step composer), which is global state, so no other spec may run beside it.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 6);
const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[], posts: [] as string[] };

interface Game { fixtureId: string; marketId: string; postId: string; home: string; away: string }

async function seedGame(key: string, minutesAhead = 40): Promise<Game> {
  const home = `${key}Home${suffix}`;
  const away = `${key}Away${suffix}`;
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-m7-${randomUUID()}`, sport: "american_football", home_team_name: home, away_team_name: away, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + minutesAhead * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  seeded.fixtures.push(fixture!.id);
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "e2e_m7", provider_market_id: `m7_${randomUUID()}`, question: `Will ${home} win?`, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, price_outcome_labels: { yes: "Home win", no: "Home do not win" } })
    .select("id")
    .single();
  seeded.markets.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  seeded.posts.push(post!.id);
  return { fixtureId: fixture!.id, marketId: market!.id, postId: post!.id, home, away };
}

/** The one-screen sign-up (M8): email, password, username, Terms, one submit. */
async function registerThroughWizard(page: Page, who: { label: string }) {
  const email = `m7-${who.label}-${suffix}@test.local`;
  const username = `m7${who.label.replace(/[^a-z0-9]/gi, "")}${suffix}`;
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#username").fill(username);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /join/i }).click();
  return { email, username };
}

async function userIdFor(username: string): Promise<string> {
  const { data } = await admin.from("user_profiles").select("id").eq("username", username).single();
  seeded.users.push(data!.id);
  return data!.id;
}

async function pickRows(userId: string, marketId: string) {
  const { data } = await admin.from("predictions").select("selected_outcome, lifecycle_state").eq("user_id", userId).eq("market_id", marketId);
  return data ?? [];
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(iw);
}

async function sqlReplica(text: string) {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(text);
    await client.query("commit");
  } finally {
    await client.end();
  }
}
const resetPolicy = () => sqlReplica("update public.platform_settings set confidence_mandatory_since = null, confidence_optional_picks_enabled = false, confidence_optional_first_enabled_at = null, confidence_two_step_composer_enabled = false where id = true");

let saved: Record<string, unknown> | null = null;
test.beforeAll(async () => {
  saved = (await admin.from("platform_settings").select("confidence_enabled, confidence_backed_picks_enabled, confidence_allowed_stakes, confidence_baseline, pick_lock_minutes_before_kickoff, call_bs_enabled, registration_enabled, social_prediction_enabled").eq("id", true).single()).data;
  await resetPolicy();
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true, registration_enabled: true, social_prediction_enabled: true }).eq("id", true);
  // Production-shaped Pick policy: the mandatory cutover is set, and optional Picks and the two-step composer are switched on through the audited functions.
  const { data: owner } = await admin.auth.admin.createUser({ email: `m7-owner-${suffix}@test.local`, password: PASSWORD, email_confirm: true });
  seeded.users.push(owner.user!.id);
  await admin.from("user_profiles").insert({ id: owner.user!.id, display_name: `M7 owner ${suffix}`, username: `m7owner${suffix}`, role: "super_admin", is_active: true });
  await admin.rpc("confidence_bootstrap_member", { p_member_id: owner.user!.id });
  expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: owner.user!.id, p_config: { confidence_mandatory: true } })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: owner.user!.id, p_enabled: true })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_two_step_composer", { p_admin_id: owner.user!.id, p_enabled: true })).error).toBeNull();
});

test.afterAll(async () => {
  await resetPolicy();
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
  for (const id of seeded.users) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  await admin.from("predictions").delete().in("market_id", seeded.markets);
  await admin.from("posts").delete().in("id", seeded.posts);
  await admin.from("markets").delete().in("id", seeded.markets);
  await admin.from("fixtures").delete().in("id", seeded.fixtures);
});

test.describe("A new member's first Pick", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  for (const viewport of [{ name: "phone (375 px)", width: 375, height: 812 }, { name: "desktop", width: 1280, height: 900 }]) {
    test(`signed-out intent on ${viewport.name}: tap a side -> sign up -> back on the Game -> confirm -> one Pick`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const game = await seedGame(`intent${viewport.width}`);
      await page.context().clearCookies();
      await page.goto("/");
      const card = page.locator("article").filter({ hasText: game.home }).first();
      await expect(card).toBeVisible();

      // The visitor taps the side they believe in. This is an intent click, not a Pick.
      await card.getByRole("link", { name: new RegExp(`^Pick ${game.home}.*create an account`) }).click();
      await expect(page).toHaveURL(new RegExp(`/register\\?next=%2Fpost%2F${game.postId}%3Fpick%3DYES$`));
      // The sign-up screen says why they are here: the Game.
      await expect(page.locator('[data-slot="auth-game-context"]')).toContainText(`${game.away} @ ${game.home}`);
      // M8: and the side they tapped, worded as intent — nothing is saved yet.
      await expect(page.locator('[data-slot="auth-game-choice"]')).toHaveText(`You chose ${game.home}.`);
      await expect(page.locator('[data-slot="auth-game-context"]')).toContainText("Create your account, then confirm your pick.");
      await expectNoHorizontalScroll(page, "register");

      const { username } = await registerThroughWizard(page, { label: `intent${viewport.width}` });
      // After sign-up: straight back on the Game, with the tapped side as a question.
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}\\?pick=YES$`));
      const userId = await userIdFor(username);
      const intent = page.locator('[data-slot="pick-intent"]');
      await expect(intent).toContainText(`You chose ${game.home}.`);
      // Nothing was saved by getting here.
      expect(await pickRows(userId, game.marketId)).toEqual([]);
      // The Pick control is on the Post itself (no hunting for the Game in the feed).
      await expect(page.locator('[data-slot="post-pick"] [data-slot="team-choice"]')).toHaveCount(2);
      await expectNoHorizontalScroll(page, "post with intent");

      // Keyboard: the explicit confirm is a real, named button.
      const confirm = page.getByRole("button", { name: `Confirm your pick: ${game.home}` });
      await confirm.focus();
      await expect(confirm).toBeFocused();
      await confirm.click();
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}$`));
      await expect(page.locator('[data-slot="pick-intent"]')).toHaveCount(0);
      await expect(page.locator('[data-slot="post-pick"] [data-slot="pick-made"]')).toContainText("Pick made. It counts toward your Record when the game ends.");
      await expect(page.locator('[data-slot="post-pick"] [data-slot="team-choice"][aria-pressed="true"]')).toHaveCount(1);
      // Exactly one Pick, on the side they tapped.
      expect(await pickRows(userId, game.marketId)).toEqual([{ selected_outcome: "YES", lifecycle_state: "PENDING" }]);
      // The page no longer tells someone who has picked to "make your pick".
      await expect(page.locator("main")).not.toContainText("Make your prediction in the feed");
      await expectNoHorizontalScroll(page, "post after pick");
    });
  }

  test("an unsafe or nonsense hint does nothing: no confirm, no Pick, no redirect", async ({ page }) => {
    const game = await seedGame("hint");
    const { data: member } = await admin.auth.admin.createUser({ email: `m7-hint-${suffix}@test.local`, password: PASSWORD, email_confirm: true });
    seeded.users.push(member.user!.id);
    await admin.from("user_profiles").insert({ id: member.user!.id, display_name: `M7 hint ${suffix}`, username: `m7hint${suffix}`, role: "player", is_active: true });
    await admin.rpc("confidence_bootstrap_member", { p_member_id: member.user!.id });
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(`m7-hint-${suffix}@test.local`);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(/\/feed$/);
    for (const bad of ["MAYBE", "%00", "yes%20no", "https://evil.example/", "yes", "YES%20", "YES&pick=NO"]) {
      await page.goto(`/post/${game.postId}?pick=${bad}`);
      await expect(page).toHaveURL(new RegExp(`/post/${game.postId}`));
      await expect(page.locator('[data-slot="pick-intent"]')).toHaveCount(0);
    }
    expect(await pickRows(member.user!.id, game.marketId)).toEqual([]);
    // A Post id that is not a UUID is the honest not-found state, never a server error.
    for (const badId of ["not-a-real-id", "%2e%2e%2f", "00000000-0000-0000-0000-000000000000"]) {
      const res = await page.goto(`/post/${badId}?pick=YES`);
      expect(res?.status(), badId).toBe(404);
    }
    // A hint can never choose for someone who has already picked: the control shows their own Pick, not the hint.
    await page.goto(`/post/${game.postId}`);
    await page.locator('[data-slot="post-pick"]').getByRole("button", { name: `Pick ${game.home} to win` }).click();
    await expect(page.locator('[data-slot="pick-made"]')).toBeVisible();
    await page.goto(`/post/${game.postId}?pick=NO`);
    await expect(page.locator('[data-slot="pick-intent"]')).toHaveCount(0);
  });

  test("direct sign-up: feed -> first Pick says what happened -> the Record starts when the game ends -> it persists", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const game = await seedGame("direct", 35);
    await page.context().clearCookies();
    await page.goto("/register");
    // No Game intent, so no Game banner.
    await expect(page.locator('[data-slot="auth-game-context"]')).toHaveCount(0);
    const { username } = await registerThroughWizard(page, { label: "direct" });
    await expect(page).toHaveURL(/\/feed$/);
    const userId = await userIdFor(username);

    const card = page.locator("article").filter({ hasText: game.home }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText("Make your pick to see how everyone else picked.")).toBeVisible();
    await card.getByRole("button", { name: `Pick ${game.home} to win` }).click();

    // The first Pick is acknowledged, and the crowd line no longer tells them to "make your pick".
    await expect(card.locator('[data-slot="pick-made"]')).toContainText("Pick made. It counts toward your Record when the game ends.");
    await expect(card.getByText("You can change your pick until it locks.")).toBeVisible();
    await expect(card.getByText("Your pick is in. You'll see how everyone else picked once it locks or you add Confidence.")).toBeVisible();
    await expect(card.getByText("Make your pick to see how everyone else picked.")).toHaveCount(0);
    // Confidence stays optional: nothing was required to make the Pick.
    await expect(card.getByText("(optional)")).toBeVisible();
    expect(await pickRows(userId, game.marketId)).toHaveLength(1);

    // The next step is offered ("Say why"), without inventing a mechanic.
    await expect(card.locator('[data-slot="conversation-next-step"]')).toContainText("Say why");

    // The Record explains itself: it starts when this game ends.
    await page.goto("/profile");
    await expect(page.locator('[data-slot="record-empty"]')).toContainText("Your Record starts when your first game ends. Your pick is waiting for a result.");
    await expectNoHorizontalScroll(page, "profile");

    // Away and back: the Pick persists in the feed and on the Post.
    await page.goto("/feed");
    await expect(page.locator("article").filter({ hasText: game.home }).first().locator('[data-slot="team-choice"][aria-pressed="true"]')).toHaveCount(1);
    await page.goto(`/post/${game.postId}`);
    await expect(page.locator('[data-slot="post-pick"] [data-slot="team-choice"][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="empty-conversation"]')).toContainText(`Say why you picked ${game.home}.`);
  });

  test("the first result, through the real grading job: notification -> result page with the Record and the next Pick", async ({ page }) => {
    const game = await seedGame("result", 60);
    const email = `m7-result-${suffix}@test.local`;
    const { data: member } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    const userId = member.user!.id;
    seeded.users.push(userId);
    await admin.from("user_profiles").insert({ id: userId, display_name: `M7 result ${suffix}`, username: `m7result${suffix}`, role: "player", is_active: true });
    await admin.rpc("confidence_bootstrap_member", { p_member_id: userId });
    const { error } = await admin
      .rpc("set_pick", { p_user_id: userId, p_market_id: game.marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
      .single();
    if (error) throw error;

    // The Game ends (home wins) and the REAL grading job runs.
    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 27, away_score: 13 }).eq("id", game.fixtureId);
    let graded = false;
    for (let attempt = 0; attempt < 10 && !graded; attempt += 1) {
      const response = await page.request.get("/api/cron/grade-predictions", { headers: { authorization: "Bearer e2e-placeholder" } });
      expect(response.ok(), `grading route status ${response.status()}`).toBe(true);
      const { data } = await admin.from("predictions").select("lifecycle_state, result").eq("user_id", userId).eq("market_id", game.marketId).single();
      graded = data?.lifecycle_state === "GRADED";
      if (!graded) await page.waitForTimeout(1000);
    }
    expect(graded, "the grading job graded the Pick").toBe(true);
    const { data: notification } = await admin.from("notifications").select("id, type, post_id, market_id, read_at").eq("user_id", userId).eq("type", "prediction_graded").single();
    expect(notification).toMatchObject({ post_id: game.postId, market_id: game.marketId, read_at: null });

    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(/\/feed$/);

    // The notification badge and the notification itself.
    await page.goto("/notifications");
    await page.getByRole("link", { name: /You were right|Result is in/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/markets/${game.marketId}$`));
    await expect(page.getByText("Result: Correct")).toBeVisible();

    // The result is connected to their Record, and the next Pick is one tap away.
    const next = page.locator('[data-slot="result-next-steps"]');
    await expect(next.locator('[data-slot="result-record"]')).toContainText("Your Record is 1–0.");
    await expect(next.getByRole("link", { name: "See your Record" })).toHaveAttribute("href", "/profile");
    await next.getByRole("link", { name: "Pick another game" }).click();
    await expect(page).toHaveURL(/\/feed$/);
    expect((await admin.from("notifications").select("read_at").eq("id", notification!.id).single()).data?.read_at).not.toBeNull();

    // The Game's own page: the result block, and a conversation that talks about the RESULT (the Game is over).
    await page.goto(`/post/${game.postId}`);
    await expect(page.getByText(`Final: ${game.away} 13 — ${game.home} 27`)).toBeVisible();
    await expect(page.locator('[data-slot="post-pick"]')).toContainText("You picked");
    await expect(page.locator('[data-slot="result-next-steps"] [data-slot="result-record"]')).toContainText("1–0");
    await expect(page.locator('[data-slot="empty-conversation"]')).toContainText("Talk about the result.");
    await expect(page.locator("main")).not.toContainText(`Say why you picked ${game.home}`);
    // The profile now has a Record (the empty-state wording is gone).
    await page.goto("/profile");
    await expect(page.locator('[data-slot="record-picks"]')).toContainText("1–0");
    await expect(page.locator('[data-slot="record-empty"]')).toHaveCount(0);
  });
});
