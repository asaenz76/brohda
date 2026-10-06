/**
 * E2E coverage for Phase F's redesigned Profile (`/profile`,
 * `/profile/[username]`) — a social identity (avatar/name/handle/
 * reputation), not a dashboard/Pool-history page/settings hub. Requires
 * the local Supabase stack (`pnpm supabase:start`) — `pnpm test:e2e`
 * handles the rest.
 *
 * Every seeded record embeds this test's unique suffix to avoid
 * collisions with other concurrently-running E2E workers.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const PROVIDER = "e2e_profile";

async function createPlayer(email: string, usernamePrefix: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const username = `${usernamePrefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;
  return { userId: data.user.id as string, username };
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedMarket(question: string): Promise<{ marketId: string; fixtureId: string; postId: string }> {
  const { data: fixture, error: fixtureError } = await admin
    .from("fixtures")
    .insert({ provider: PROVIDER, external_fixture_id: `e2e-profile-fixture-${randomUUID()}`, home_team_name: "Home", away_team_name: "Away", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (fixtureError || !fixture) throw fixtureError ?? new Error("failed to create fixture");

  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");

  const { data: market, error: marketError } = await admin
    .from("markets")
    .insert({
      provider: PROVIDER,
      provider_market_id: `m-${randomUUID()}`,
      question,
      status: "ACTIVE",
      fixture_id: fixture.id,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      price_outcome_labels: { yes: "Home wins", no: "Home does not win" },
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");

  return { marketId: market.id as string, fixtureId: fixture.id as string, postId: post.id as string };
}

async function createPrediction(userId: string, marketId: string, question: string, opts: { graded?: "CORRECT" | "INCORRECT"; pending?: boolean } = {}) {
  const { data, error } = await admin
    .from("predictions")
    .insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: question,
      market_close_at_snapshot: null,
      market_status_snapshot: "ACTIVE",
      lifecycle_state: opts.pending ? "PENDING" : "GRADED",
      result: opts.graded ?? null,
      resolved_outcome_snapshot: opts.graded ? (opts.graded === "CORRECT" ? "YES" : "NO") : null,
      graded_at: opts.graded ? new Date().toISOString() : null,
      idempotency_key: randomUUID(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create prediction");
  return data.id as string;
}

async function seedTeamCommunity(name: string) {
  const { data: team, error: teamError } = await admin.from("teams").insert({ provider: PROVIDER, external_id: `team-${randomUUID()}`, name }).select("id").single();
  if (teamError || !team) throw teamError ?? new Error("failed to create team");
  const { data: community, error } = await admin.from("communities").insert({ type: "TEAM", team_id: team.id, slug: `e2e-profile-team-${randomUUID()}`, active: true }).select("id, slug").single();
  if (error || !community) throw error ?? new Error("failed to create community");
  return { teamId: team.id as string, communityId: community.id as string, slug: community.slug as string };
}

test.describe("Profile", () => {
  test("own profile: identity, canonical reputation format, no legacy tabs/links, Edit profile reachable", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-profile-own-${suffix}@example.com`;
    const { username } = await createPlayer(email, "e2eprofown");

    await loginAs(page, email);
    await page.goto("/profile");

    // Scoped to the page: the right rail also shows the viewer's compact identity.
    await expect(page.getByRole("main").getByText(`@${username}`)).toBeVisible();
    // Truly zero history (spec §5/§26) omits the reputation line entirely
    // rather than showing a fabricated "0 predicted" — matching
    // UserIdentity's own locked unit-tested behavior.
    await expect(page.getByText(/predicted/)).toHaveCount(0);

    // Legacy six-tab row is gone — only Predictions/Communities remain.
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: "Predictions" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Communities" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Market Predictions" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Teams & Leagues" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Analytics" })).toHaveCount(0);
    // The legacy Profile "Rules" link stays gone. (Scoped to the page content: the shell's secondary nav and the footer now carry the real /rules page.)
    await expect(page.getByRole("main").getByRole("link", { name: "Rules" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /leaderboard/i })).toHaveCount(0);

    await expect(page.getByText("No predictions yet.")).toBeVisible();

    await page.getByRole("link", { name: "Edit profile" }).click();
    await expect(page).toHaveURL(/\/profile\/edit$/);
    await expect(page.getByLabel(/display name/i)).toBeVisible();
  });

  test("own profile: a graded AND a pending Prediction both show, with factual result language", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-profile-history-${suffix}@example.com`;
    const { userId } = await createPlayer(email, "e2eprofhist");

    const question = `Will the Home Test ${suffix} win?`;
    const { marketId, postId } = await seedMarket(question);
    await createPrediction(userId, marketId, question, { graded: "CORRECT" });

    const question2 = `Will the Pending Test ${suffix} win?`;
    const { marketId: marketId2, postId: postId2 } = await seedMarket(question2);
    await createPrediction(userId, marketId2, question2, { pending: true });

    await loginAs(page, email);
    await page.goto("/profile");

    // Each row names the Game and the Market ("Home vs Away · Moneyline") and the visible Pick — never the old question or a raw YES.
    const gradedRow = page.locator(`a[href="/post/${postId}"]`);
    const pendingRow = page.locator(`a[href="/post/${postId2}"]`);
    await expect(gradedRow).toHaveText("Home vs Away · Moneyline");
    await expect(pendingRow).toHaveText("Home vs Away · Moneyline");
    await expect(page.getByText(/You picked Home · /).first()).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText(/Will the|do not win|You picked (YES|NO)\b/);
    await expect(page.getByText("Correct", { exact: true })).toBeVisible();
    await expect(page.getByText("Pending", { exact: true })).toBeVisible();

    // Links to the canonical Post, not /markets/[id].
    await gradedRow.click();
    await expect(page).toHaveURL(new RegExp(`/post/${postId}$`));
  });

  test("other user's profile: only graded Predictions show, never a pending one (privacy parity with the old visited-profile rule)", async ({ page }) => {
    const suffix = randomUUID();
    const targetEmail = `e2e-profile-other-${suffix}@example.com`;
    const { userId: targetUserId, username: targetUsername } = await createPlayer(targetEmail, "e2eprofother");

    const gradedQuestion = `Will the Graded Test ${suffix} win?`;
    const { marketId: gradedMarketId, postId: gradedPostId } = await seedMarket(gradedQuestion);
    await createPrediction(targetUserId, gradedMarketId, gradedQuestion, { graded: "CORRECT" });

    const pendingQuestion = `Will the Secret Pending Test ${suffix} win?`;
    const { marketId: pendingMarketId, postId: pendingPostId } = await seedMarket(pendingQuestion);
    await createPrediction(targetUserId, pendingMarketId, pendingQuestion, { pending: true });

    const viewerEmail = `e2e-profile-viewer-${suffix}@example.com`;
    await createPlayer(viewerEmail, "e2eprofviewer");

    await loginAs(page, viewerEmail);
    await page.goto(`/profile/${targetUsername}`);

    await expect(page.getByRole("button", { name: "Follow" })).toBeVisible();
    await expect(page.locator(`a[href="/post/${gradedPostId}"]`)).toHaveText("Home vs Away · Moneyline");
    await expect(page.locator(`a[href="/post/${pendingPostId}"]`)).toHaveCount(0); // a pending Pick is never shown to someone else

    // No Edit profile / Analytics / Rules on someone else's profile either.
    await expect(page.getByRole("link", { name: "Edit profile" })).toHaveCount(0);
  });

  test("Communities tab (own and other profile): human labels, no raw enum, follow toggle reflects the viewer's own state", async ({ page }) => {
    const suffix = randomUUID();
    const ownerEmail = `e2e-profile-comm-owner-${suffix}@example.com`;
    const { userId: ownerId, username: ownerUsername } = await createPlayer(ownerEmail, "e2eprofcommo");
    const teamName = `E2E Profile Community Team ${suffix}`;
    const { teamId, communityId, slug } = await seedTeamCommunity(teamName);
    await admin.from("community_follows").insert({ user_id: ownerId, community_id: communityId });

    try {
      const viewerEmail = `e2e-profile-comm-viewer-${suffix}@example.com`;
      await createPlayer(viewerEmail, "e2eprofcommv");

      await loginAs(page, viewerEmail);
      await page.goto(`/profile/${ownerUsername}`);
      await page.getByRole("tab", { name: "Communities" }).click();
      await expect(page).toHaveURL(/tab=communities/);

      await expect(page.getByText("Team", { exact: true })).toBeVisible();
      await expect(page.getByText(teamName)).toBeVisible();
      await expect(page.getByText(/^\s*TEAM\s*$/)).toHaveCount(0);

      const row = page.locator("li", { hasText: teamName });
      await expect(row.getByRole("button", { name: "Follow" })).toBeVisible();
      await row.getByRole("button", { name: "Follow" }).click();
      const followingButton = row.getByRole("button", { name: "Following" });
      await expect(followingButton).toBeVisible();
      await expect(followingButton).toBeEnabled();

      await row.getByRole("link", { name: teamName }).click();
      await expect(page).toHaveURL(new RegExp(`/community/${slug}$`));
    } finally {
      await admin.from("community_follows").delete().eq("community_id", communityId);
      await admin.from("communities").delete().eq("id", communityId);
      await admin.from("teams").delete().eq("id", teamId);
    }
  });

  test("Communities empty state is restrained, with no Pool language", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-profile-comm-empty-${suffix}@example.com`;
    await createPlayer(email, "e2eprofcommempty");

    await loginAs(page, email);
    await page.goto("/profile?tab=communities");
    await expect(page.getByText("No Communities followed yet.")).toBeVisible();

    const bodyText = (await page.locator("main").innerText()).toLowerCase();
    expect(bodyText).not.toMatch(/\bpool\b|\bbet\b|\bodds\b|\bwager\b|\bstake\b/);
  });

  test("mobile (375px): own Profile has no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const suffix = randomUUID();
    const email = `e2e-profile-mobile-${suffix}@example.com`;
    await createPlayer(email, "e2eprofmobile");

    await loginAs(page, email);
    await page.goto("/profile");
    await expect(page.getByRole("tab", { name: "Predictions" })).toBeVisible();

    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(hasOverflow).toBe(false);
  });

  test("a long display name does not overflow the header", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-profile-longname-${suffix}@example.com`;
    const { userId } = await createPlayer(email, "e2eproflong");
    const longName = `A Very Extraordinarily Long Display Name That Keeps Going ${suffix}`;
    await admin.from("user_profiles").update({ display_name: longName }).eq("id", userId);

    await loginAs(page, email);
    await page.goto("/profile");
    await expect(page.getByText(longName, { exact: false }).first()).toBeVisible();

    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(hasOverflow).toBe(false);
  });
});
