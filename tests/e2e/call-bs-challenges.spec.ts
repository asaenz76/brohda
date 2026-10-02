/**
 * E2E coverage for Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free
 * Call BS Challenges) — the Call BS / Accept / Decline UI surfaced inside
 * MarketPredictionCard on /markets/[id] (and, unchanged, /post/[id] via the
 * same shared component). Requires the local Supabase stack
 * (`pnpm supabase:start`) — `pnpm test:e2e` handles the rest.
 *
 * call_bs_enabled is turned on once for the whole run by
 * tests/e2e/helpers/global-setup.ts (and restored by its teardown) — never
 * toggled per test here, since these specs run in parallel and a per-test
 * restore would switch the flag off under whichever test is still running.
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
      await page.getByRole("button", { name: "Pick: Yes" }).click();
      await expect(page.getByText(/You picked Yes/)).toBeVisible();

      // B picks NO, then sees A's opposing pick with a Call BS button.
      await page.context().clearCookies();
      await loginAs(page, emailB);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();

      await page.reload();
      await expect(page.getByText("Other picks")).toBeVisible();
      await expect(page.getByText("Picked Yes")).toBeVisible();
      await page.getByRole("button", { name: "Call BS" }).click();
      await expect(page.getByText("Pending")).toBeVisible();

      // A sees B's incoming Call BS and accepts it.
      await page.context().clearCookies();
      await loginAs(page, emailA);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText("Picked No")).toBeVisible();
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
      await page.getByRole("button", { name: "Pick: Yes" }).click();
      await expect(page.getByText(/You picked Yes/)).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailB);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();
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

  test("exclusivity: accepting one Call BS displaces every other pending challenge for either participant, and already-paired users show no Call BS action", async ({ page }) => {
    // Four users, seven logins and roughly fifteen page loads against a
    // `next dev` server that compiles routes on demand and is shared with
    // other workers: ~30s alone, but over the default 60s once contended
    // (seen in CI with 2 workers, and locally with 3). The page was
    // mid-login and mid-compile at the timeout — slow, not stuck — so this
    // triples this one test's budget instead of trimming what it proves.
    test.slow();
    const suffix = randomUUID();
    const emailAndre = `e2e-excl-andre-${suffix}@test.local`;
    const emailCarlos = `e2e-excl-carlos-${suffix}@test.local`;
    const emailMarco = `e2e-excl-marco-${suffix}@test.local`;
    const emailPriya = `e2e-excl-priya-${suffix}@test.local`;
    const userIds: string[] = [];
    const { fixtureId, marketId } = await seedMarket();

    try {
      userIds.push(await createPlayer(emailAndre, "e2eexclandre"));
      userIds.push(await createPlayer(emailCarlos, "e2eexclcarlos"));
      userIds.push(await createPlayer(emailMarco, "e2eexclmarco"));
      userIds.push(await createPlayer(emailPriya, "e2eexclpriya"));

      await loginAs(page, emailAndre);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: Yes" }).click();
      await expect(page.getByText(/You picked Yes/)).toBeVisible();

      // Carlos and Marco both pick the opposing side and both send Andre
      // a Call BS — two independent PENDING challenges against the same
      // recipient, which must coexist.
      await page.context().clearCookies();
      await loginAs(page, emailCarlos);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Call BS" }).click();
      await expect(page.getByText("Pending")).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailMarco);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Call BS" }).click();
      await expect(page.getByText("Pending")).toBeVisible();

      // Priya also picks the opposing side but sends no challenge — used
      // below to prove Call BS disappears for an already-paired target.
      await page.context().clearCookies();
      await loginAs(page, emailPriya);
      await page.goto(`/markets/${marketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();

      // Andre sees both Carlos's and Marco's incoming Call BS, each with
      // its own Accept/Decline — scoped per row so accepting one doesn't
      // accidentally target the other.
      await page.context().clearCookies();
      await loginAs(page, emailAndre);
      await page.goto(`/markets/${marketId}`);
      const carlosRow = page.locator("li", { hasText: "e2e-excl-carlos" });
      const marcoRow = page.locator("li", { hasText: "e2e-excl-marco" });
      await expect(carlosRow.getByRole("button", { name: "Accept" })).toBeVisible();
      await expect(marcoRow.getByRole("button", { name: "Accept" })).toBeVisible();
      // The lock consequence is visible before Andre ever clicks Accept.
      await expect(carlosRow.getByText(/locks both predictions/i)).toBeVisible();

      await carlosRow.getByRole("button", { name: "Accept" }).click();
      await expect(carlosRow.getByText("Accepted")).toBeVisible();

      // Marco's still-visible row must stop offering Accept/Decline —
      // never a stale control — and must not read as an explicit Decline.
      // Deliberately no page.reload(): the Accept action revalidates the
      // page and the row follows the refreshed server state on its own.
      await expect(marcoRow.getByRole("button", { name: "Accept" })).not.toBeVisible();
      await expect(marcoRow.getByText("Declined")).not.toBeVisible();
      await expect(marcoRow.getByText("No longer available")).toBeVisible();

      // Priya's row (never challenged, opposing, previously eligible) no
      // longer offers Call BS either — Andre is already exclusively
      // paired with Carlos on this Market.
      const priyaRow = page.locator("li", { hasText: "e2e-excl-priya" });
      await expect(priyaRow.getByRole("button", { name: "Call BS" })).not.toBeVisible();

      // From Marco's own side: no longer available too, and his Pick is
      // still ordinarily editable (never locked — he was displaced, not
      // paired).
      await page.context().clearCookies();
      await loginAs(page, emailMarco);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText("No longer available")).toBeVisible();

      const { data: predictions } = await admin.from("predictions").select("user_id, locked_at, lock_reason").eq("market_id", marketId);
      const byUser = new Map((predictions ?? []).map((p) => [p.user_id as string, p]));
      const andreId = userIds[0];
      const carlosId = userIds[1];
      const marcoId = userIds[2];
      expect(byUser.get(andreId)?.lock_reason).toBe("CHALLENGE_ACCEPTED");
      expect(byUser.get(carlosId)?.lock_reason).toBe("CHALLENGE_ACCEPTED");
      expect(byUser.get(marcoId)?.locked_at).toBeNull();

      const { data: marcoChallenge } = await admin
        .from("challenges")
        .select("status")
        .eq("market_id", marketId)
        .eq("challenger_user_id", marcoId)
        .single();
      expect(marcoChallenge?.status).toBe("EXPIRED");
    } finally {
      await cleanup(fixtureId, marketId, userIds);
    }
  });
});
