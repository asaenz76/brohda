/**
 * E2E coverage for Milestone R11 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Reputation + Leaderboards) — Picks graded via a safe local authoritative
 * result (mirroring tests/e2e/p2p-settlement.spec.ts's own pattern, no
 * real sports provider), a resolved free Call BS Challenge (mirroring
 * tests/e2e/call-bs-challenges.spec.ts's own conventions), the resulting
 * Prediction Leaderboard ranking, and a matching Profile record. No real
 * money anywhere. Requires the local Supabase stack (`pnpm
 * supabase:start`) — `pnpm test:e2e` handles the rest.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

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

async function seedFixtureAndMarket(prefix: string) {
  const { data: fixture, error: fixtureErr } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `${prefix}-${randomUUID()}`,
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
      provider: prefix,
      provider_market_id: `active_${randomUUID()}`,
      question: `E2E reputation test: ${randomUUID()}`,
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

/** The safe local authoritative-result path — same MONEYLINE grading rule sports-resolution.ts itself uses, applied directly, no real sports provider involved. */
async function gradeMoneyline(fixtureId: string, marketId: string, homeScore: number, awayScore: number) {
  await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: homeScore, away_score: awayScore }).eq("id", fixtureId);
  const outcome = homeScore > awayScore ? "YES" : "NO";
  const { data: preds } = await admin.from("predictions").select("id, selected_outcome").eq("market_id", marketId).eq("lifecycle_state", "PENDING");
  for (const p of preds ?? []) {
    const result = p.selected_outcome === outcome ? "CORRECT" : "INCORRECT";
    await admin
      .from("predictions")
      .update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: outcome, graded_at: new Date().toISOString() })
      .eq("id", p.id);
  }
}

async function getPredictionId(userId: string, marketId: string): Promise<string> {
  const { data } = await admin.from("predictions").select("id").eq("user_id", userId).eq("market_id", marketId).single();
  return data!.id as string;
}

test.describe("Reputation + Leaderboards", () => {
  test("graded Picks and a resolved Call BS Challenge produce a matching Leaderboard rank and Profile record", async ({ page }) => {
    await admin.from("platform_settings").update({ leaderboard_min_decided_picks: 5, call_bs_enabled: true }).eq("id", true);
    const suffix = randomUUID();
    const userIds: string[] = [];
    const fixtureIds: string[] = [];
    const marketIds: string[] = [];
    const challengeIds: string[] = [];

    try {
      const emailChamp = `e2e-rep-champ-${suffix}@test.local`;
      const emailBelowMin = `e2e-rep-below-${suffix}@test.local`;
      const champ = await createPlayer(emailChamp, "e2erepchamp");
      const belowMin = await createPlayer(emailBelowMin, "e2erepbelow");
      userIds.push(champ.userId, belowMin.userId);

      // The champion makes 6 Picks, all correct — a real, above-minimum,
      // deterministically top-of-leaderboard record (see the sequential
      // ROW_NUMBER tie-break: 6 decided outranks anyone with fewer at the
      // same 100% accuracy this same test creates). Stays logged in as
      // the champion across all 6 — only switching users when the flow
      // actually requires a different one, to keep the test's real
      // browser-interaction cost bounded.
      const champMarkets: Array<{ fixtureId: string; marketId: string }> = [];
      for (let i = 0; i < 6; i++) {
        champMarkets.push(await seedFixtureAndMarket(`e2e-rep-champ-${i}`));
      }
      fixtureIds.push(...champMarkets.map((m) => m.fixtureId));
      marketIds.push(...champMarkets.map((m) => m.marketId));
      await loginAs(page, emailChamp);
      for (const { marketId } of champMarkets) {
        await page.goto(`/markets/${marketId}`);
        await page.getByRole("button", { name: "Pick: Yes" }).click();
        await expect(page.getByText(/You picked Yes/)).toBeVisible();
      }
      await page.context().clearCookies();
      for (const { fixtureId, marketId } of champMarkets) {
        await gradeMoneyline(fixtureId, marketId, 21, 10); // home wins -> YES -> correct
      }

      // The below-minimum user makes only 2 Picks (both correct) — a real
      // record, but not enough to be leaderboard-eligible.
      const belowMinMarkets: Array<{ fixtureId: string; marketId: string }> = [];
      for (let i = 0; i < 2; i++) {
        belowMinMarkets.push(await seedFixtureAndMarket(`e2e-rep-below-${i}`));
      }
      fixtureIds.push(...belowMinMarkets.map((m) => m.fixtureId));
      marketIds.push(...belowMinMarkets.map((m) => m.marketId));
      await loginAs(page, emailBelowMin);
      for (const { marketId } of belowMinMarkets) {
        await page.goto(`/markets/${marketId}`);
        await page.getByRole("button", { name: "Pick: Yes" }).click();
        await expect(page.getByText(/You picked Yes/)).toBeVisible();
      }
      await page.context().clearCookies();
      for (const { fixtureId, marketId } of belowMinMarkets) {
        await gradeMoneyline(fixtureId, marketId, 21, 10);
      }

      // A resolved free Call BS Challenge between the two — the champion
      // wins it, on a SEPARATE Market from the ones already graded above.
      const { fixtureId: cbsFixtureId, marketId: cbsMarketId } = await seedFixtureAndMarket("e2e-rep-cbs");
      fixtureIds.push(cbsFixtureId);
      marketIds.push(cbsMarketId);
      await loginAs(page, emailChamp);
      await page.goto(`/markets/${cbsMarketId}`);
      await page.getByRole("button", { name: "Pick: Yes" }).click();
      await expect(page.getByText(/You picked Yes/)).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailBelowMin);
      await page.goto(`/markets/${cbsMarketId}`);
      await page.getByRole("button", { name: "Pick: No" }).click();
      await expect(page.getByText(/You picked No/)).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Call BS" }).click();
      await expect(page.getByText("Pending")).toBeVisible();

      await page.context().clearCookies();
      await loginAs(page, emailChamp);
      await page.goto(`/markets/${cbsMarketId}`);
      await page.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByText("Accepted")).toBeVisible();

      const champPredictionId = await getPredictionId(champ.userId, cbsMarketId);
      const belowMinPredictionId = await getPredictionId(belowMin.userId, cbsMarketId);
      // belowMin is the one who clicked "Call BS" on champ's opposing row
      // above, making belowMin the CHALLENGER and champ the RECIPIENT
      // (R7's own established assignment: clicking "Call BS" while
      // viewing someone else's opposing Pick makes you the challenger
      // against them) — so champ winning this Challenge is RECIPIENT_WON,
      // not CHALLENGER_WON.
      const { data: challenge } = await admin.from("challenges").select("id, challenger_user_id, recipient_user_id").eq("market_id", cbsMarketId).single();
      challengeIds.push(challenge!.id);
      expect(challenge!.challenger_user_id).toBe(belowMin.userId);
      expect(challenge!.recipient_user_id).toBe(champ.userId);
      // Resolve the accepted Challenge directly (the safe local
      // authoritative-result path for a backend-only job — mirrors
      // p2p-settlement.spec.ts's own direct-RPC pattern for the same
      // reason: no UI trigger for this job exists anywhere in the app).
      await admin
        .from("challenges")
        .update({ status: "RESOLVED", result: "RECIPIENT_WON", resolved_at: new Date().toISOString() })
        .eq("id", challenge!.id);
      // The underlying Picks also grade, home wins -> YES -> champ correct, belowMin incorrect.
      await gradeMoneyline(cbsFixtureId, cbsMarketId, 21, 10);
      expect(champPredictionId).toBeTruthy();
      expect(belowMinPredictionId).toBeTruthy();

      // The champion's Profile shows the full, correct record: 7 correct
      // (6 + the Call BS market), 0 incorrect, 100% accuracy, and a 1-0
      // Call BS record.
      await page.context().clearCookies();
      await loginAs(page, emailChamp);
      await page.goto("/profile");
      await expect(page.getByText("7–0")).toBeVisible();
      await expect(page.getByText("100.0%")).toBeVisible();
      await expect(page.getByText("1–0")).toBeVisible();
      await expect(page.getByText("Not ranked yet")).toHaveCount(0);

      // The Prediction Leaderboard shows the champion at #1 with a
      // matching record. Scoped to the champion's own row (identified by
      // its stable #row-{userId} id) rather than a bare page-wide text
      // search — this leaderboard is global and the shared local test
      // database may carry other 100%-accuracy users from unrelated test
      // runs, which would otherwise make a page-wide "100.0%"/"7–0" search
      // ambiguous.
      await page.goto("/leaderboard/predictions");
      const champRow = page.locator(`#row-${champ.userId}`);
      await expect(champRow).toContainText("#1");
      await expect(champRow).toContainText("7–0");
      await expect(champRow).toContainText("100.0%");

      // The below-minimum user's own Profile shows their real record but
      // is explicitly unranked, and they are absent from the leaderboard.
      await page.context().clearCookies();
      await loginAs(page, emailBelowMin);
      await page.goto("/profile");
      await expect(page.getByText("2–1")).toBeVisible();
      await expect(page.getByText("Not ranked yet")).toBeVisible();

      await page.goto("/leaderboard/predictions");
      const belowMinRow = page.locator(`#row-${belowMin.userId}`);
      await expect(belowMinRow).toHaveCount(0);
    } finally {
      if (challengeIds.length > 0) {
        await admin.from("notifications").delete().in("challenge_id", challengeIds);
        await admin.from("challenges").delete().in("id", challengeIds);
      }
      if (marketIds.length > 0) {
        await admin.from("predictions").delete().in("market_id", marketIds);
        await admin.from("markets").delete().in("id", marketIds);
      }
      if (fixtureIds.length > 0) await admin.from("fixtures").delete().in("id", fixtureIds);
      for (const id of userIds) await admin.auth.admin.deleteUser(id);
    }
  });
});
