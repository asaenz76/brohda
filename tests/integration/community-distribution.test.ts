/**
 * Integration tests for Milestone R4 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Community + Distribution). Real local Supabase — real `fixtures`/
 * `teams`/`leagues`/`posts`/`markets`/`communities`/`post_communities`/
 * `community_follows`/`platform_settings` rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { ensureTeamCommunity, ensureLeagueCommunity, ensureSportCommunity } from "@/lib/communities/repository";
import { distributePostForFixture, distributePostToCommunity, listCommunityIdsForPost, runCommunityDistribution } from "@/lib/communities/distribution";
import { getCommunityFeed, getSocialFeed } from "@/lib/communities/feed";
import { followCommunity, isFollowingCommunity, listFollowedCommunityIds, unfollowCommunity } from "@/lib/communities/follows";
import { ensurePostForFixture, publishPost } from "@/lib/posts/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const admin = getTestAdminClient();
const PROVIDER = "api_nfl";

const createdTeamIds: string[] = [];
const createdLeagueIds: string[] = [];
const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdPostIds: string[] = [];
const createdCommunityIds: string[] = [];
const createdUserIds: string[] = [];

async function createTeam(name: string): Promise<{ id: string; externalId: string }> {
  const externalId = `team-${crypto.randomUUID()}`;
  const { data, error } = await admin.from("teams").insert({ provider: PROVIDER, external_id: externalId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create team");
  createdTeamIds.push(data.id);
  return { id: data.id, externalId };
}

async function createLeague(name: string): Promise<{ id: string; externalId: string }> {
  const externalId = `league-${crypto.randomUUID()}`;
  const { data, error } = await admin.from("leagues").insert({ provider: PROVIDER, external_id: externalId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create league");
  createdLeagueIds.push(data.id);
  return { id: data.id, externalId };
}

async function createFixture(opts: { homeTeamExternalId?: string; awayTeamExternalId?: string; competitionExternalId?: string; overrides?: Record<string, unknown> } = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `r4-fixture-${crypto.randomUUID()}`,
      sport: "american_football",
      home_team_external_id: opts.homeTeamExternalId ?? null,
      home_team_name: "Home Test NFL",
      away_team_external_id: opts.awayTeamExternalId ?? null,
      away_team_name: "Away Test NFL",
      competition_external_id: opts.competitionExternalId ?? null,
      competition_name: opts.competitionExternalId ? "Test League" : null,
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

async function setPolicy(overrides: Record<string, unknown>) {
  await admin.from("platform_settings").update(overrides).eq("id", true);
}

async function createTestUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `r4-community-${crypto.randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "R4 Community Test", role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

afterEach(async () => {
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
  await setPolicy({ community_distribution_enabled: false, community_team_distribution_enabled: true, community_league_distribution_enabled: true, community_sport_distribution_enabled: true });
});

describe("Community identity", () => {
  it("creates one canonical Community per team, idempotently", async () => {
    const team = await createTeam("Test Giants");
    const first = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(first.id);
    expect(first.outcome).toBe("created");
    const second = await ensureTeamCommunity(team.id);
    expect(second.outcome).toBe("existing");
    expect(second.id).toBe(first.id);

    const { count } = await admin.from("communities").select("id", { count: "exact", head: true }).eq("team_id", team.id);
    expect(count).toBe(1);
  });

  it("concurrent ensure for the same team produces exactly one Community", async () => {
    const team = await createTeam("Test Rams");
    const results = await Promise.all([ensureTeamCommunity(team.id), ensureTeamCommunity(team.id), ensureTeamCommunity(team.id)]);
    createdCommunityIds.push(results[0].id);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const { count } = await admin.from("communities").select("id", { count: "exact", head: true }).eq("team_id", team.id);
    expect(count).toBe(1);
  });

  it("a team display-name change does not create a duplicate Community", async () => {
    const team = await createTeam("Old Name FC");
    const { id } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(id);

    await admin.from("teams").update({ name: "New Name FC" }).eq("id", team.id);

    const second = await ensureTeamCommunity(team.id);
    expect(second.id).toBe(id);
    const { count } = await admin.from("communities").select("id", { count: "exact", head: true }).eq("team_id", team.id);
    expect(count).toBe(1);
  });

  it("one canonical Community per league and per sport, both idempotent", async () => {
    const league = await createLeague("Test League");
    const first = await ensureLeagueCommunity(league.id);
    createdCommunityIds.push(first.id);
    const second = await ensureLeagueCommunity(league.id);
    expect(second.id).toBe(first.id);

    const sport1 = await ensureSportCommunity("test_sport", "Test Sport");
    createdCommunityIds.push(sport1.id);
    const sport2 = await ensureSportCommunity("test_sport", "Test Sport");
    expect(sport2.id).toBe(sport1.id);
  });

  it("a Community's sports-subject identity cannot be rebound", async () => {
    const teamA = await createTeam("Team A");
    const teamB = await createTeam("Team B");
    const { id } = await ensureTeamCommunity(teamA.id);
    createdCommunityIds.push(id);

    const { error } = await admin.from("communities").update({ team_id: teamB.id }).eq("id", id);
    expect(error).not.toBeNull();
  });
});

describe("authority", () => {
  it("anon cannot create a Community", async () => {
    const team = await createTeam("Anon Test Team");
    const anon = getTestAnonClient();
    const { error } = await anon.from("communities").insert({ type: "TEAM", team_id: team.id, slug: "anon-test-team" });
    expect(error).not.toBeNull();
  });

  it("an authenticated normal user cannot create a Community", async () => {
    const team = await createTeam("User Test Team");
    const userId = await createTestUser();
    const email = (await admin.auth.admin.getUserById(userId)).data.user!.email!;
    const userClient = getTestAnonClient();
    await userClient.auth.signInWithPassword({ email, password: "integration-test-password-123" });
    const { error } = await userClient.from("communities").insert({ type: "TEAM", team_id: team.id, slug: "user-test-team" });
    expect(error).not.toBeNull();
  });

  it("only platform (service role) can distribute a Post", async () => {
    const team = await createTeam("Distribution Auth Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);

    const anon = getTestAnonClient();
    const { error } = await anon.from("post_communities").insert({ post_id: postId, community_id: communityId });
    expect(error).not.toBeNull();
  });
});

describe("distribution", () => {
  it("distributes one Post to home team, away team, and league Communities without duplicating the Post", async () => {
    const home = await createTeam("Giants Test");
    const away = await createTeam("Rams Test");
    const league = await createLeague("NFL Test");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId, awayTeamExternalId: away.externalId, competitionExternalId: league.externalId });
    const postId = await createPublishedPost(fixtureId);

    const outcome = await distributePostForFixture(postId, fixtureId);
    for (const id of outcome.distributedCommunityIds) createdCommunityIds.push(id);
    // home team + away team + league + sport = 4 distribution targets, all resolvable.
    expect(outcome.distributedCommunityIds).toHaveLength(4);
    expect(outcome.skippedReasons).toHaveLength(0);

    const communityIds = await listCommunityIdsForPost(postId);
    expect(new Set(communityIds).size).toBe(4);

    // Exactly one canonical Post row exists throughout.
    const { count } = await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", fixtureId);
    expect(count).toBe(1);

    // Each Community's own feed returns that same Post — not a copy.
    for (const communityId of communityIds) {
      const feed = await getCommunityFeed(communityId);
      expect(feed.map((p) => p.id)).toEqual([postId]);
    }
  });

  it("skips gracefully when a team/league cannot be resolved, without blocking the rest", async () => {
    const fixtureId = await createFixture(); // no external ids at all
    const postId = await createPublishedPost(fixtureId);

    const outcome = await distributePostForFixture(postId, fixtureId);
    for (const id of outcome.distributedCommunityIds) createdCommunityIds.push(id);
    // Only sport resolves (fixtures.sport is always present); team/league external ids were never set.
    expect(outcome.skippedReasons).toEqual(expect.arrayContaining(["home-team-unresolved", "away-team-unresolved", "league-unresolved"]));
    expect(outcome.distributedCommunityIds).toHaveLength(1); // sport only
  });

  it("respects per-type distribution policy", async () => {
    const home = await createTeam("Policy Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId });
    const postId = await createPublishedPost(fixtureId);

    await setPolicy({ community_team_distribution_enabled: false, community_league_distribution_enabled: false, community_sport_distribution_enabled: true });
    const outcome = await distributePostForFixture(postId, fixtureId);
    for (const id of outcome.distributedCommunityIds) createdCommunityIds.push(id);
    expect(outcome.distributedCommunityIds).toHaveLength(1); // only sport
  });

  it("is idempotent — running distribution repeatedly never duplicates a relation", async () => {
    const home = await createTeam("Idempotent Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId });
    const postId = await createPublishedPost(fixtureId);

    const first = await distributePostForFixture(postId, fixtureId);
    for (const id of first.distributedCommunityIds) createdCommunityIds.push(id);
    await distributePostForFixture(postId, fixtureId);
    await distributePostForFixture(postId, fixtureId);

    const { count } = await admin.from("post_communities").select("post_id", { count: "exact", head: true }).eq("post_id", postId);
    expect(count).toBe(first.distributedCommunityIds.length);
  });

  it("is concurrency-safe — overlapping distribution attempts never duplicate a relation", async () => {
    const home = await createTeam("Concurrent Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId });
    const postId = await createPublishedPost(fixtureId);

    const results = await Promise.allSettled([distributePostForFixture(postId, fixtureId), distributePostForFixture(postId, fixtureId), distributePostForFixture(postId, fixtureId)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof distributePostForFixture>>>[];
    for (const id of fulfilled[0].value.distributedCommunityIds) createdCommunityIds.push(id);

    const { count } = await admin.from("post_communities").select("post_id", { count: "exact", head: true }).eq("post_id", postId);
    expect(count).toBe(fulfilled[0].value.distributedCommunityIds.length);
  });

  it("distributePostToCommunity itself is idempotent at the relation level", async () => {
    const team = await createTeam("Direct Distribute Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);

    expect(await distributePostToCommunity(postId, communityId)).toBe("created");
    expect(await distributePostToCommunity(postId, communityId)).toBe("existing");
    const { count } = await admin.from("post_communities").select("post_id", { count: "exact", head: true }).eq("post_id", postId).eq("community_id", communityId);
    expect(count).toBe(1);
  });

  it("reconciles existing published Posts created before any Community existed (backfill)", async () => {
    const home = await createTeam("Backfill Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId });
    const postId = await createPublishedPost(fixtureId); // no Community, no distribution yet

    await setPolicy({ community_distribution_enabled: true });
    const summary = await runCommunityDistribution();
    expect(summary.policyEnabled).toBe(true);

    const outcomeForPost = summary.outcomes.find((o) => o.postId === postId);
    expect(outcomeForPost).toBeDefined();
    for (const id of outcomeForPost!.distributedCommunityIds) createdCommunityIds.push(id);
    expect(outcomeForPost!.distributedCommunityIds.length).toBeGreaterThan(0);
  });

  it("does nothing when community_distribution_enabled is false", async () => {
    await setPolicy({ community_distribution_enabled: false });
    const summary = await runCommunityDistribution();
    expect(summary.policyEnabled).toBe(false);
    expect(summary.postsExamined).toBe(0);
  });
});

describe("Market and Game independence", () => {
  it("a Market price update does not change distribution", async () => {
    const home = await createTeam("Price Indep Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId });
    const providerMarketId = `ml_${crypto.randomUUID()}`;
    await createMarket(fixtureId, { providerMarketId, marketTemplate: "MONEYLINE", yesSide: "HOME" });
    const postId = await createPublishedPost(fixtureId);
    const outcome = await distributePostForFixture(postId, fixtureId);
    for (const id of outcome.distributedCommunityIds) createdCommunityIds.push(id);

    await createMarket(fixtureId, { providerMarketId, marketTemplate: "MONEYLINE", yesSide: "HOME", price: { yes: 0.9, no: 0.1, outcomeLabels: { yes: "Home", no: "Away" } } });

    const communityIds = await listCommunityIdsForPost(postId);
    expect(communityIds).toHaveLength(outcome.distributedCommunityIds.length);
  });

  it("a TOTAL line move does not change distribution", async () => {
    const home = await createTeam("Line Indep Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId });
    await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    const postId = await createPublishedPost(fixtureId);
    const outcome = await distributePostForFixture(postId, fixtureId);
    for (const id of outcome.distributedCommunityIds) createdCommunityIds.push(id);

    // Simulate R2's line-movement behavior.
    const { data: oldTotal } = await admin.from("markets").select("id").eq("fixture_id", fixtureId).single();
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", oldTotal!.id);
    await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 48.5, yesSide: null });

    const communityIds = await listCommunityIdsForPost(postId);
    expect(communityIds).toHaveLength(outcome.distributedCommunityIds.length);
  });

  it("Game score/kickoff changes and cancellation do not affect distribution or delete the Post", async () => {
    const home = await createTeam("Lifecycle Indep Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId });
    const postId = await createPublishedPost(fixtureId);
    const outcome = await distributePostForFixture(postId, fixtureId);
    for (const id of outcome.distributedCommunityIds) createdCommunityIds.push(id);

    await admin.from("fixtures").update({ home_score: 24, away_score: 17, internal_status: "COMPLETED" }).eq("id", fixtureId);
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() }).eq("id", fixtureId);
    let communityIds = await listCommunityIdsForPost(postId);
    expect(communityIds).toHaveLength(outcome.distributedCommunityIds.length);

    await admin.from("fixtures").update({ internal_status: "CANCELLED" }).eq("id", fixtureId);
    communityIds = await listCommunityIdsForPost(postId);
    expect(communityIds).toHaveLength(outcome.distributedCommunityIds.length);

    const { data: post } = await admin.from("posts").select("id").eq("id", postId).single();
    expect(post).not.toBeNull();
  });
});

describe("Community following", () => {
  it("follow, duplicate-follow-safe, unfollow, and list correctness", async () => {
    const team = await createTeam("Follow Test Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const userId = await createTestUser();

    expect(await isFollowingCommunity(userId, communityId)).toBe(false);
    expect(await followCommunity(userId, communityId)).toBe("followed");
    expect(await followCommunity(userId, communityId)).toBe("already-following"); // duplicate-safe
    expect(await isFollowingCommunity(userId, communityId)).toBe(true);
    expect(await listFollowedCommunityIds(userId)).toEqual([communityId]);

    await unfollowCommunity(userId, communityId);
    expect(await isFollowingCommunity(userId, communityId)).toBe(false);
    expect(await listFollowedCommunityIds(userId)).toEqual([]);
  });

  it("a user cannot read or modify another user's follow directly (RLS)", async () => {
    const team = await createTeam("Privacy Test Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);
    const ownerId = await createTestUser();
    await followCommunity(ownerId, communityId);

    const otherId = await createTestUser();
    const otherEmail = (await admin.auth.admin.getUserById(otherId)).data.user!.email!;
    const otherClient = getTestAnonClient();
    await otherClient.auth.signInWithPassword({ email: otherEmail, password: "integration-test-password-123" });

    const { data: readAsOther } = await otherClient.from("community_follows").select("*").eq("user_id", ownerId);
    expect(readAsOther ?? []).toEqual([]);

    const { error: deleteError } = await otherClient.from("community_follows").delete().eq("user_id", ownerId).eq("community_id", communityId);
    expect(deleteError).not.toBeNull();
    expect(await isFollowingCommunity(ownerId, communityId)).toBe(true); // untouched
  });
});

describe("Community feed", () => {
  it("returns only published, distributed Posts, deterministically ordered, no duplicates", async () => {
    const team = await createTeam("Feed Test Team");
    const { id: communityId } = await ensureTeamCommunity(team.id);
    createdCommunityIds.push(communityId);

    const fixtureA = await createFixture();
    const postA = await createPublishedPost(fixtureA);
    await distributePostToCommunity(postA, communityId);

    // An UNPUBLISHED post distributed to the same community must never leak through.
    const fixtureB = await createFixture();
    const { id: postB } = await ensurePostForFixture(fixtureB);
    createdPostIds.push(postB);
    await distributePostToCommunity(postB, communityId);

    const feed = await getCommunityFeed(communityId);
    expect(feed.map((p) => p.id)).toEqual([postA]);
  });
});

describe("social feed (Stage 4A)", () => {
  it("(A) a zero-follow user still gets eligible published Posts — following is never a prerequisite", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);

    const userId = await createTestUser();
    expect(await listFollowedCommunityIds(userId)).toEqual([]);

    const feed = await getSocialFeed(userId);
    expect(feed.map((i) => i.post.id)).toContain(postId);
  });

  it("(B) a Post in a followed Community is prioritized ahead of an equally-eligible unfollowed one", async () => {
    const followedTeam = await createTeam("Prioritized Team");
    const otherTeam = await createTeam("Other Team");
    const followedFixture = await createFixture({ homeTeamExternalId: followedTeam.externalId, overrides: { scheduled_start_utc: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() } });
    const otherFixture = await createFixture({ homeTeamExternalId: otherTeam.externalId, overrides: { scheduled_start_utc: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString() } });
    const followedPostId = await createPublishedPost(followedFixture);
    const otherPostId = await createPublishedPost(otherFixture);

    const followedCommunity = await ensureTeamCommunity(followedTeam.id);
    createdCommunityIds.push(followedCommunity.id);
    await distributePostToCommunity(followedPostId, followedCommunity.id);

    const userId = await createTestUser();
    await followCommunity(userId, followedCommunity.id);

    const feed = await getSocialFeed(userId);
    const followedIndex = feed.findIndex((i) => i.post.id === followedPostId);
    const otherIndex = feed.findIndex((i) => i.post.id === otherPostId);
    expect(followedIndex).toBeGreaterThanOrEqual(0);
    expect(otherIndex).toBeGreaterThanOrEqual(0);
    // Followed ranks first even though its kickoff is further away — relevance beats timing.
    expect(followedIndex).toBeLessThan(otherIndex);
    expect(feed[followedIndex]!.isFromFollowedCommunity).toBe(true);
    expect(feed[otherIndex]!.isFromFollowedCommunity).toBe(false);
  });

  it("(C) a Post distributed to two Communities the user follows appears exactly once", async () => {
    const home = await createTeam("Dedup Home Team");
    const away = await createTeam("Dedup Away Team");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId, awayTeamExternalId: away.externalId });
    const postId = await createPublishedPost(fixtureId);

    const homeCommunity = await ensureTeamCommunity(home.id);
    const awayCommunity = await ensureTeamCommunity(away.id);
    createdCommunityIds.push(homeCommunity.id, awayCommunity.id);
    await distributePostToCommunity(postId, homeCommunity.id);
    await distributePostToCommunity(postId, awayCommunity.id);

    const userId = await createTestUser();
    await followCommunity(userId, homeCommunity.id);
    await followCommunity(userId, awayCommunity.id);

    const feed = await getSocialFeed(userId);
    expect(feed.filter((i) => i.post.id === postId)).toHaveLength(1);
    expect(feed.find((i) => i.post.id === postId)?.communities).toHaveLength(2);
  });

  it("(D) a draft (unpublished) Post never appears in the feed", async () => {
    const fixtureId = await createFixture();
    const { id: draftPostId } = await ensurePostForFixture(fixtureId); // deliberately not published
    createdPostIds.push(draftPostId);

    const userId = await createTestUser();
    const feed = await getSocialFeed(userId);
    expect(feed.map((i) => i.post.id)).not.toContain(draftPostId);
  });

  it("(E) a POSTPONED game's Post is excluded, and a COMPLETED game's Post drops out after the configured retention window", async () => {
    const postponedFixture = await createFixture({ overrides: { internal_status: "POSTPONED" } });
    const postponedPostId = await createPublishedPost(postponedFixture);

    const staleFixture = await createFixture({
      overrides: { internal_status: "COMPLETED", updated_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString() },
    });
    const stalePostId = await createPublishedPost(staleFixture);

    const recentFixture = await createFixture({
      overrides: { internal_status: "COMPLETED", updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    });
    const recentPostId = await createPublishedPost(recentFixture);

    await setPolicy({ feed_completed_game_retention_hours: 24 });

    const userId = await createTestUser();
    const feed = await getSocialFeed(userId);
    const feedIds = feed.map((i) => i.post.id);
    expect(feedIds).not.toContain(postponedPostId);
    expect(feedIds).not.toContain(stalePostId);
    expect(feedIds).toContain(recentPostId);
  });
});
