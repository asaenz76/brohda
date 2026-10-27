/**
 * E2E: Brohda 2.1 M4 — the competitive social loop through the real UI.
 * Pick a side -> talk -> Call BS (inside the argument) -> accept -> result -> record, all on ONE canonical Post, as real Members see it.
 * Free, nonmonetary; no AI, no network. Needs the local Supabase stack, as every E2E spec does.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedPrediction } from "./helpers/predict";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);

const seeded = { users: [] as string[], fixtures: [] as string[], markets: [] as string[], posts: [] as string[] };
type Game = { fixtureId: string; marketId: string; postId: string; home: string; away: string };

async function createUser(label: string) {
  const email = `m4-${label}-${suffix}@test.local`;
  const displayName = `${label[0].toUpperCase()}${label.slice(1)}${suffix}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: displayName, username: `m4${label}${suffix}`, role: "player", is_active: true });
  if (profileError) throw profileError;
  seeded.users.push(data.user.id);
  return { id: data.user.id as string, email, displayName };
}

async function seedGame(key: string, minutesAhead = 24 * 60): Promise<Game> {
  const home = `${key}Home${suffix}`;
  const away = `${key}Away${suffix}`;
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-m4-${randomUUID()}`, sport: "american_football", home_team_name: home, away_team_name: away, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + minutesAhead * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  seeded.fixtures.push(fixture!.id);
  const { data: market } = await admin
    .from("markets")
    .insert({ provider: "e2e_m4", provider_market_id: `m4_${randomUUID()}`, question: `Will ${home} win?`, status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {}, price_outcome_labels: { yes: `${home} win`, no: `${home} do not win` } })
    .select("id")
    .single();
  seeded.markets.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  seeded.posts.push(post!.id);
  return { fixtureId: fixture!.id, marketId: market!.id, postId: post!.id, home, away };
}

async function setPick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { error } = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  if (error) throw error;
}

async function comment(postId: string, userId: string, body: string) {
  const { error } = await admin.rpc("add_post_comment", { p_post_id: postId, p_user_id: userId, p_body: body, p_parent_comment_id: null }).single();
  if (error) throw error;
}

async function gradeGame(game: Game, homeWins: boolean) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeWins ? 24 : 10, away_score: homeWins ? 10 : 24 }).eq("id", game.fixtureId);
  const outcome = homeWins ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", game.marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    await admin.from("predictions").update({ lifecycle_state: "GRADED", result: p.selected_outcome === outcome ? "CORRECT" : "INCORRECT", resolved_outcome_snapshot: outcome, graded_at: new Date().toISOString() }).eq("id", p.id);
  }
}

/** Runs the lifecycle job through its cron route until THIS Market's Call BS reaches `status` (the route may answer "skipped" while another invocation holds its lock). */
async function runLifecycle(page: Page, marketId: string, status: "RESOLVED" | "EXPIRED") {
  let last = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await page.request.get("/api/cron/resolve-challenges", { headers: { authorization: "Bearer e2e-placeholder" } });
    expect(response.ok(), `lifecycle route status ${response.status()}`).toBe(true);
    last = await response.text();
    const { data } = await admin.from("challenges").select("status").eq("market_id", marketId).eq("status", status);
    if ((data ?? []).length > 0) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(`no ${status} Call BS on market ${marketId} after 8 runs; last answer: ${last}`);
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
  await admin.from("platform_settings").update({ call_bs_enabled: true, pick_lock_minutes_before_kickoff: 10 }).eq("id", true);
});

test.afterAll(async () => {
  for (const id of seeded.users) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
  await admin.from("predictions").delete().in("market_id", seeded.markets);
  await admin.from("posts").delete().in("id", seeded.posts);
  await admin.from("markets").delete().in("id", seeded.markets);
  await admin.from("fixtures").delete().in("id", seeded.fixtures);
});

test.describe("The competitive social loop", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  test("pick, talk, call BS inside the argument, accept, result — each step visible to both Members on one Post", async ({ page }) => {
    const g = await seedGame("Loop");
    const maria = await createUser("maria");
    const sam = await createUser("sam");
    const zed = await createUser("zed");
    await setPick(maria.id, g.marketId, "YES"); // the home side
    await comment(g.postId, maria.id, "Chiefs-level offence at home. Easy.");

    // Pick first: a Member who has not picked sees the argument but not the sides, and no Call BS.
    await login(page, zed.email);
    await page.goto(`/post/${g.postId}`);
    await expect(page.getByText("Chiefs-level offence at home. Easy.")).toBeVisible();
    await expect(page.locator('[data-slot="comment-side"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /call bs/i })).toHaveCount(0);
    await expect(page.getByText("Be the first to comment.")).toHaveCount(0);

    // Sam picks the other side. Now he sees which side Maria argues from, that it is the other side, and a Call BS control inside her comment.
    await setPick(sam.id, g.marketId, "NO");
    await login(page, sam.email);
    await page.goto(`/post/${g.postId}`);
    const mariaComment = page.locator("div.flex-1").filter({ hasText: "Chiefs-level offence at home. Easy." }).first();
    await expect(mariaComment.locator('[data-slot="comment-side"]')).toHaveText(`Picked ${g.home} · Other side`);
    await expect(page.getByText(`Say why you picked ${g.away}.`)).toBeVisible();
    await expect(page.getByText(/^You picked/)).toHaveCount(0); // the Post is not a prediction surface
    const callBs = mariaComment.getByRole("button", { name: "Call BS" });
    await expect(callBs).toHaveAccessibleDescription(`Call BS on ${maria.displayName}`); // the name stays "Call BS"; who it is about is its description
    await expect(callBs).toBeVisible();

    // Sam argues back, then calls BS from inside the argument: one tap, no form.
    await page.getByPlaceholder("Add a comment…").fill("Not a chance. Defence wins.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("Not a chance. Defence wins.")).toBeVisible();
    await callBs.click();
    await expect(mariaComment.getByRole("status")).toHaveText("Pending");
    await expect.poll(async () => (await admin.from("challenges").select("status").eq("market_id", g.marketId)).data?.[0]?.status).toBe("PENDING");

    // The challenger sees it waiting, in words, at the top of the Post.
    await page.reload();
    const card = page.locator('[data-slot="call-bs-status"]');
    await expect(card).toContainText("Waiting");
    await expect(card).toContainText(`You called BS on ${maria.displayName}`);
    await expect(card).toContainText(`You picked ${g.away}. ${maria.displayName} picked ${g.home}.`);

    // Maria is notified; the notification lands on the block where she answers.
    await login(page, maria.email);
    await page.goto("/notifications");
    const received = page.getByRole("link", { name: /Someone called BS/ }).first();
    await expect(received).toHaveAttribute("href", `/post/${g.postId}#call-bs`);
    await page.waitForLoadState("networkidle"); // hydrated, so the click navigates
    await received.click();
    await expect(page).toHaveURL(new RegExp(`/post/${g.postId}#call-bs$`));
    const incoming = page.locator('[data-slot="call-bs-item"][data-tone="action"]');
    await expect(incoming).toContainText("Needs your answer");
    await expect(incoming).toContainText(`${sam.displayName} called BS on you`);
    await expect(incoming).toContainText("Accept and both picks lock");
    // It is answered in one place: Sam's row below only names it.
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(1);
    await incoming.getByRole("button", { name: "Accept" }).click();
    await expect(incoming.getByRole("status")).toHaveText("Accepted");

    // Both Picks are locked by it; both Members read an unmistakable accepted state.
    await expect.poll(async () => (await admin.from("predictions").select("lock_reason").eq("market_id", g.marketId)).data?.map((p) => p.lock_reason).sort()).toEqual(["CHALLENGE_ACCEPTED", "CHALLENGE_ACCEPTED"]);
    await page.reload();
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText(`Call BS accepted: you vs ${sam.displayName}`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText("Both picks are locked");
    await login(page, sam.email);
    await page.goto(`/post/${g.postId}`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText(`Call BS accepted: you vs ${maria.displayName}`);

    // The Game finishes: the home side wins, so Maria (home, the recipient) was right.
    await gradeGame(g, true);
    await runLifecycle(page, g.marketId, "RESOLVED");
    await page.goto(`/post/${g.postId}`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText(`You called BS on ${maria.displayName}: ${maria.displayName} was right`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText("You lost");
    await expect(page.getByText(`Your Call BS record vs ${maria.displayName}: 0–1`)).toBeVisible(); // beside her comment, from the resolved challenge
    await expect(page.getByText(/Final: /)).toBeVisible();
    await expect(page.locator('[data-slot="your-prediction"]')).toContainText("Result: Incorrect");

    await login(page, maria.email);
    await page.goto(`/post/${g.postId}`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText(`${sam.displayName} called BS on you: you were right`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText("You won");
    await expect(page.getByText(`Your Call BS record vs ${sam.displayName}: 1–0`)).toBeVisible();
    await expect(page.locator('[data-slot="your-prediction"]')).toContainText("Result: Correct");

    // The permanent record lives on the Profile.
    await page.goto("/profile");
    await expect(page.getByRole("main").getByText("Call BS: 1–0")).toBeVisible();
  });

  test("a pending Call BS ended by a Pick change reads as cancelled, tells the other Member, and leaves nothing to tap", async ({ page }) => {
    const g = await seedGame("Flip");
    const maria = await createUser("flipa");
    const sam = await createUser("flipb");
    await setPick(maria.id, g.marketId, "YES");
    await setPick(sam.id, g.marketId, "NO");
    await comment(g.postId, maria.id, "Home by ten.");

    await login(page, sam.email);
    await page.goto(`/post/${g.postId}`);
    await page.getByRole("button", { name: "Call BS" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pending" })).toBeVisible();

    // Maria changes her side before the deadline: now both read the same, so the Call BS no longer holds.
    await setPick(maria.id, g.marketId, "NO");
    await expect.poll(async () => (await admin.from("challenges").select("status, expiry_reason").eq("market_id", g.marketId)).data?.[0]).toEqual({ status: "EXPIRED", expiry_reason: "PICK_CHANGED" });

    await page.goto(`/post/${g.postId}`);
    const item = page.locator('[data-slot="call-bs-item"]');
    await expect(item).toContainText(`Call BS with ${maria.displayName} cancelled`);
    await expect(item).toContainText("A pick changed");
    await expect(page.getByRole("button", { name: /^(call bs|accept|decline)$/i })).toHaveCount(0);

    // Sam (the Member who did not change anything) is notified once, linked to the Post's Call BS block.
    await runLifecycle(page, g.marketId, "EXPIRED"); // the lifecycle job also delivers any cancellation notification still owed
    await expect.poll(async () => (await admin.from("notifications").select("user_id, post_id").eq("type", "CALL_BS_CANCELLED").eq("market_id", g.marketId)).data?.length).toBe(1);
    const { data: notes } = await admin.from("notifications").select("user_id, post_id").eq("type", "CALL_BS_CANCELLED").eq("market_id", g.marketId);
    expect(notes![0]).toMatchObject({ user_id: sam.id, post_id: g.postId });
    await page.goto("/notifications");
    await page.getByRole("link", { name: /Call BS cancelled/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/post/${g.postId}#call-bs$`));

    // Maria, who made the change, is not told about her own edit; she sees the same cancelled state.
    expect((await admin.from("notifications").select("id").eq("type", "CALL_BS_CANCELLED").eq("user_id", maria.id)).data).toHaveLength(0);
  });

  test("a pending Call BS at the T-10 deadline cannot be answered, expires, and stays expired", async ({ page }) => {
    const g = await seedGame("Late");
    const maria = await createUser("latea");
    const sam = await createUser("lateb");
    await setPick(maria.id, g.marketId, "YES");
    await setPick(sam.id, g.marketId, "NO");
    await comment(g.postId, maria.id, "Late take.");

    await login(page, sam.email);
    await page.goto(`/post/${g.postId}`);
    await page.getByRole("button", { name: "Call BS" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pending" })).toBeVisible();

    // Kickoff comes within 10 minutes: picks lock and the unanswered Call BS can no longer be accepted.
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", g.fixtureId);

    await login(page, maria.email);
    await page.goto(`/post/${g.postId}`);
    const item = page.locator('[data-slot="call-bs-item"]');
    await expect(item).toContainText(`Call BS with ${sam.displayName} expired`);
    await expect(item).toContainText("You didn't answer before picks locked.");
    await expect(page.getByRole("button", { name: /accept|decline/i })).toHaveCount(0);

    await runLifecycle(page, g.marketId, "EXPIRED");
    await login(page, sam.email);
    await page.goto(`/post/${g.postId}`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText(`Call BS with ${maria.displayName} expired`);
    await expect(page.locator('[data-slot="call-bs-item"]')).toContainText(`${maria.displayName} didn't answer before picks locked.`);
    await expect(page.getByRole("button", { name: "Call BS" })).toHaveCount(0);
  });

  test("the other side's comments are easy to find: a filter by side, and nothing hidden for good", async ({ page }) => {
    const g = await seedGame("Side");
    const a = await createUser("sidea");
    const b = await createUser("sideb");
    const c = await createUser("sidec");
    await setPick(a.id, g.marketId, "YES");
    await setPick(b.id, g.marketId, "NO");
    await setPick(c.id, g.marketId, "YES");
    await comment(g.postId, a.id, "Home side loud.");
    await comment(g.postId, b.id, "Away side quiet but right.");

    await login(page, c.email);
    await page.goto(`/post/${g.postId}`);
    const filter = page.locator('[data-slot="other-side-filter"]');
    await expect(filter).toHaveText(`Show only ${g.away} fans (1)`);
    await expect(filter).toHaveAttribute("aria-pressed", "false");
    await filter.click();
    await expect(filter).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Home side loud.")).toHaveCount(0);
    await expect(page.getByText("Away side quiet but right.")).toBeVisible();
    await filter.click();
    await expect(page.getByText("Home side loud.")).toBeVisible();
  });

  test("on a phone: the Call BS control inside a comment is a real tap target and nothing overflows", async ({ page }) => {
    const g = await seedGame("Phone");
    const maria = await createUser("phonea");
    const sam = await createUser("phoneb");
    await setPick(maria.id, g.marketId, "YES");
    await setPick(sam.id, g.marketId, "NO");
    await comment(g.postId, maria.id, "A long-ish opinion that should wrap nicely on a narrow screen without pushing the controls off the edge of the page.");

    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, sam.email);
    await page.goto(`/post/${g.postId}`);
    const button = page.getByRole("button", { name: "Call BS" });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(36);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page, "Post with side badge and Call BS");
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Pending" })).toBeVisible();
    await expectNoHorizontalScroll(page, "Post after Call BS");
  });

  test("after a Pick, the feed card says what to do next — and only claims disagreement that is real", async ({ page }) => {
    const g = await seedGame("Feed", 45); // soon, so it sits on the first page of a busy feed
    const maria = await createUser("feeda");
    const sam = await createUser("feedb");
    await setPick(maria.id, g.marketId, "YES");
    await login(page, sam.email);
    await page.goto("/feed");
    const card = page.getByRole("article", { name: new RegExp(`Game: ${g.away} at ${g.home}`) });
    await expect(card).toBeVisible();
    // Not picked yet: the card is Pick-first, just the count.
    await expect(card.locator('[data-slot="conversation-next-step"]')).toHaveCount(0);
    await expect(card).toContainText("0 comments");

    // A FINAL prediction (a team with Confidence behind it) reveals the crowd; an unstaked, still-editable Pick does not, so the card could not honestly claim any disagreement for one.
    await seedPrediction(sam.id, g.marketId, "NO", 1);
    await page.reload();
    const picked = page.getByRole("article", { name: new RegExp(`Game: ${g.away} at ${g.home}`) });
    await expect(picked.locator('[data-slot="conversation-next-step"]')).toHaveText("Say why");
    await expect(picked.locator('[data-slot="conversation-next-step"]')).toHaveAccessibleName(`Say why you picked ${g.away}, in the Game's conversation`);
    await expect(picked.locator('[data-slot="conversation-next-step"]')).toHaveAttribute("href", `/post/${g.postId}#conversation`);

    await comment(g.postId, maria.id, "Home wins.");
    await page.reload();
    const withComment = page.getByRole("article", { name: new RegExp(`Game: ${g.away} at ${g.home}`) });
    await expect(withComment.locator('[data-slot="conversation-next-step"]')).toHaveText(`1 comment · See who picked ${g.home}`);
  });
});
