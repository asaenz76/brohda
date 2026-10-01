/**
 * Integration tests for Phase F (Brohda 2.0 redesign) additions:
 * - lib/communities/profile.ts's listFollowedCommunitiesForProfile (the
 *   Profile "Communities" tab's own query).
 * - lib/predictions/post-links.ts's listPostIdsForMarkets (Prediction
 *   history rows' /post/[id] link resolution).
 * Real local Supabase throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { listFollowedCommunitiesForProfile } from "@/lib/communities/profile";
import { listPostIdsForMarkets } from "@/lib/predictions/post-links";

const admin = getTestAdminClient();
const PROVIDER = "f_profile_test";

const createdTeamIds: string[] = [];
const createdLeagueIds: string[] = [];
const createdCommunityIds: string[] = [];
const createdUserIds: string[] = [];
const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdPostIds: string[] = [];

async function createUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `f-profile-${crypto.randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "F Profile Test", role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function createTeamCommunity(name: string): Promise<string> {
  const { data: team, error: teamError } = await admin.from("teams").insert({ provider: PROVIDER, external_id: `team-${crypto.randomUUID()}`, name }).select("id").single();
  if (teamError || !team) throw teamError ?? new Error("failed to create team");
  createdTeamIds.push(team.id);
  const { data: community, error } = await admin.from("communities").insert({ type: "TEAM", team_id: team.id, slug: `f-team-${crypto.randomUUID()}`, active: true }).select("id").single();
  if (error || !community) throw error ?? new Error("failed to create community");
  createdCommunityIds.push(community.id);
  return community.id;
}

async function createLeagueCommunity(name: string): Promise<string> {
  const { data: league, error: leagueError } = await admin.from("leagues").insert({ provider: PROVIDER, external_id: `league-${crypto.randomUUID()}`, name }).select("id").single();
  if (leagueError || !league) throw leagueError ?? new Error("failed to create league");
  createdLeagueIds.push(league.id);
  const { data: community, error } = await admin.from("communities").insert({ type: "LEAGUE", league_id: league.id, slug: `f-league-${crypto.randomUUID()}`, active: true }).select("id").single();
  if (error || !community) throw error ?? new Error("failed to create community");
  createdCommunityIds.push(community.id);
  return community.id;
}

async function createSportCommunity(displayName: string): Promise<string> {
  const { data: community, error } = await admin.from("communities").insert({ type: "SPORT", sport_key: `f_sport_${crypto.randomUUID()}`, display_name: displayName, slug: `f-sport-${crypto.randomUUID()}`, active: true }).select("id").single();
  if (error || !community) throw error ?? new Error("failed to create sport community");
  createdCommunityIds.push(community.id);
  return community.id;
}

async function follow(userId: string, communityId: string) {
  await admin.from("community_follows").insert({ user_id: userId, community_id: communityId });
}

afterEach(async () => {
  if (createdPostIds.length > 0) {
    await admin.from("posts").delete().in("id", createdPostIds);
    createdPostIds.length = 0;
  }
  if (createdMarketIds.length > 0) {
    await admin.from("markets").delete().in("id", createdMarketIds);
    createdMarketIds.length = 0;
  }
  if (createdFixtureIds.length > 0) {
    await admin.from("fixtures").delete().in("id", createdFixtureIds);
    createdFixtureIds.length = 0;
  }
  if (createdCommunityIds.length > 0) {
    await admin.from("community_follows").delete().in("community_id", createdCommunityIds);
    await admin.from("communities").delete().in("id", createdCommunityIds);
    createdCommunityIds.length = 0;
  }
  if (createdTeamIds.length > 0) {
    await admin.from("teams").delete().in("id", createdTeamIds);
    createdTeamIds.length = 0;
  }
  if (createdLeagueIds.length > 0) {
    await admin.from("leagues").delete().in("id", createdLeagueIds);
    createdLeagueIds.length = 0;
  }
  for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
  createdUserIds.length = 0;
});

describe("listFollowedCommunitiesForProfile", () => {
  it("returns an empty list for a user who follows nothing", async () => {
    const owner = await createUser();
    await expect(listFollowedCommunitiesForProfile(owner, null)).resolves.toEqual([]);
  });

  it("groups by type in Sports, Leagues, Teams order, omitting empty groups", async () => {
    const owner = await createUser();
    const team = await createTeamCommunity("Z Team");
    const sport = await createSportCommunity("A Sport");
    await follow(owner, team);
    await follow(owner, sport);

    const groups = await listFollowedCommunitiesForProfile(owner, null);
    expect(groups.map((g) => g.type)).toEqual(["SPORT", "TEAM"]);
  });

  it("sorts items within a group alphabetically by display name", async () => {
    const owner = await createUser();
    const teamB = await createTeamCommunity("Bravo Team");
    const teamA = await createTeamCommunity("Alpha Team");
    await follow(owner, teamB);
    await follow(owner, teamA);

    const groups = await listFollowedCommunitiesForProfile(owner, null);
    const teamGroup = groups.find((g) => g.type === "TEAM")!;
    expect(teamGroup.items.map((i) => i.displayName)).toEqual(["Alpha Team", "Bravo Team"]);
  });

  it("reflects the VIEWER's own follow state, not the profile owner's", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const team = await createTeamCommunity("Shared Team");
    await follow(owner, team);
    await follow(viewer, team);

    const groups = await listFollowedCommunitiesForProfile(owner, viewer);
    const item = groups.flatMap((g) => g.items).find((i) => i.id === team);
    expect(item?.isFollowing).toBe(true);
  });

  it("shows isFollowing: false for a viewer who doesn't follow the Community themselves, even though it's in the owner's list", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const team = await createTeamCommunity("Owner Only Team");
    await follow(owner, team);

    const groups = await listFollowedCommunitiesForProfile(owner, viewer);
    const item = groups.flatMap((g) => g.items).find((i) => i.id === team);
    expect(item?.isFollowing).toBe(false);
  });

  it("with no authenticated viewer (null), every item is isFollowing: false rather than throwing", async () => {
    const owner = await createUser();
    const team = await createTeamCommunity("Anon Viewer Team");
    await follow(owner, team);

    const groups = await listFollowedCommunitiesForProfile(owner, null);
    expect(groups.flatMap((g) => g.items).every((i) => i.isFollowing === false)).toBe(true);
  });

  it("never leaks the raw CommunityType enum as a displayName", async () => {
    const owner = await createUser();
    const league = await createLeagueCommunity("Test League");
    await follow(owner, league);

    const groups = await listFollowedCommunitiesForProfile(owner, null);
    for (const group of groups) {
      for (const item of group.items) {
        expect(["TEAM", "LEAGUE", "SPORT"]).not.toContain(item.displayName);
      }
    }
  });
});

describe("listPostIdsForMarkets", () => {
  async function seedMarketWithPost(opts: { published?: boolean } = {}): Promise<{ marketId: string; postId: string | null }> {
    const { data: fixture, error: fixtureError } = await admin
      .from("fixtures")
      .insert({ provider: PROVIDER, external_fixture_id: `f-fixture-${crypto.randomUUID()}`, home_team_name: "Home", away_team_name: "Away", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
      .select("id")
      .single();
    if (fixtureError || !fixture) throw fixtureError ?? new Error("failed to create fixture");
    createdFixtureIds.push(fixture.id);

    const { data: market, error: marketError } = await admin
      .from("markets")
      .insert({ provider: PROVIDER, provider_market_id: `m-${crypto.randomUUID()}`, question: "Will it happen?", status: "ACTIVE", fixture_id: fixture.id, market_template: "MONEYLINE", yes_side: "HOME", price_outcome_labels: { yes: "Yes", no: "No" }, last_synced_at: new Date().toISOString(), ingestion_source: "test", provider_metadata: {} })
      .select("id")
      .single();
    if (marketError || !market) throw marketError ?? new Error("failed to create market");
    createdMarketIds.push(market.id);

    let postId: string | null = null;
    if (opts.published !== false) {
      const { data: post, error: postError } = await admin
        .from("posts")
        .insert({ fixture_id: fixture.id, published_at: new Date().toISOString() })
        .select("id")
        .single();
      if (postError || !post) throw postError ?? new Error("failed to create post");
      createdPostIds.push(post.id);
      postId = post.id;
    }
    return { marketId: market.id, postId };
  }

  it("resolves a market's own Post id when one exists and is published", async () => {
    const { marketId, postId } = await seedMarketWithPost();
    const result = await listPostIdsForMarkets([marketId]);
    expect(result.get(marketId)).toBe(postId);
  });

  it("omits a market whose fixture has no Post at all", async () => {
    const { data: fixture } = await admin
      .from("fixtures")
      .insert({ provider: PROVIDER, external_fixture_id: `f-fixture-nopost-${crypto.randomUUID()}`, home_team_name: "Home", away_team_name: "Away", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
      .select("id")
      .single();
    createdFixtureIds.push(fixture!.id);
    const { data: market } = await admin
      .from("markets")
      .insert({ provider: PROVIDER, provider_market_id: `m-nopost-${crypto.randomUUID()}`, question: "No post market", status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", price_outcome_labels: { yes: "Yes", no: "No" }, last_synced_at: new Date().toISOString(), ingestion_source: "test", provider_metadata: {} })
      .select("id")
      .single();
    createdMarketIds.push(market!.id);

    const result = await listPostIdsForMarkets([market!.id]);
    expect(result.has(market!.id)).toBe(false);
  });

  it("omits a market whose Post exists but is not yet published", async () => {
    const { data: fixture } = await admin
      .from("fixtures")
      .insert({ provider: PROVIDER, external_fixture_id: `f-fixture-unpub-${crypto.randomUUID()}`, home_team_name: "Home", away_team_name: "Away", scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(), internal_status: "NOT_STARTED" })
      .select("id")
      .single();
    createdFixtureIds.push(fixture!.id);
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: null }).select("id").single();
    createdPostIds.push(post!.id);
    const { data: market } = await admin
      .from("markets")
      .insert({ provider: PROVIDER, provider_market_id: `m-unpub-${crypto.randomUUID()}`, question: "Unpublished post market", status: "ACTIVE", fixture_id: fixture!.id, market_template: "MONEYLINE", yes_side: "HOME", price_outcome_labels: { yes: "Yes", no: "No" }, last_synced_at: new Date().toISOString(), ingestion_source: "test", provider_metadata: {} })
      .select("id")
      .single();
    createdMarketIds.push(market!.id);

    const result = await listPostIdsForMarkets([market!.id]);
    expect(result.has(market!.id)).toBe(false);
  });

  it("returns an empty map for an empty input, not an error", async () => {
    await expect(listPostIdsForMarkets([])).resolves.toEqual(new Map());
  });

  it("is batched — resolves multiple markets across multiple fixtures in one call", async () => {
    const a = await seedMarketWithPost();
    const b = await seedMarketWithPost();
    const result = await listPostIdsForMarkets([a.marketId, b.marketId]);
    expect(result.get(a.marketId)).toBe(a.postId);
    expect(result.get(b.marketId)).toBe(b.postId);
  });
});
