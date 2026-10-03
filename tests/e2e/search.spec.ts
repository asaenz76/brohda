/**
 * E2E coverage for Phase H's updated `/search` — fixture results now
 * resolve to the canonical `/post/[id]` instead of the retired legacy
 * Pool-browsing `/fixture/[id]` page, and a fixture with no published Post
 * is dropped entirely rather than linking to a dead end (spec §11).
 * Requires the local Supabase stack (`pnpm supabase:start`) — `pnpm
 * test:e2e` handles the rest.
 *
 * Every seeded record embeds this test's unique suffix to avoid collisions
 * with other concurrently-running E2E workers' own seeded fixtures.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const PROVIDER = "e2e_search";

async function createPlayer(email: string, username: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: username,
    username,
    role: "player",
    is_active: true,
  });
  return data.user.id as string;
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedFixture(homeTeamName: string, awayTeamName: string) {
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `e2e-search-fixture-${randomUUID()}`,
      home_team_name: homeTeamName,
      away_team_name: awayTeamName,
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  return fixture.id as string;
}

async function publishPost(fixtureId: string) {
  const { data: post, error } = await admin
    .from("posts")
    .insert({ fixture_id: fixtureId, published_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !post) throw error ?? new Error("failed to create post");
  return post.id as string;
}

test.describe("Search", () => {
  test("a game with a published Post resolves to /post/[id]; a game with no Post is dropped", async ({ page }) => {
    const suffix = randomUUID().slice(0, 8);
    const homeTeam = `SearchHome${suffix}`;
    const awayTeam = `SearchAway${suffix}`;
    const unpublishedTeam = `SearchGhost${suffix}`;

    const fixtureIds: string[] = [];
    const postIds: string[] = [];
    const userIds: string[] = [];

    try {
      const email = `e2e-search-${suffix}@test.local`;
      const userId = await createPlayer(email, `e2esearch${suffix}`);
      userIds.push(userId);

      const publishedFixtureId = await seedFixture(homeTeam, awayTeam);
      fixtureIds.push(publishedFixtureId);
      const postId = await publishPost(publishedFixtureId);
      postIds.push(postId);

      // A fixture with no Post at all — Search must never link here, since
      // the legacy Pool-browsing /fixture/[id] page is retired and there is
      // nothing else at that fixture id for a visitor to land on.
      const unpublishedFixtureId = await seedFixture(unpublishedTeam, awayTeam);
      fixtureIds.push(unpublishedFixtureId);

      await loginAs(page, email);

      await page.goto(`/search?q=${homeTeam}`);
      await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
      const resultLink = page.locator(`a[href="/post/${postId}"]`);
      await expect(resultLink).toBeVisible();
      await expect(resultLink).toContainText(homeTeam);
      // Never the retired Pool-browsing route.
      await expect(page.locator(`a[href^="/fixture/"]`)).toHaveCount(0);

      await page.goto(`/search?q=${unpublishedTeam}`);
      await expect(page.getByText(`Nothing matches "${unpublishedTeam}"`)).toBeVisible();

      await page.goto(`/search?q=e2esearch${suffix}`);
      await expect(page.getByRole("heading", { name: "Players" })).toBeVisible();
      await expect(page.getByRole("main").locator(`a[href="/profile/e2esearch${suffix}"]`)).toBeVisible();
    } finally {
      if (postIds.length > 0) await admin.from("posts").delete().in("id", postIds);
      if (fixtureIds.length > 0) await admin.from("fixtures").delete().in("id", fixtureIds);
      for (const id of userIds) await admin.auth.admin.deleteUser(id);
    }
  });
});
