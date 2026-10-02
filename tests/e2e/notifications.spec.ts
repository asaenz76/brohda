/**
 * E2E coverage for Phase G's canonical `/notifications` center — the
 * explicit-allowlist redesign replacing the old combined
 * notifications+wallet-ledger `/activity` page (which now redirects
 * here). Requires the local Supabase stack (`pnpm supabase:start`) —
 * `pnpm test:e2e` handles the rest.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

async function createPlayer(email: string, usernamePrefix: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `${usernamePrefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
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

async function createNotification(userId: string, type: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("notifications")
    .insert({ user_id: userId, type, title: `Title for ${type}`, body: `Body for ${type}`, ...overrides })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create notification");
  return data.id as string;
}

async function cleanup(userIds: string[]) {
  for (const id of userIds) {
    await admin.from("notifications").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id);
  }
}

test.describe("Notifications", () => {
  test("shows only the Brohda 2.0 social types (prediction_graded, POST_COMMENT_REPLY, CALL_BS_*, MONETARY_*), never legacy Pool or wallet-admin types", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-notif-filter-${suffix}@example.com`;
    const userIds: string[] = [];

    try {
      const userId = await createPlayer(email, "e2enotiffilter");
      userIds.push(userId);

      await createNotification(userId, "prediction_graded", { title: "You were right", body: "Allowed prediction row" });
      await createNotification(userId, "POST_COMMENT_REPLY", { title: "New reply", body: "Allowed reply row" });
      await createNotification(userId, "SETTLED_WON", { title: "Hidden Pool win", body: "Should never render" });
      await createNotification(userId, "CALL_BS_RECEIVED", { title: "Someone called BS", body: "Allowed Call BS row" });
      await createNotification(userId, "MONETARY_PROPOSAL_RECEIVED", { title: "Someone put money on it", body: "Allowed monetary row" });
      await createNotification(userId, "DEPOSIT_APPROVED", { title: "Hidden deposit", body: "Should never render" });

      await loginAs(page, email);
      await page.goto("/notifications");

      await expect(page.getByText("You were right")).toBeVisible();
      await expect(page.getByText("New reply")).toBeVisible();
      await expect(page.getByText("Someone called BS")).toBeVisible();
      await expect(page.getByText("Someone put money on it")).toBeVisible();
      await expect(page.getByText("Hidden Pool win")).toHaveCount(0);
      await expect(page.getByText("Hidden deposit")).toHaveCount(0);

      const bodyText = (await page.locator("main").innerText()).toLowerCase();
      expect(bodyText).not.toMatch(/\bpool\b|\bstake\b|\bpayout\b/);
    } finally {
      await cleanup(userIds);
    }
  });

  test("/activity redirects to /notifications", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-notif-redirect-${suffix}@example.com`;
    const userIds: string[] = [];
    try {
      userIds.push(await createPlayer(email, "e2enotifredir"));
      await loginAs(page, email);
      await page.goto("/activity");
      await expect(page).toHaveURL(/\/notifications$/);
    } finally {
      await cleanup(userIds);
    }
  });

  test("primary nav's Notifications destination is /notifications, with an unread badge reflecting only visible-type unread rows", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-notif-nav-${suffix}@example.com`;
    const userIds: string[] = [];
    try {
      const userId = await createPlayer(email, "e2enotifnav");
      userIds.push(userId);
      await createNotification(userId, "prediction_graded");
      await createNotification(userId, "SETTLED_WON"); // hidden type, must not inflate the badge

      await loginAs(page, email);
      await page.goto("/feed");

      const navLink = page.getByRole("link", { name: /notifications/i });
      await expect(navLink).toHaveAttribute("href", "/notifications");
      await expect(navLink).toContainText("1");
    } finally {
      await cleanup(userIds);
    }
  });

  test("Mark all read clears unread state for visible notifications", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-notif-read-${suffix}@example.com`;
    const userIds: string[] = [];
    try {
      const userId = await createPlayer(email, "e2enotifread");
      userIds.push(userId);
      await createNotification(userId, "prediction_graded", { title: "Unread result" });

      await loginAs(page, email);
      await page.goto("/notifications");
      await expect(page.getByRole("button", { name: "Mark all read" })).toBeVisible();
      await page.getByRole("button", { name: "Mark all read" }).click();
      await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);

      const { data } = await admin.from("notifications").select("read_at").eq("user_id", userId).single();
      expect(data?.read_at).not.toBeNull();
    } finally {
      await cleanup(userIds);
    }
  });

  test("empty state is restrained, with no Pool/wallet language", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-notif-empty-${suffix}@example.com`;
    const userIds: string[] = [];
    try {
      userIds.push(await createPlayer(email, "e2enotifempty"));
      await loginAs(page, email);
      await page.goto("/notifications");
      await expect(page.getByText("No notifications yet.")).toBeVisible();

      const bodyText = (await page.locator("main").innerText()).toLowerCase();
      expect(bodyText).not.toMatch(/\bpool\b|\bwallet\b|\bbet\b|\bmarket\b/);
    } finally {
      await cleanup(userIds);
    }
  });

  test("clicking a prediction_graded notification navigates to its canonical destination", async ({ page }) => {
    const suffix = randomUUID();
    const email = `e2e-notif-click-${suffix}@example.com`;
    const userIds: string[] = [];
    try {
      const userId = await createPlayer(email, "e2enotifclick");
      userIds.push(userId);

      const { data: fixture } = await admin
        .from("fixtures")
        .insert({ external_fixture_id: `e2e-notif-fixture-${suffix}`, home_team_name: "Home", away_team_name: "Away", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
        .select("id")
        .single();
      const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
      const { data: market } = await admin
        .from("markets")
        .insert({
          provider: "e2e_notif_click",
          provider_market_id: `m-${suffix}`,
          question: "Click question",
          status: "ACTIVE",
          fixture_id: fixture!.id,
          market_template: "MONEYLINE",
          yes_side: "HOME",
          price_outcome_labels: { yes: "Yes", no: "No" },
          last_synced_at: new Date().toISOString(),
          ingestion_source: "e2e_test",
          provider_metadata: {},
        })
        .select("id")
        .single();
      await createNotification(userId, "prediction_graded", { title: "You were right", post_id: post!.id, market_id: market!.id });

      await loginAs(page, email);
      await page.goto("/notifications");
      await page.getByText("You were right").click();
      await expect(page).toHaveURL(new RegExp(`/markets/${market!.id}$`));

      await admin.from("markets").delete().eq("id", market!.id);
      await admin.from("posts").delete().eq("id", post!.id);
      await admin.from("fixtures").delete().eq("id", fixture!.id);
    } finally {
      await cleanup(userIds);
    }
  });

  test("mobile (375px): /notifications has no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const suffix = randomUUID();
    const email = `e2e-notif-mobile-${suffix}@example.com`;
    const userIds: string[] = [];
    try {
      const userId = await createPlayer(email, "e2enotifmobile");
      userIds.push(userId);
      await createNotification(userId, "POST_COMMENT_REPLY", { title: "A reply with a reasonably long notification title to check wrapping" });

      await loginAs(page, email);
      await page.goto("/notifications");
      await expect(page.getByText(/A reply with a reasonably long/)).toBeVisible();

      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(hasOverflow).toBe(false);
    } finally {
      await cleanup(userIds);
    }
  });
});
