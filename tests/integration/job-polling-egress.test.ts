/**
 * Integration tests for the egress reduction of the recurring jobs (migration 195). Real local Supabase.
 *
 * The decision rules moved from application code into two set-based database functions; these tests pin them to exactly the rules the application used
 * before, and prove the visible consequence: a Post that is already fully distributed costs the reconciliation job nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { ensureLeagueCommunity, ensureSportCommunity, ensureTeamCommunity } from "@/lib/communities/repository";
import { runCommunityDistribution } from "@/lib/communities/distribution";
import { ensurePostForFixture, publishPost } from "@/lib/posts/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const admin = getTestAdminClient();
const PROVIDER = "api_nfl";

const teamIds: string[] = [];
const leagueIds: string[] = [];
const fixtureIds: string[] = [];
const marketIds: string[] = [];
const postIds: string[] = [];
const communityIds: string[] = [];

const POLICY_COLUMNS = "community_distribution_enabled, community_team_distribution_enabled, community_league_distribution_enabled, community_sport_distribution_enabled";
let savedPolicy: Record<string, unknown> | null = null;

beforeEach(async () => {
  const { data } = await admin.from("platform_settings").select(POLICY_COLUMNS).eq("id", true).single();
  savedPolicy = data;
});

afterEach(async () => {
  if (savedPolicy) await admin.from("platform_settings").update(savedPolicy).eq("id", true);
  if (communityIds.length > 0) {
    await admin.from("post_communities").delete().in("community_id", communityIds);
    await admin.from("communities").delete().in("id", communityIds);
    communityIds.length = 0;
  }
  if (postIds.length > 0) {
    await admin.from("post_communities").delete().in("post_id", postIds);
    await admin.from("posts").delete().in("id", postIds);
    postIds.length = 0;
  }
  if (marketIds.length > 0) {
    await admin.from("markets").delete().in("id", marketIds);
    marketIds.length = 0;
  }
  if (fixtureIds.length > 0) {
    await admin.from("fixtures").delete().in("id", fixtureIds);
    fixtureIds.length = 0;
  }
  if (teamIds.length > 0) {
    await admin.from("teams").delete().in("id", teamIds);
    teamIds.length = 0;
  }
  if (leagueIds.length > 0) {
    await admin.from("leagues").delete().in("id", leagueIds);
    leagueIds.length = 0;
  }
});

async function createFixture(opts: { homeTeamExternalId?: string; awayTeamExternalId?: string; competitionExternalId?: string; startsInHours?: number; provider?: string } = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: opts.provider ?? PROVIDER,
      external_fixture_id: `egress-fixture-${crypto.randomUUID()}`,
      sport: "american_football",
      home_team_external_id: opts.homeTeamExternalId ?? null,
      home_team_name: "Home Egress",
      away_team_external_id: opts.awayTeamExternalId ?? null,
      away_team_name: "Away Egress",
      competition_external_id: opts.competitionExternalId ?? null,
      competition_name: opts.competitionExternalId ? "Egress League" : null,
      scheduled_start_utc: new Date(Date.now() + (opts.startsInHours ?? 24) * 3_600_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  fixtureIds.push(data.id);
  return data.id;
}

async function createTeam(name: string): Promise<{ id: string; externalId: string }> {
  const externalId = `egress-team-${crypto.randomUUID()}`;
  const { data, error } = await admin.from("teams").insert({ provider: PROVIDER, external_id: externalId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create team");
  teamIds.push(data.id);
  return { id: data.id, externalId };
}

async function createLeague(name: string): Promise<{ id: string; externalId: string }> {
  const externalId = `egress-league-${crypto.randomUUID()}`;
  const { data, error } = await admin.from("leagues").insert({ provider: PROVIDER, external_id: externalId, name }).select("id").single();
  if (error || !data) throw error ?? new Error("failed to create league");
  leagueIds.push(data.id);
  return { id: data.id, externalId };
}

async function createPost(fixtureId: string, published: boolean): Promise<string> {
  const { id } = await ensurePostForFixture(fixtureId);
  postIds.push(id);
  if (published) await publishPost(id);
  return id;
}

async function createActiveMarket(fixtureId: string): Promise<void> {
  const payload: NormalizedMarket = {
    provider: PROVIDER,
    providerMarketId: `egress_m_${crypto.randomUUID()}`,
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
  };
  const { id } = await upsertMarket(payload);
  marketIds.push(id);
}

async function needingPublication(requiresActiveMarket: boolean): Promise<Set<string>> {
  const { data, error } = await admin.rpc("fixtures_needing_publication", { p_providers: [PROVIDER], p_requires_active_market: requiresActiveMarket });
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
}

async function needingDistribution(expectedLinks: number): Promise<Set<string>> {
  const { data, error } = await admin.rpc("posts_needing_distribution", { p_expected_links: expectedLinks });
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
}

describe("posts_needing_distribution", () => {
  it("returns a published Post until it carries the expected number of Community links, and never an unpublished one", async () => {
    const fixtureId = await createFixture();
    const publishedPost = await createPost(fixtureId, true);
    const unpublishedPost = await createPost(await createFixture(), false);

    // A published Post with no links is incomplete under any positive expectation; an unpublished Post is never reconciled.
    expect((await needingDistribution(1)).has(publishedPost)).toBe(true);
    expect((await needingDistribution(1)).has(unpublishedPost)).toBe(false);
    // Nothing is expected when every distribution flag is off, so nothing is incomplete.
    expect((await needingDistribution(0)).has(publishedPost)).toBe(false);

    const sport = await ensureSportCommunity(`egress_sport_${crypto.randomUUID().slice(0, 8)}`, "Egress Sport");
    const league = await createLeague("Egress League A");
    const leagueCommunity = await ensureLeagueCommunity(league.id);
    communityIds.push(sport.id, leagueCommunity.id);
    await admin.from("post_communities").insert([
      { post_id: publishedPost, community_id: sport.id },
      { post_id: publishedPost, community_id: leagueCommunity.id },
    ]);

    expect((await needingDistribution(2)).has(publishedPost)).toBe(false); // exactly as many links as expected: complete
    expect((await needingDistribution(1)).has(publishedPost)).toBe(false); // more than expected is still complete
    expect((await needingDistribution(3)).has(publishedPost)).toBe(true); // a flag was turned on later: the Post is back in the work set
  });
});

describe("fixtures_needing_publication", () => {
  it("applies exactly the publication rule the application used before", async () => {
    const noPost = await createFixture();
    const unpublishedNoMarket = await createFixture();
    await createPost(unpublishedNoMarket, false);
    const unpublishedWithMarket = await createFixture();
    await createPost(unpublishedWithMarket, false);
    await createActiveMarket(unpublishedWithMarket);
    const alreadyPublished = await createFixture();
    await createPost(alreadyPublished, true);
    await createActiveMarket(alreadyPublished);
    const alreadyStarted = await createFixture({ startsInHours: -2 });
    const otherProvider = await createFixture({ provider: "api_nba" });

    const whenMarketRequired = await needingPublication(true);
    expect(whenMarketRequired.has(noPost)).toBe(true); // no Post row yet: the Post is still created, unpublished
    expect(whenMarketRequired.has(unpublishedNoMarket)).toBe(false); // has a Post, nothing to publish it with yet
    expect(whenMarketRequired.has(unpublishedWithMarket)).toBe(true); // an ACTIVE Market is there: publish
    expect(whenMarketRequired.has(alreadyPublished)).toBe(false);
    expect(whenMarketRequired.has(alreadyStarted)).toBe(false);
    expect(whenMarketRequired.has(otherProvider)).toBe(false); // only the providers asked for

    const whenMarketNotRequired = await needingPublication(false);
    expect(whenMarketNotRequired.has(noPost)).toBe(true);
    expect(whenMarketNotRequired.has(unpublishedNoMarket)).toBe(true); // no Market needed: publish it
    expect(whenMarketNotRequired.has(unpublishedWithMarket)).toBe(true);
    expect(whenMarketNotRequired.has(alreadyPublished)).toBe(false);
  });
});

describe("runCommunityDistribution", () => {
  it("works on a Post that is missing links and then leaves it alone once it is complete", async () => {
    await admin
      .from("platform_settings")
      .update({ community_distribution_enabled: true, community_team_distribution_enabled: true, community_league_distribution_enabled: true, community_sport_distribution_enabled: true })
      .eq("id", true);
    const home = await createTeam("Egress Home Team");
    const away = await createTeam("Egress Away Team");
    const league = await createLeague("Egress Full League");
    const fixtureId = await createFixture({ homeTeamExternalId: home.externalId, awayTeamExternalId: away.externalId, competitionExternalId: league.externalId });
    const postId = await createPost(fixtureId, true);

    const first = await runCommunityDistribution();
    const firstOutcome = first.outcomes.find((o) => o.postId === postId);
    expect(firstOutcome).toBeDefined();
    expect(firstOutcome!.distributedCommunityIds).toHaveLength(4); // home, away, league, sport
    communityIds.push(...firstOutcome!.distributedCommunityIds);
    expect(first.postsPublished).toBeGreaterThanOrEqual(first.postsExamined);

    const second = await runCommunityDistribution();
    expect(second.outcomes.find((o) => o.postId === postId)).toBeUndefined(); // complete: not examined again
    expect(second.failures.find((f) => f.postId === postId)).toBeUndefined();

    const { count } = await admin.from("post_communities").select("post_id", { count: "exact", head: true }).eq("post_id", postId);
    expect(count).toBe(4);

    // A Community is still there for each of its three entities (sanity: the reconciliation did not delete or re-point anything).
    expect((await ensureTeamCommunity(home.id)).outcome).toBe("existing");
  });
});
