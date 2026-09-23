/**
 * E2E coverage for Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post
 * Conversation) — the comment composer/list/reply UI on /post/[id].
 * Requires the local Supabase stack (`pnpm supabase:start`) — `pnpm
 * test:e2e` handles the rest.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createPlayer(email: string, usernamePrefix: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `${usernamePrefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;
  return data.user.id as string;
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedPublishedPost(): Promise<{ fixtureId: string; postId: string }> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-post-conversation-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  const fixtureId = data.id as string;

  // Direct inserts (not lib/posts/repository.ts's ensurePostForFixture/
  // publishPost) — those import "server-only", which a Playwright spec
  // file can't import (it's bundled as a client module, unlike a Vitest
  // integration test). A fresh fixture never collides with posts' own
  // one-per-Game constraint, so a plain insert is equivalent here.
  const { data: post, error: postError } = await admin
    .from("posts")
    .insert({ fixture_id: fixtureId, published_at: new Date().toISOString() })
    .select("id")
    .single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  return { fixtureId, postId: post.id as string };
}

async function cleanup(fixtureId: string, postId: string, userIds: string[]) {
  await admin.from("notifications").delete().eq("post_id", postId);
  await admin.from("post_comments").delete().eq("post_id", postId);
  await admin.from("posts").delete().eq("id", postId);
  await admin.from("fixtures").delete().eq("id", fixtureId);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}

test.describe("Post Conversation", () => {
  test("a user posts a comment, replies to it, and can delete their own comment", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-post-comment-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, postId } = await seedPublishedPost();

    try {
      userIds.push(await createPlayer(email, "e2epostc"));

      await loginAs(page, email);
      await page.goto(`/post/${postId}`);

      await expect(page.getByText("Be the first to comment.")).toBeVisible();

      await page.getByPlaceholder("Add a comment…").fill("Let's go Home Test FC!");
      await page.getByRole("button", { name: "Post" }).click();
      await expect(page.getByText("Let's go Home Test FC!")).toBeVisible();

      await page.getByRole("button", { name: "Reply" }).click();
      await page.getByPlaceholder(/Reply to/).fill("Agreed!");
      // Two "Post" buttons exist once the reply form is open — the reply
      // form's own (first in DOM order) and the main composer's, disabled
      // and further down the page.
      await page.getByRole("button", { name: "Post" }).first().click();
      await expect(page.getByText("Agreed!")).toBeVisible();

      await page.reload();
      await expect(page.getByText("Let's go Home Test FC!")).toBeVisible();
      await expect(page.getByText("Agreed!")).toBeVisible();

      await page.getByRole("button", { name: "Delete comment" }).first().click();
      await expect(page.getByText("[comment deleted]")).toBeVisible();
      // The reply survives its parent's removal — no cascade.
      await expect(page.getByText("Agreed!")).toBeVisible();
    } finally {
      await cleanup(fixtureId, postId, userIds);
    }
  });

  test("a comment is visible to a second user viewing the same Post — one shared conversation", async ({ page }) => {
    const suffix = randomUUID();
    const authorEmail = `e2e-post-comment-author-${suffix}@test.local`;
    const viewerEmail = `e2e-post-comment-viewer-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, postId } = await seedPublishedPost();

    try {
      const authorId = await createPlayer(authorEmail, "e2eposta");
      userIds.push(authorId, await createPlayer(viewerEmail, "e2epostv"));

      await loginAs(page, authorEmail);
      await page.goto(`/post/${postId}`);
      await page.getByPlaceholder("Add a comment…").fill("Shared take from the author");
      await page.getByRole("button", { name: "Post" }).click();
      await expect(page.getByText("Shared take from the author")).toBeVisible();

      // The composer's own optimistic render (above) proves the Server
      // Action returned successfully, but not yet that the row is visible
      // to the FRESH SSR request the next page load below performs — on a
      // cold `next dev`/Turbopack process, the very first hit to a route
      // can still be finishing compilation when the mutation's response
      // already reached the client, occasionally racing a follow-up
      // request. Poll the same admin client the rest of this suite uses
      // rather than a blind sleep — deterministic (bounded, condition-
      // based) instead of a guessed delay.
      await expect
        .poll(async () => {
          const { count } = await admin.from("post_comments").select("id", { count: "exact", head: true }).eq("post_id", postId);
          return count ?? 0;
        })
        .toBeGreaterThan(0);

      await page.context().clearCookies();
      await loginAs(page, viewerEmail);
      await page.goto(`/post/${postId}`);
      await expect(page.getByText("Shared take from the author")).toBeVisible();
    } finally {
      await cleanup(fixtureId, postId, userIds);
    }
  });
});
