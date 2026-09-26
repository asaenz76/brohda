/**
 * E2E coverage for the canonical Brohda 2.0 social discovery feed at
 * `/markets` (Milestone R13.10, Stage 4A remediation of the Stage 4
 * pre-exposure audit's P0 finding — an ordinary user previously had no
 * in-app way to discover a Post/Market/Community at all). Read-only browse
 * surface — no prediction submission, no order, no wallet. Requires the
 * local Supabase stack (`pnpm supabase:start`) — `pnpm test:e2e` handles
 * the rest.
 *
 * This spec replaces the prior Milestone-2-era coverage of `/markets` as a
 * raw Market-browse page with category tabs — that engine
 * (getDiscoveryFeed/discovery_categories) is untouched and still covered
 * at the repository/RLS level by tests/integration/discovery-categories.test.ts;
 * it simply no longer backs this route, which now serves the canonical
 * Post-centric feed instead (see app/(app)/markets/page.tsx's own header
 * comment for the full architecture decision). `/markets/[id]` (Market
 * detail) is unchanged and still covered here as a direct deep link.
 *
 * Every seeded fixture's team names embed this test's unique suffix — not
 * just its external id — because Playwright's text matchers match by
 * visible content, and a prior run's leftover row (if a run is ever
 * interrupted before its own cleanup) would otherwise collide with an
 * identically-worded question from a fresh run.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const PROVIDER = "e2e_discovery_feed";

async function createPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `e2edisc${Date.now()}${Math.floor(Math.random() * 1000)}`,
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

async function seedTeam(name: string) {
  const externalId = `team-${randomUUID()}`;
  const { data, error } = await admin.from("teams").insert({ provider: PROVIDER, external_id: externalId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create team");
  return { id: data.id as string, externalId };
}

async function seedFixture(homeTeamName: string, awayTeamName: string, homeExternalId: string | null = null): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `e2e-feed-${randomUUID()}`,
      home_team_external_id: homeExternalId,
      home_team_name: homeTeamName,
      away_team_name: awayTeamName,
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  return data.id as string;
}

async function seedMarket(fixtureId: string, question: string, outcomeLabels: { yes: string; no: string } = { yes: "Home wins", no: "Home does not win" }) {
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider: PROVIDER,
      provider_market_id: `m-${randomUUID()}`,
      question,
      status: "ACTIVE",
      fixture_id: fixtureId,
      market_template: "MONEYLINE",
      yes_side: "HOME",
      yes_price: 0.62,
      no_price: 0.38,
      price_outcome_labels: outcomeLabels,
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create market");
  return data.id as string;
}

async function seedPublishedPost(fixtureId: string) {
  const { data, error } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create post");
  return data.id as string;
}

async function cleanup(fixtureIds: string[], teamIds: string[]) {
  const { data: posts } = await admin.from("posts").select("id").in("fixture_id", fixtureIds);
  const postIds = (posts ?? []).map((p) => p.id);
  if (postIds.length > 0) await admin.from("post_communities").delete().in("post_id", postIds);
  await admin.from("markets").delete().in("fixture_id", fixtureIds);
  await admin.from("posts").delete().in("fixture_id", fixtureIds);
  await admin.from("fixtures").delete().in("id", fixtureIds);
  if (teamIds.length > 0) await admin.from("communities").delete().in("team_id", teamIds);
  if (teamIds.length > 0) await admin.from("teams").delete().in("id", teamIds);
}

test.describe("social discovery feed", () => {
  test("a brand-new user with zero Community follows still sees eligible published Posts, with semantic Market labels and no raw enum leakage", async ({ page }) => {
    const suffix = randomUUID();
    const homeTeamName = `E2E Home ${suffix}`;
    const awayTeamName = `E2E Away ${suffix}`;
    const fixtureId = await seedFixture(homeTeamName, awayTeamName);
    const question = `Will the E2E Home ${suffix} win?`;
    const yesLabel = `E2E Home ${suffix} wins`;
    const noLabel = `E2E Home ${suffix} does not win`;
    await seedMarket(fixtureId, question, { yes: yesLabel, no: noLabel });
    await seedPublishedPost(fixtureId);

    const email = `e2e-feed-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto("/markets");

      // Scoped to this test's own card — the shared feed is global, so
      // other E2E workers' concurrently-seeded Posts are also visible on
      // this same page; every locator below is anchored to this test's own
      // unique suffix to avoid a strict-mode collision with them.
      const card = page.locator("a", { hasText: `${awayTeamName} @ ${homeTeamName}` });
      await expect(card).toBeVisible();
      await expect(card.getByText(question)).toBeVisible();

      // Semantic selection labels, never the raw YES/NO enum, on the feed card.
      await expect(card.getByText(yesLabel)).toBeVisible();
      await expect(card.getByText(noLabel)).toBeVisible();
      await expect(card.getByText(/^\s*yes\s*$/i)).toHaveCount(0);
      await expect(card.getByText(/^\s*no\s*$/i)).toHaveCount(0);

      // No prediction/order/trade/financial UI on the discovery surface itself.
      await expect(page.getByRole("button", { name: /buy|sell|trade|enter/i })).toHaveCount(0);
      await expect(page.getByText(/put money on it|potential return/i)).toHaveCount(0);

      // Opening the Post reaches the canonical Post, not a copy.
      await card.click();
      await expect(page).toHaveURL(/\/post\//);
    } finally {
      await cleanup([fixtureId], []);
    }
  });

  test("a followed Community's Post is visually prioritized/marked, without hiding other eligible Posts", async ({ page }) => {
    const suffix = randomUUID();
    const followedTeamName = `E2E Followed Team ${suffix}`;
    const followedTeam = await seedTeam(followedTeamName);
    const otherHomeTeamName = `E2E Unfollowed Home ${suffix}`;

    const followedFixtureId = await seedFixture(followedTeamName, `E2E Away vs Followed ${suffix}`, followedTeam.externalId);
    await seedMarket(followedFixtureId, `Will the ${followedTeamName} win?`);
    await seedPublishedPost(followedFixtureId);

    const otherFixtureId = await seedFixture(otherHomeTeamName, `E2E Away vs Other ${suffix}`);
    await seedMarket(otherFixtureId, `Will the ${otherHomeTeamName} win?`);
    await seedPublishedPost(otherFixtureId);

    const email = `e2e-feed-follow-${suffix}@example.com`;
    const userId = await createPlayer(email);

    // Distribution normally happens via the community-distribution cron
    // job — this test seeds the resulting rows directly via the admin
    // client (matching this file's own established seedTeam/seedFixture/
    // seedMarket pattern) rather than calling server-only domain code from
    // a Playwright test process.
    const { data: post } = await admin.from("posts").select("id").eq("fixture_id", followedFixtureId).single();
    const { data: community } = await admin
      .from("communities")
      .insert({ type: "TEAM", team_id: followedTeam.id, slug: `e2e-followed-${suffix}` })
      .select("id")
      .single();
    await admin.from("post_communities").insert({ post_id: post!.id, community_id: community!.id });
    await admin.from("community_follows").insert({ user_id: userId, community_id: community!.id });

    try {
      await loginAs(page, email);
      await page.goto("/markets");

      // Scoped to each test's own card — see the previous test's own note
      // on why (the shared feed is global across concurrently-running
      // E2E workers).
      const followedCard = page.locator("a", { hasText: `E2E Away vs Followed ${suffix}` });
      const otherCard = page.locator("a", { hasText: `E2E Away vs Other ${suffix}` });
      await expect(followedCard.getByText("Following")).toBeVisible();
      await expect(otherCard).toBeVisible();
      await expect(otherCard.getByText("Following")).toHaveCount(0);
    } finally {
      await admin.from("community_follows").delete().eq("user_id", userId);
      await admin.from("post_communities").delete().eq("community_id", community!.id);
      await admin.from("communities").delete().eq("id", community!.id);
      await cleanup([followedFixtureId, otherFixtureId], [followedTeam.id]);
    }
  });
});

test.describe("market detail deep link", () => {
  test("a Market is still reachable directly at /markets/[id]", async ({ page }) => {
    const suffix = randomUUID();
    const fixtureId = await seedFixture(`E2E Detail Home ${suffix}`, `E2E Detail Away ${suffix}`);
    const question = `Will the E2E Detail Home ${suffix} win?`;
    const marketId = await seedMarket(fixtureId, question);

    const email = `e2e-market-detail-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto(`/markets/${marketId}`);
      await expect(page.getByText(question)).toBeVisible();
    } finally {
      await cleanup([fixtureId], []);
    }
  });
});
