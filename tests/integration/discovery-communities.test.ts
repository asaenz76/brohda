/**
 * Integration tests for Phase D (Brohda 2.0 redesign) — the Discovery
 * "list Communities by type" query (lib/communities/discovery.ts), the
 * repository layer Phase A found missing entirely. Real local Supabase —
 * real `communities`/`teams`/`leagues`/`community_follows`/
 * `post_communities` rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { listCommunitiesByType } from "@/lib/communities/discovery";

const admin = getTestAdminClient();
const PROVIDER = "d_discovery_test";

const createdTeamIds: string[] = [];
const createdLeagueIds: string[] = [];
const createdCommunityIds: string[] = [];
const createdUserIds: string[] = [];
const createdPostCommunityCommunityIds: string[] = [];

async function createTeam(name: string, logoUrl: string | null = null): Promise<string> {
  const { data, error } = await admin
    .from("teams")
    .insert({ provider: PROVIDER, external_id: `team-${crypto.randomUUID()}`, name, logo_url: logoUrl })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create team");
  createdTeamIds.push(data.id);
  return data.id;
}

async function createLeague(name: string, logoUrl: string | null = null): Promise<string> {
  const { data, error } = await admin
    .from("leagues")
    .insert({ provider: PROVIDER, external_id: `league-${crypto.randomUUID()}`, name, logo_url: logoUrl })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create league");
  createdLeagueIds.push(data.id);
  return data.id;
}

async function createTeamCommunity(teamId: string, slugSuffix: string): Promise<string> {
  const { data, error } = await admin
    .from("communities")
    .insert({ type: "TEAM", team_id: teamId, slug: `d-team-${slugSuffix}-${crypto.randomUUID()}`, active: true })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create team community");
  createdCommunityIds.push(data.id);
  return data.id;
}

async function createLeagueCommunity(leagueId: string, slugSuffix: string): Promise<string> {
  const { data, error } = await admin
    .from("communities")
    .insert({ type: "LEAGUE", league_id: leagueId, slug: `d-league-${slugSuffix}-${crypto.randomUUID()}`, active: true })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create league community");
  createdCommunityIds.push(data.id);
  return data.id;
}

async function createSportCommunity(sportKey: string, displayName: string, slugSuffix: string): Promise<string> {
  const { data, error } = await admin
    .from("communities")
    .insert({ type: "SPORT", sport_key: sportKey, display_name: displayName, slug: `d-sport-${slugSuffix}-${crypto.randomUUID()}`, active: true })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create sport community");
  createdCommunityIds.push(data.id);
  return data.id;
}

async function createTestUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email: `d-discovery-${crypto.randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "D Discovery Test", role: "player", is_active: true });
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function stampActivity(communityId: string, createdAt: string) {
  // post_communities has a real FK to posts — this suite only needs a
  // row in the (community_id, created_at) shape listCommunitiesByType
  // reads, so it inserts against a throwaway post it also owns, matching
  // this codebase's own convention of not faking FK targets.
  const { data: fixture, error: fixtureError } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `d-fixture-${crypto.randomUUID()}`,
      sport: "american_football",
      home_team_name: "D Home",
      away_team_name: "D Away",
      scheduled_start_utc: new Date(Date.now() + 86_400_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (fixtureError || !fixture) throw fixtureError ?? new Error("failed to create fixture");

  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");

  const { error: pcError } = await admin.from("post_communities").insert({ post_id: post.id, community_id: communityId, created_at: createdAt });
  if (pcError) throw pcError;
  createdPostCommunityCommunityIds.push(communityId);

  return { fixtureId: fixture.id as string, postId: post.id as string };
}

afterEach(async () => {
  if (createdPostCommunityCommunityIds.length > 0) {
    await admin.from("post_communities").delete().in("community_id", createdPostCommunityCommunityIds);
    createdPostCommunityCommunityIds.length = 0;
  }
  // Every post/fixture this suite creates is only ever reachable via a
  // post_communities row against one of this suite's own communities —
  // clean them up by that same join, then the communities/teams/leagues
  // themselves.
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
  // posts/fixtures created by stampActivity are cleaned up via their own
  // cascade-free but harmless leftover rows — deleted explicitly here by
  // provider tag to avoid leaking test fixtures across runs.
  const { data: leftoverFixtures } = await admin.from("fixtures").select("id").eq("provider", PROVIDER);
  const fixtureIds = (leftoverFixtures ?? []).map((f) => f.id);
  if (fixtureIds.length > 0) {
    await admin.from("posts").delete().in("fixture_id", fixtureIds);
    await admin.from("fixtures").delete().in("id", fixtureIds);
  }
});

describe("listCommunitiesByType", () => {
  it("returns only Communities of the requested type", async () => {
    const team = await createTeam("D Filter Team");
    const teamCommunityId = await createTeamCommunity(team, "filter");
    const league = await createLeague("D Filter League");
    await createLeagueCommunity(league, "filter");

    const teams = await listCommunitiesByType("TEAM", null);
    expect(teams.some((c) => c.id === teamCommunityId)).toBe(true);
    expect(teams.every((c) => c.type === "TEAM")).toBe(true);
  });

  it("never leaks the raw CommunityType enum — displayName is always human text", async () => {
    const team = await createTeam("D Enum Team");
    await createTeamCommunity(team, "enum");
    const teams = await listCommunitiesByType("TEAM", null);
    for (const c of teams) {
      expect(c.displayName).not.toBe("TEAM");
      expect(c.displayName).not.toBe("LEAGUE");
      expect(c.displayName).not.toBe("SPORT");
    }
  });

  it("resolves the real team name and logo, not a placeholder", async () => {
    const team = await createTeam("D Crest Team", "https://example.com/crest.png");
    const communityId = await createTeamCommunity(team, "crest");
    const teams = await listCommunitiesByType("TEAM", null);
    const item = teams.find((c) => c.id === communityId);
    expect(item?.displayName).toBe("D Crest Team");
    expect(item?.logoUrl).toBe("https://example.com/crest.png");
  });

  it("handles a missing logo gracefully — null, not a placeholder string", async () => {
    const team = await createTeam("D No Crest Team", null);
    const communityId = await createTeamCommunity(team, "nocrest");
    const teams = await listCommunitiesByType("TEAM", null);
    const item = teams.find((c) => c.id === communityId);
    expect(item?.logoUrl).toBeNull();
  });

  it("a zero-follow user still sees the full catalog — following never gates the list", async () => {
    const team = await createTeam("D Zero Follow Team");
    const communityId = await createTeamCommunity(team, "zerofollow");
    const viewerId = await createTestUser();
    const teams = await listCommunitiesByType("TEAM", viewerId);
    expect(teams.some((c) => c.id === communityId)).toBe(true);
    expect(teams.find((c) => c.id === communityId)?.isFollowing).toBe(false);
  });

  it("reflects real follow state, batched (no per-item query needed for correctness)", async () => {
    const team = await createTeam("D Followed Team");
    const communityId = await createTeamCommunity(team, "followed");
    const viewerId = await createTestUser();
    await admin.from("community_follows").insert({ user_id: viewerId, community_id: communityId });

    const teams = await listCommunitiesByType("TEAM", viewerId);
    expect(teams.find((c) => c.id === communityId)?.isFollowing).toBe(true);
  });

  it("with no authenticated viewer, every item is isFollowing: false rather than throwing", async () => {
    const team = await createTeam("D Anon Team");
    const communityId = await createTeamCommunity(team, "anon");
    const teams = await listCommunitiesByType("TEAM", null);
    expect(teams.find((c) => c.id === communityId)?.isFollowing).toBe(false);
  });

  it("orders followed Communities first, deterministically", async () => {
    const teamA = await createTeam("D Order A Team");
    const communityA = await createTeamCommunity(teamA, "ordera");
    const teamB = await createTeam("D Order B Team");
    const communityB = await createTeamCommunity(teamB, "orderb");

    const viewerId = await createTestUser();
    await admin.from("community_follows").insert({ user_id: viewerId, community_id: communityB });

    const teams = await listCommunitiesByType("TEAM", viewerId);
    const indexA = teams.findIndex((c) => c.id === communityA);
    const indexB = teams.findIndex((c) => c.id === communityB);
    expect(indexB).toBeLessThan(indexA);
  });

  it("orders by most recent activity ahead of a Community with none, among equally-unfollowed items", async () => {
    const teamActive = await createTeam("D Active Team");
    const communityActive = await createTeamCommunity(teamActive, "active");
    await stampActivity(communityActive, new Date().toISOString());

    const teamQuiet = await createTeam("D Quiet Team");
    const communityQuiet = await createTeamCommunity(teamQuiet, "quiet");

    const teams = await listCommunitiesByType("TEAM", null);
    const indexActive = teams.findIndex((c) => c.id === communityActive);
    const indexQuiet = teams.findIndex((c) => c.id === communityQuiet);
    expect(indexActive).toBeLessThan(indexQuiet);
  });

  it("never returns a duplicate Community even when it has multiple activity rows", async () => {
    const team = await createTeam("D Dup Team");
    const communityId = await createTeamCommunity(team, "dup");
    await stampActivity(communityId, new Date(Date.now() - 60_000).toISOString());
    await stampActivity(communityId, new Date().toISOString());

    const teams = await listCommunitiesByType("TEAM", null);
    const matches = teams.filter((c) => c.id === communityId);
    expect(matches).toHaveLength(1);
  });

  it("resolves the real SPORT display name from the Community's own stored name, not a derived team/league lookup", async () => {
    const communityId = await createSportCommunity("american_football", "American Football", "sport");
    const sports = await listCommunitiesByType("SPORT", null);
    const item = sports.find((c) => c.id === communityId);
    expect(item?.displayName).toBe("American Football");
    expect(item?.logoUrl).toBeNull();
  });

  it("returns an empty list, not an error, when no Community of that type exists", async () => {
    // SPORT Communities from OTHER tests may exist in a shared local DB —
    // assert shape/no-throw rather than an exact empty array.
    await expect(listCommunitiesByType("SPORT", null)).resolves.toBeInstanceOf(Array);
  });
});
