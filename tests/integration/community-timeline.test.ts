/**
 * Integration tests for Phase E (Brohda 2.0 redesign) — the Community
 * page's own timeline (lib/communities/feed.ts's getCommunityTimeline) and
 * identity resolver (lib/communities/presentation.ts's getCommunityIdentity).
 * Real local Supabase — real fixtures/teams/leagues/posts/markets/
 * communities/post_communities/predictions rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { ensureTeamCommunity, ensureLeagueCommunity, ensureSportCommunity } from "@/lib/communities/repository";
import { distributePostToCommunity } from "@/lib/communities/distribution";
import { getCommunityTimeline, getSocialFeed } from "@/lib/communities/feed";
import { getCommunityIdentity } from "@/lib/communities/presentation";
import { ensurePostForFixture, publishPost } from "@/lib/posts/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import type { Community } from "@/lib/communities/types";

const admin = getTestAdminClient();
const PROVIDER = "e_community_timeline_test";

const createdTeamIds: string[] = [];
const createdLeagueIds: string[] = [];
const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdPostIds: string[] = [];
const createdCommunityIds: string[] = [];
const createdUserIds: string[] = [];
const createdPredictionIds: string[] = [];

async function createTeam(name: string, logoUrl: string | null = null): Promise<{ id: string; externalId: string }> {
  const externalId = `team-${crypto.randomUUID()}`;
  const { data, error } = await admin.from("teams").insert({ provider: PROVIDER, external_id: externalId, name, logo_url: logoUrl }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create team");
  createdTeamIds.push(data.id);
  return { id: data.id, externalId };
}

async function createLeague(name: string, logoUrl: string | null = null): Promise<{ id: string; externalId: string }> {
  const externalId = `league-${crypto.randomUUID()}`;
  const { data, error } = await admin.from("leagues").insert({ provider: PROVIDER, external_id: externalId, name, logo_url: logoUrl }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create league");
  createdLeagueIds.push(data.id);
  return { id: data.id, externalId };
}

async function createFixture(opts: { homeTeamExternalId?: string; awayTeamExternalId?: string; overrides?: Record<string, unknown> } = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `e-timeline-fixture-${crypto.randomUUID()}`,
      sport: "american_football",
      home_team_external_id: opts.homeTeamExternalId ?? null,
      home_team_name: "Home Test Team",
      away_team_external_id: opts.awayTeamExternalId ?? null,
      away_team_name: "Away Test Team",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
      ...opts.overrides,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  createdFixtureIds.push(data.id);
  return data.id;
}

async function createPublishedPost(fixtureId: string): Promise<string> {
  const { id } = await ensurePostForFixture(fixtureId);
  createdPostIds.push(id);
  await publishPost(id);
  return id;
}

function marketPayload(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: PROVIDER,
    providerMarketId: `m_${Math.random().toString(36).slice(2)}`,
    providerEventId: null,
    question: "Will the home team win?",
    description: null,
    status: "ACTIVE",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Home", no: "Away" } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "test",
    providerMetadata: {},
    ...overrides,
  };
}

async function createMarket(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket(marketPayload(fixtureId, overrides));
  createdMarketIds.push(id);
  return id;
}

async function createPrediction(userId: string, marketId: string, outcome: "YES" | "NO"): Promise<string> {
  const { data, error } = await admin
    .from("predictions")
    .insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: outcome,
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "Will the home team win?",
      market_close_at_snapshot: null,
      market_status_snapshot: "ACTIVE",
      lifecycle_state: "PENDING",
      locked_at: null,
      lock_reason: null,
      idempotency_key: crypto.randomUUID(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create prediction");
  createdPredictionIds.push(data.id);
  return data.id;
}

async function createTestUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `e-timeline-${crypto.randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "E Timeline Test", role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function setRetentionHours(hours: number) {
  await admin.from("platform_settings").update({ feed_completed_game_retention_hours: hours }).eq("id", true);
}

afterEach(async () => {
  await setRetentionHours(24);
  if (createdPredictionIds.length > 0) {
    await admin.from("predictions").delete().in("id", createdPredictionIds);
    createdPredictionIds.length = 0;
  }
  if (createdCommunityIds.length > 0) {
    await admin.from("post_communities").delete().in("community_id", createdCommunityIds);
    await admin.from("community_follows").delete().in("community_id", createdCommunityIds);
    await admin.from("communities").delete().in("id", createdCommunityIds);
    createdCommunityIds.length = 0;
  }
  if (createdPostIds.length > 0) {
    await admin.from("post_communities").delete().in("post_id", createdPostIds);
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

describe("getCommunityTimeline", () => {
  it("returns only Posts distributed to this Community, not other Communities'", async () => {
    const team = await createTeam("Timeline Scope Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const otherTeam = await createTeam("Other Scope Team");
    const { id: otherCommunityId } = await ensureTeamCommunity(otherTeam.id);
    createdCommunityIds.push(otherCommunityId);

    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);

    const otherFixtureId = await createFixture();
    const otherPostId = await createPublishedPost(otherFixtureId);
    await distributePostToCommunity(otherPostId, otherCommunityId);

    const timeline = await getCommunityTimeline(communityId, null);
    expect(timeline.map((i) => i.post.id)).toEqual([postId]);
  });

  it("never returns a duplicate Post even when it is distributed to multiple Communities", async () => {
    const team = await createTeam("Dedup Team");
    const { id: teamCommunityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(teamCommunityId);
    const league = await createLeague("Dedup League");
    const { id: leagueCommunityId } = await ensureLeagueCommunity(league.id);
    createdCommunityIds.push(leagueCommunityId);

    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, teamCommunityId);
    await distributePostToCommunity(postId, leagueCommunityId);

    const timeline = await getCommunityTimeline(teamCommunityId, null);
    expect(timeline.filter((i) => i.post.id === postId)).toHaveLength(1);
  });

  it("excludes a POSTPONED game", async () => {
    const team = await createTeam("Postponed Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);

    const fixtureId = await createFixture({ overrides: { internal_status: "POSTPONED" } });
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);

    const timeline = await getCommunityTimeline(communityId, null);
    expect(timeline.map((i) => i.post.id)).not.toContain(postId);
  });

  it("includes a COMPLETED game within the configured retention window", async () => {
    const team = await createTeam("Recently Completed Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);

    const fixtureId = await createFixture({ overrides: { internal_status: "COMPLETED", updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() } });
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);

    const timeline = await getCommunityTimeline(communityId, null);
    expect(timeline.map((i) => i.post.id)).toContain(postId);
  });

  it("excludes a COMPLETED game outside the configured retention window", async () => {
    await setRetentionHours(1);
    const team = await createTeam("Stale Completed Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);

    const fixtureId = await createFixture({ overrides: { internal_status: "COMPLETED", updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() } });
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);

    const timeline = await getCommunityTimeline(communityId, null);
    expect(timeline.map((i) => i.post.id)).not.toContain(postId);
  });

  it("orders active/upcoming games ahead of completed games", async () => {
    const team = await createTeam("Order Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);

    const completedFixtureId = await createFixture({ overrides: { internal_status: "COMPLETED", updated_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() } });
    const completedPostId = await createPublishedPost(completedFixtureId);
    await distributePostToCommunity(completedPostId, communityId);

    const upcomingFixtureId = await createFixture();
    const upcomingPostId = await createPublishedPost(upcomingFixtureId);
    await distributePostToCommunity(upcomingPostId, communityId);

    const timeline = await getCommunityTimeline(communityId, null);
    const indexUpcoming = timeline.findIndex((i) => i.post.id === upcomingPostId);
    const indexCompleted = timeline.findIndex((i) => i.post.id === completedPostId);
    expect(indexUpcoming).toBeLessThan(indexCompleted);
  });

  it("strips the CURRENT Community from each item's own communities[] badge list, but keeps other Communities", async () => {
    const team = await createTeam("Self Badge Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const league = await createLeague("Self Badge League");
    const { id: leagueCommunityId } = await ensureLeagueCommunity(league.id);
    createdCommunityIds.push(leagueCommunityId);

    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);
    await distributePostToCommunity(postId, leagueCommunityId);

    const timeline = await getCommunityTimeline(communityId, null);
    const item = timeline.find((i) => i.post.id === postId)!;
    expect(item.communities.some((c) => c.id === communityId)).toBe(false);
    expect(item.communities.some((c) => c.id === leagueCommunityId)).toBe(true);
  });

  it("never marks an item isFromFollowedCommunity — that signal is redundant with the page's own header follow state", async () => {
    const team = await createTeam("Redundant Follow Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const userId = await createTestUser();
    await admin.from("community_follows").insert({ user_id: userId, community_id: communityId });

    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);

    const timeline = await getCommunityTimeline(communityId, userId);
    expect(timeline.find((i) => i.post.id === postId)?.isFromFollowedCommunity).toBe(false);
  });

  it("shows the exact same real sentiment/viewer-Pick values as Home for the identical Post/Market", async () => {
    const team = await createTeam("Consistency Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const userId = await createTestUser();

    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);
    const marketId = await createMarket(fixtureId);
    await createPrediction(userId, marketId, "YES");

    const [timeline, homeFeed] = await Promise.all([getCommunityTimeline(communityId, userId), getSocialFeed(userId)]);
    const communityItem = timeline.find((i) => i.post.id === postId);
    const homeItem = homeFeed.find((i) => i.post.id === postId);

    expect(communityItem?.primaryMarket?.yesPercent).toBe(homeItem?.primaryMarket?.yesPercent);
    expect(communityItem?.primaryMarket?.totalPickCount).toBe(homeItem?.primaryMarket?.totalPickCount);
    expect(communityItem?.primaryMarket?.viewerSelection).toBe(homeItem?.primaryMarket?.viewerSelection);
    expect(communityItem?.primaryMarket?.viewerSelection).toBe("YES");
  });

  it("returns an empty list, not an error, for a Community with no distributed Posts", async () => {
    const team = await createTeam("Empty Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);

    await expect(getCommunityTimeline(communityId, null)).resolves.toEqual([]);
  });

  it("works for a SPORT Community the same way as TEAM/LEAGUE", async () => {
    const { id: communityId } = await ensureSportCommunity("american_football", "American Football");
    createdCommunityIds.push(communityId);

    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    await distributePostToCommunity(postId, communityId);

    const timeline = await getCommunityTimeline(communityId, null);
    expect(timeline.map((i) => i.post.id)).toEqual([postId]);
  });
});

describe("getCommunityIdentity", () => {
  function communityOf(type: Community["type"], overrides: Partial<Community> = {}): Community {
    const now = new Date().toISOString();
    return { id: "c1", type, teamId: null, leagueId: null, sportKey: null, slug: "c1", displayName: null, active: true, createdAt: now, updatedAt: now, ...overrides };
  }

  it("resolves a TEAM Community's real name and logo", async () => {
    const team = await createTeam("Identity Team", "https://example.com/team.png");
    const identity = await getCommunityIdentity(communityOf("TEAM", { teamId: team.id }));
    expect(identity).toEqual({ displayName: "Identity Team", logoUrl: "https://example.com/team.png" });
  });

  it("resolves a TEAM Community with a missing logo as null, not a placeholder", async () => {
    const team = await createTeam("No Logo Team", null);
    const identity = await getCommunityIdentity(communityOf("TEAM", { teamId: team.id }));
    expect(identity.logoUrl).toBeNull();
  });

  it("resolves a LEAGUE Community's real name and logo", async () => {
    const league = await createLeague("Identity League", "https://example.com/league.png");
    const identity = await getCommunityIdentity(communityOf("LEAGUE", { leagueId: league.id }));
    expect(identity).toEqual({ displayName: "Identity League", logoUrl: "https://example.com/league.png" });
  });

  it("resolves a SPORT Community's stored display name with a null logo (no logo concept exists for SPORT)", async () => {
    const identity = await getCommunityIdentity(communityOf("SPORT", { displayName: "American Football", sportKey: "american_football" }));
    // The sport has no logo, but it carries its sport key so the UI can show the sport's own icon.
    expect(identity).toEqual({ displayName: "American Football", logoUrl: null, sportKey: "american_football" });
  });
});
