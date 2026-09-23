/**
 * E2E coverage for Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free
 * Call BS Challenges) — the Call BS / Accept / Decline UI surfaced inside
 * MarketPredictionCard on /markets/[id] (and, unchanged, /post/[id] via the
 * same shared component). Requires the local Supabase stack
 * (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
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

async function seedMarket() {
  const { data: fixture, error: fixtureErr } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-call-bs-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (fixtureErr || !fixture) throw fixtureErr ?? new Error("failed to create fixture");

  const { data: market, error: marketErr } = await admin
    .from("markets")
    .insert({
      provider: "e2e_call_bs",
      provider_market_id: `active_${randomUUID()}`,
      question: `E2E Call BS test: ${randomUUID()}`,
      status: "ACTIVE",
      fixture_id: fixture.id,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      yes_price: 0.6,
      no_price: 0.4,
      liquidity: 1000,
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketErr || !market) throw marketErr ?? new Error("failed to create market");

  return { fixtureId: fixture.id as string, marketId: market.id as string };
}

async function cleanup(fixtureId: string, marketId: string, userIds: string[]) {
  await admin.from("notifications").delete().in("challenge_id", (await admin.from("challenges").select("id").eq("market_id", marketId)).data?.map((r) => r.id) ?? []);
  await admin.from("challenges").delete().eq("market_id", marketId);
  await admin.from("predictions").delete().eq("market_id", marketId);
  await admin.from("markets").delete().eq("id", marketId);
  await admin.from("fixtures").delete().eq("id", fixtureId);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}

test.describe("Call BS Challenges", () => {
  test("one user calls BS on an opposing pick, the other accepts, and both see the accepted state", async ({ page }) => {
    await admin.from("platform_settings").update({ call_bs_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-call-bs-a-${suffix}@test.local`;
    const emailB = `e2e-call-bs-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId } = await seedMarket();

    try {
      userIds.push(await createPlayer(emailA, "e2ecallbsa"));
      userIds.push(await createPlayer(emailB, "e2ecallbsb"));

      // A picks YES.
      await loginAs(page, emailA);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Predict YES" }).click();
      await expect(page.getByText(/You predicted YES/)).toBeVisible();

      // B picks NO, then sees A's opposing pick with a Call BS button.
      await page.context().clearCookies();
      await loginAs(page, emailB);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Predict NO" }).click();
      await expect(page.getByText(/You predicted NO/)).toBeVisible();

      await page.reload();
      await expect(page.getByText("Other picks")).toBeVisible();
      await expect(page.getByText("Picked YES")).toBeVisible();
      await page.getByRole("button", { name: "Call BS" }).click();
      await expect(page.getByText("Pending")).toBeVisible();

      // A sees B's incoming Call BS and accepts it.
      await page.context().clearCookies();
      await loginAs(page, emailA);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText("Picked NO")).toBeVisible();
      await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
      await page.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByText("Accepted")).toBeVisible();

      // B also now sees it as accepted.
      await page.context().clearCookies();
      await loginAs(page, emailB);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText("Accepted")).toBeVisible();

      const { data: challenge } = await admin.from("challenges").select("status").eq("market_id", marketId).single();
      expect(challenge?.status).toBe("ACCEPTED");
    } finally {
      await cleanup(fixtureId, marketId, userIds);
    }
  });

  test("the recipient can decline a Call BS", async ({ page }) => {
    await admin.from("platform_settings").update({ call_bs_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const emailA = `e2e-call-bs-decline-a-${suffix}@test.local`;
    const emailB = `e2e-call-bs-decline-b-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId } = await seedMarket();

    try {
      userIds.push(await createPlayer(emailA, "e2edeclinea"));
      userIds.push(await createPlayer(emailB, "e2edeclineb"));

      await loginAs(page, emailA);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Predict YES" }).click();
      await expect(page.getByText(/You predicted YES/)).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailB);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Predict NO" }).click();
      await expect(page.getByText(/You predicted NO/)).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Call BS" }).click();
      await expect(page.getByText("Pending")).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailA);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Decline" }).click();
      await expect(page.getByText("Declined")).toBeVisible();

      const { data: challenge } = await admin.from("challenges").select("status").eq("market_id", marketId).single();
      expect(challenge?.status).toBe("DECLINED");

      const { data: predictions } = await admin.from("predictions").select("locked_at").eq("market_id", marketId);
      expect(predictions?.every((p) => p.locked_at === null)).toBe(true);
    } finally {
      await cleanup(fixtureId, marketId, userIds);
    }
  });
});
