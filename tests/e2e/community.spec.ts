/**
 * E2E coverage for Phase E's redesigned `/community/[slug]` — the
 * canonical Brohda 2.0 Community experience (social topic/profile
 * timeline: identity, follow state, real Game Posts, never a sports-data
 * dashboard or sportsbook). Requires the local Supabase stack (`pnpm
 * supabase:start`) — `pnpm test:e2e` handles the rest.
 *
 * Every seeded record embeds this test's unique suffix to avoid collisions
 * with other concurrently-running E2E workers' own seeded fixtures.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const PROVIDER = "e2e_community";

async function createPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `e2ecomm${Date.now()}${Math.floor(Math.random() * 1000)}`,
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

async function seedTeamCommunity(name: string, logoUrl: string | null = null) {
  const { data: team, error: teamError } = await admin.from("teams").insert({ provider: PROVIDER, external_id: `team-${randomUUID()}`, name, logo_url: logoUrl }).select("id").single();
  if (teamError || !team) throw teamError ?? new Error("failed to create team");
  const { data: community, error: communityError } = await admin
    .from("communities")
    .insert({ type: "TEAM", team_id: team.id, slug: `e2e-comm-team-${randomUUID()}`, active: true })
    .select("id, slug")
    .single();
  if (communityError || !community) throw communityError ?? new Error("failed to create community");
  return { teamId: team.id as string, communityId: community.id as string, slug: community.slug as string };
}

async function seedLeagueCommunity(name: string) {
  const { data: league, error: leagueError } = await admin.from("leagues").insert({ provider: PROVIDER, external_id: `league-${randomUUID()}`, name }).select("id").single();
  if (leagueError || !league) throw leagueError ?? new Error("failed to create league");
  const { data: community, error: communityError } = await admin
    .from("communities")
    .insert({ type: "LEAGUE", league_id: league.id, slug: `e2e-comm-league-${randomUUID()}`, active: true })
    .select("id, slug")
    .single();
  if (communityError || !community) throw communityError ?? new Error("failed to create community");
  return { leagueId: league.id as string, communityId: community.id as string, slug: community.slug as string };
}

async function seedSportCommunity(sportKey: string, displayName: string) {
  const { data: community, error } = await admin
    .from("communities")
    .insert({ type: "SPORT", sport_key: sportKey, display_name: displayName, slug: `e2e-comm-sport-${randomUUID()}`, active: true })
    .select("id, slug")
    .single();
  if (error || !community) throw error ?? new Error("failed to create sport community");
  return { communityId: community.id as string, slug: community.slug as string };
}

/** The Game Post card for a Game whose home team is `teamName` (unique per test). The Moneyline no longer prints a question line, so the card is found by its Game. */
function gameCard(page: Page, teamName: string) {
  return page.getByRole("article", { name: new RegExp(` at ${teamName}$`) });
}

async function seedFixtureAndPost(homeTeamName: string, awayTeamName: string, question: string) {
  const { data: fixture, error: fixtureError } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      sport: "american_football",
      external_fixture_id: `e2e-comm-fixture-${randomUUID()}`,
      home_team_name: homeTeamName,
      away_team_name: awayTeamName,
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
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
      yes_price: 0.55,
      no_price: 0.45,
      price_outcome_labels: { yes: `${homeTeamName} wins`, no: `${homeTeamName} does not win` },
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
    })
    .select("id")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");

  return { fixtureId: fixture.id as string, postId: post.id as string, marketId: market.id as string };
}

async function cleanup(opts: { fixtureIds?: string[]; teamIds?: string[]; leagueIds?: string[]; communityIds?: string[] }) {
  const { fixtureIds = [], teamIds = [], leagueIds = [], communityIds = [] } = opts;
  if (communityIds.length > 0) {
    await admin.from("post_communities").delete().in("community_id", communityIds);
    await admin.from("community_follows").delete().in("community_id", communityIds);
    await admin.from("communities").delete().in("id", communityIds);
  }
  if (fixtureIds.length > 0) {
    await admin.from("markets").delete().in("fixture_id", fixtureIds);
    await admin.from("posts").delete().in("fixture_id", fixtureIds);
    await admin.from("fixtures").delete().in("id", fixtureIds);
  }
  if (teamIds.length > 0) await admin.from("teams").delete().in("id", teamIds);
  if (leagueIds.length > 0) await admin.from("leagues").delete().in("id", leagueIds);
}

test.describe("Community", () => {
  test("a TEAM Community shows identity, type label, crest, and a real Game Post with Pick/sentiment/comment content", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E Community Team ${suffix}`;
    const { teamId, communityId, slug } = await seedTeamCommunity(teamName, "https://example.com/crest.png");
    const question = `Will the ${teamName} win?`;
    const { fixtureId } = await seedFixtureAndPost(teamName, `E2E Away ${suffix}`, question);
    await admin.from("post_communities").insert({ post_id: (await admin.from("posts").select("id").eq("fixture_id", fixtureId).single()).data!.id, community_id: communityId });

    const email = `e2e-comm-team-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await page.goto(`/login`);
      await loginAs(page, email);
      await page.goto(`/community/${slug}`);

      // Scoped to the header Card specifically — the team name also
      // legitimately appears in the seeded Post's own matchup/question/Pick
      // content below it (this test's fixture reuses the same team as the
      // Community's own team), so an unscoped page-wide locator would be
      // ambiguous (Playwright strict mode).
      const header = page.locator('[data-slot="card"]').first();
      await expect(header.getByText("Team", { exact: true })).toBeVisible();
      await expect(header.getByText(teamName)).toBeVisible();
      await expect(header.getByRole("button", { name: "Follow" })).toBeVisible();

      await expect(gameCard(page, teamName)).toBeVisible();
      // Pick-first: this viewer hasn't picked, so the crowd split stays hidden behind the nudge.
      await expect(page.getByText("Make your pick to see how everyone else picked.")).toBeVisible();
      await expect(page.getByText(/comment/i)).toBeVisible();
    } finally {
      await cleanup({ fixtureIds: [fixtureId], teamIds: [teamId], communityIds: [communityId] });
    }
  });

  test("a LEAGUE Community shows the League type label", async ({ page }) => {
    const suffix = randomUUID();
    const leagueName = `E2E Community League ${suffix}`;
    const { leagueId, communityId, slug } = await seedLeagueCommunity(leagueName);

    const email = `e2e-comm-league-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto(`/community/${slug}`);
      await expect(page.getByText("League", { exact: true })).toBeVisible();
      await expect(page.getByText(leagueName)).toBeVisible();
    } finally {
      await cleanup({ leagueIds: [leagueId], communityIds: [communityId] });
    }
  });

  test("a SPORT Community shows the Sport type label and no crest image", async ({ page }) => {
    const suffix = randomUUID();
    const sportName = `E2E Community Sport ${suffix}`;
    const { communityId, slug } = await seedSportCommunity(`e2e_sport_${suffix}`, sportName);

    const email = `e2e-comm-sport-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto(`/community/${slug}`);
      await expect(page.getByText("Sport", { exact: true })).toBeVisible();
      await expect(page.getByText(sportName)).toBeVisible();
      await expect(page.locator("img")).toHaveCount(0);
    } finally {
      await cleanup({ communityIds: [communityId] });
    }
  });

  test("an empty Community shows a restrained empty state with no Pool/market/betting language, and identity/follow remain visible", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E Empty Community Team ${suffix}`;
    const { teamId, communityId, slug } = await seedTeamCommunity(teamName);

    const email = `e2e-comm-empty-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto(`/community/${slug}`);
      await expect(page.getByText(teamName)).toBeVisible();
      await expect(page.getByRole("button", { name: "Follow" })).toBeVisible();

      const bodyText = (await page.locator("main").innerText()).toLowerCase();
      expect(bodyText).not.toMatch(/\bpool\b|\bbet\b|\bodds\b|\bwager\b|\bstake\b/);
    } finally {
      await cleanup({ teamIds: [teamId], communityIds: [communityId] });
    }
  });

  test("an unknown Community slug 404s cleanly, with no raw database error", async ({ page }) => {
    const email = `e2e-comm-404-${randomUUID()}@example.com`;
    await createPlayer(email);
    await loginAs(page, email);

    const response = await page.goto(`/community/does-not-exist-${randomUUID()}`);
    expect(response?.status()).toBe(404);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.toLowerCase()).not.toMatch(/error|exception|stack|postgres|supabase/);
  });

  test("a Post distributed to both a Team and a League Community appears exactly once on each Community's own page", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E Dedup Team ${suffix}`;
    const { teamId, communityId: teamCommunityId, slug: teamSlug } = await seedTeamCommunity(teamName);
    const leagueName = `E2E Dedup League ${suffix}`;
    const { leagueId, communityId: leagueCommunityId, slug: leagueSlug } = await seedLeagueCommunity(leagueName);

    const question = `Will the ${teamName} win the big one?`;
    const { fixtureId, postId } = await seedFixtureAndPost(teamName, `E2E Dedup Away ${suffix}`, question);
    await admin.from("post_communities").insert([
      { post_id: postId, community_id: teamCommunityId },
      { post_id: postId, community_id: leagueCommunityId },
    ]);

    const email = `e2e-comm-dedup-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);

      await page.goto(`/community/${teamSlug}`);
      await expect(gameCard(page, teamName)).toHaveCount(1);

      await page.goto(`/community/${leagueSlug}`);
      await expect(gameCard(page, teamName)).toHaveCount(1);
    } finally {
      await cleanup({ fixtureIds: [fixtureId], teamIds: [teamId], leagueIds: [leagueId], communityIds: [teamCommunityId, leagueCommunityId] });
    }
  });

  test("never leaks the raw CommunityType enum on the Community page", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E No Enum Community Team ${suffix}`;
    const { teamId, communityId, slug } = await seedTeamCommunity(teamName);

    const email = `e2e-comm-enum-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto(`/community/${slug}`);
      await expect(page.getByText(teamName)).toBeVisible();
      await expect(page.getByText(/^\s*TEAM\s*$/)).toHaveCount(0);
      await expect(page.getByText(/^\s*LEAGUE\s*$/)).toHaveCount(0);
      await expect(page.getByText(/^\s*SPORT\s*$/)).toHaveCount(0);
    } finally {
      await cleanup({ teamIds: [teamId], communityIds: [communityId] });
    }
  });

  test("mobile (375px): Community page has no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const suffix = randomUUID();
    const teamName = `E2E Mobile Community Team ${suffix}`;
    const { teamId, communityId, slug } = await seedTeamCommunity(teamName);
    const question = `Will the ${teamName} win on mobile?`;
    const { fixtureId } = await seedFixtureAndPost(teamName, `E2E Mobile Away ${suffix}`, question);
    const post = await admin.from("posts").select("id").eq("fixture_id", fixtureId).single();
    await admin.from("post_communities").insert({ post_id: post.data!.id, community_id: communityId });

    const email = `e2e-comm-mobile-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto(`/community/${slug}`);
      await expect(gameCard(page, teamName)).toBeVisible();

      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(hasOverflow).toBe(false);
    } finally {
      await cleanup({ fixtureIds: [fixtureId], teamIds: [teamId], communityIds: [communityId] });
    }
  });
});
