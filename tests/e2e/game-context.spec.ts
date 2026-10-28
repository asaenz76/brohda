/**
 * Brohda 2.1 M3 — Game Context in the real UI. Three controlled Games on the real feed: one with a single fact, one with a contrast (two facts), one with nothing worth saying.
 * Proves the line is supporting copy only: the Pick controls are there and work on every card, the Post shows the same line as the card, the logged-out front door shows it too,
 * and with the policy off nothing is shown anywhere. Requires the local Supabase stack, like every spec here.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { getTestAdminClient } from "./helpers/test-env";
import { predict } from "./helpers/predict";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const PROVIDER = "e2e_game_context";
const DAY = 86_400_000;
const SHOTS = process.env.GAME_CONTEXT_SHOTS ?? null;

const suffix = randomUUID().slice(0, 6);
const name = (label: string) => `${label} ${suffix}`;
// "Alpha" = the single-fact Game, "Bravo" = the contrast Game, "Charlie" = nothing to say
const G = {
  single: { home: name("Alpha Aces"), away: name("Alpha Bears"), homeId: `ga-${suffix}`, awayId: `gb-${suffix}`, home_form: "LWWWW", away_form: "WLWLW" },
  contrast: { home: name("Bravo Bulls"), away: name("Bravo Lions"), homeId: `gc-${suffix}`, awayId: `gd-${suffix}`, home_form: "LWWWWW", away_form: "WLLLL" },
  none: { home: name("Charlie Cubs"), away: name("Charlie Crows"), homeId: `ge-${suffix}`, awayId: `gf-${suffix}`, home_form: "WLWLW", away_form: "LWLWL" },
} as const;
type Spec = (typeof G)[keyof typeof G];

const fixtureIds: string[] = [];
const postIds: Record<string, string> = {};

async function createPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: email.split("@")[0], username: `e2egc${Date.now()}${Math.floor(Math.random() * 1000)}`, role: "player", is_active: true });
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

/** A team's finished season: one Game per character, one day apart, ending yesterday-ish; the team is always at home, opponents are fresh. */
function historyRows(teamId: string, teamName: string, results: string) {
  return [...results].map((r, i) => ({
    provider: PROVIDER,
    sport: "american_football",
    external_fixture_id: `gc-hist-${randomUUID()}`,
    season: "2026",
    round: `Regular Season - Week ${i + 1}`,
    home_team_external_id: teamId,
    away_team_external_id: `${teamId}-opp${i}`,
    home_team_name: teamName,
    away_team_name: `Opponent ${teamId}-${i}`,
    scheduled_start_utc: new Date(Date.now() - (results.length - i + 3) * DAY).toISOString(),
    internal_status: "COMPLETED",
    home_score: r === "W" ? 27 : 13,
    away_score: r === "W" ? 13 : 27,
  }));
}

async function seedGame(spec: Spec, startOffsetMinutes: number) {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      sport: "american_football",
      external_fixture_id: `gc-game-${randomUUID()}`,
      season: "2026",
      round: "Regular Season - Week 12",
      home_team_external_id: spec.homeId,
      away_team_external_id: spec.awayId,
      home_team_name: spec.home,
      away_team_name: spec.away,
      // Soonest kickoff sorts first and the feed keeps only FEED_PAGE_SIZE (50) Games, while most other specs seed their Games at +24h and run in parallel. Starting these a half hour out keeps the cards on the first page however crowded the shared feed is (the cause of an intermittent "element(s) not found"), and is far from any pick lock.
      scheduled_start_utc: new Date(Date.now() + 30 * 60_000 + startOffsetMinutes * 60_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  const fixtureId = data.id as string;
  fixtureIds.push(fixtureId);
  const { error: marketError } = await admin.from("markets").insert({
    provider: PROVIDER, provider_market_id: `m-${randomUUID()}`, question: `Will ${spec.home} win?`, status: "ACTIVE", fixture_id: fixtureId, market_template: "MONEYLINE", yes_side: "HOME",
    yes_price: 0.6, no_price: 0.4, price_outcome_labels: { yes: "Home wins", no: "Home does not win" }, last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test", provider_metadata: {},
  });
  if (marketError) throw marketError;
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  postIds[spec.home] = post.id as string;
  return fixtureId;
}

const setPolicy = async (enabled: boolean) => {
  const { error } = await admin.from("platform_settings").update({ game_context_enabled: enabled, game_context_config: null }).eq("id", true);
  if (error) throw error;
};
const card = (page: Page, spec: Spec) => page.getByRole("article", { name: new RegExp(`Game: (${spec.away} at ${spec.home}|${spec.home} vs ${spec.away})`) });
const line = (page: Page, spec: Spec) => card(page, spec).locator('[data-slot="game-context"]');

const SINGLE_TEXT = `${G.single.home} have won 4 straight. ${G.single.away} are trying to stop the streak.`;
const CONTRAST_TEXT = `${G.contrast.home} have won 5 straight. ${G.contrast.away} have lost 4 straight.`;

test.describe("Game Context", () => {
  // One worker for the whole file: beforeAll seeds the shared Games and flips the global Game Context policy, and afterAll deletes every fixture of this provider and switches the policy off. Under fullyParallel each worker would run its own copy and tear down the others' data mid-test.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    for (const spec of Object.values(G)) {
      const rows = [...historyRows(spec.homeId, spec.home, spec.home_form), ...historyRows(spec.awayId, spec.away, spec.away_form)];
      const { error } = await admin.from("fixtures").insert(rows);
      if (error) throw error;
    }
    await seedGame(G.single, 0);
    await seedGame(G.contrast, 1);
    await seedGame(G.none, 2);
    await setPolicy(true);
  });

  test.afterAll(async () => {
    await setPolicy(false);
    await admin.from("predictions").delete().in("market_id", ((await admin.from("markets").select("id").in("fixture_id", fixtureIds)).data ?? []).map((m) => m.id));
    await admin.from("markets").delete().in("fixture_id", fixtureIds);
    await admin.from("posts").delete().in("fixture_id", fixtureIds);
    await admin.from("fixtures").delete().eq("provider", PROVIDER);
  });

  test("the feed shows a single-fact line, a contrast line, and nothing for a Game with nothing to say — and every card keeps its Pick controls", async ({ page }) => {
    const email = `e2e-gc-${randomUUID()}@example.com`;
    await createPlayer(email);
    await loginAs(page, email);

    await expect(line(page, G.single)).toHaveText(SINGLE_TEXT);
    await expect(line(page, G.contrast)).toHaveText(CONTRAST_TEXT);
    await expect(card(page, G.none)).toBeVisible();
    await expect(line(page, G.none)).toHaveCount(0);
    // no placeholder, no blank box, no filler where a line is absent
    await expect(card(page, G.none)).not.toContainText(/context|no data|n\/a|unavailable/i);

    // the Pick controls are on every card, with and without a line
    for (const spec of Object.values(G)) {
      await expect(card(page, spec).getByRole("button", { name: `Pick ${spec.home} to win` })).toBeVisible();
      await expect(card(page, spec).getByRole("button", { name: `Pick ${spec.away} to win` })).toBeVisible();
    }

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await card(page, G.single).screenshot({ path: `${SHOTS}/feed-single-fact.png` });
      await card(page, G.contrast).screenshot({ path: `${SHOTS}/feed-contrast.png` });
      await card(page, G.none).screenshot({ path: `${SHOTS}/feed-no-context.png` });
    }
  });

  test("a Pick works on a Game that has a line, and the line is still there after", async ({ page }) => {
    const email = `e2e-gc-pick-${randomUUID()}@example.com`;
    await createPlayer(email);
    await loginAs(page, email);
    const scope = card(page, G.single);
    await expect(line(page, G.single)).toHaveText(SINGLE_TEXT);
    await predict(scope, `Pick ${G.single.home} to win`, 1);
    await expect(scope).toContainText(`You picked ${G.single.home}`);
    await expect(line(page, G.single)).toHaveText(SINGLE_TEXT);
  });

  test("the Post shows exactly the same line as its card", async ({ page }) => {
    const email = `e2e-gc-post-${randomUUID()}@example.com`;
    await createPlayer(email);
    await loginAs(page, email);
    await page.goto(`/post/${postIds[G.contrast.home]}`);
    await expect(page.locator('[data-slot="game-context"]')).toHaveText(CONTRAST_TEXT);
    await page.goto(`/post/${postIds[G.none.home]}`);
    await expect(page.getByText(G.none.home).first()).toBeVisible();
    await expect(page.locator('[data-slot="game-context"]')).toHaveCount(0);
    if (SHOTS) {
      await page.goto(`/post/${postIds[G.single.home]}`);
      await expect(page.locator('[data-slot="game-context"]')).toHaveText(SINGLE_TEXT);
      await page.screenshot({ path: `${SHOTS}/post-single-fact.png`, fullPage: false });
    }
  });

  test("the logged-out front door shows the same line (plain text, nothing to act on)", async ({ page }) => {
    await page.goto("/");
    await expect(line(page, G.single)).toHaveText(SINGLE_TEXT);
    await expect(card(page, G.none)).toBeVisible();
    await expect(line(page, G.none)).toHaveCount(0);
  });

  test("the cards stay on the first page of a crowded feed (52 Games that kick off after them)", async ({ page }) => {
    const crowd = Array.from({ length: 52 }, (_, i) => ({ provider: PROVIDER, sport: "american_football", external_fixture_id: `gc-crowd-${randomUUID()}`, season: "2026", home_team_name: `Crowd Home ${suffix} ${i}`, away_team_name: `Crowd Away ${suffix} ${i}`, scheduled_start_utc: new Date(Date.now() + 60 * 60_000 + i * 60_000).toISOString(), internal_status: "NOT_STARTED" }));
    const { data: fixtures, error } = await admin.from("fixtures").insert(crowd).select("id");
    if (error || !fixtures) throw error ?? new Error("failed to seed the crowd");
    fixtureIds.push(...fixtures.map((f) => f.id as string));
    const { error: postError } = await admin.from("posts").insert(fixtures.map((f) => ({ fixture_id: f.id as string, published_at: new Date().toISOString() })));
    if (postError) throw postError;
    const email = `e2e-gc-crowd-${randomUUID()}@example.com`;
    await createPlayer(email);
    await loginAs(page, email);
    await expect(line(page, G.single)).toHaveText(SINGLE_TEXT);
    await expect(line(page, G.contrast)).toHaveText(CONTRAST_TEXT);
  });

  test("with the policy off, no line appears anywhere and the feed is unchanged", async ({ page }) => {
    await setPolicy(false);
    try {
      const email = `e2e-gc-off-${randomUUID()}@example.com`;
      await createPlayer(email);
      await loginAs(page, email);
      await expect(card(page, G.single)).toBeVisible();
      await expect(page.locator('[data-slot="game-context"]')).toHaveCount(0);
      await expect(card(page, G.single).getByRole("button", { name: `Pick ${G.single.home} to win` })).toBeVisible();
      await page.goto(`/post/${postIds[G.contrast.home]}`);
      await expect(page.locator('[data-slot="game-context"]')).toHaveCount(0);
    } finally {
      await setPolicy(true);
    }
  });
});
