/**
 * Integration tests for the logged-out front door's data path
 * (lib/landing/public-feed.ts): it reads the SAME canonical social feed a
 * member sees, with no viewer, and nothing more than that feed already
 * computes. Also pins the privacy audit result the design rests on — `anon`
 * can read none of the underlying tables directly — so a future grant or
 * policy that quietly made them public would fail here. Real local Supabase.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { getPublicFrontDoorFeed, PUBLIC_FEED_LIMIT } from "@/lib/landing/public-feed";

const admin = getTestAdminClient();
// Assertions about one seeded Game look past the page size: the shared test database can hold other files' Games that sort ahead.
const WIDE = 500;
const COMMENT_BODY = `PRIVATE-COMMENT-${randomUUID()}`;
const DISPLAY_NAME = `PrivateName-${randomUUID().slice(0, 8)}`;

const fixtureIds: string[] = [];
const marketIds: string[] = [];
const postIds: string[] = [];
const userIds: string[] = [];

async function seedGame({ status = "NOT_STARTED", published = true, home = "Home Test NFL", hours = 48 } = {}) {
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({
      provider: "api_nfl",
      external_fixture_id: `pfd-${randomUUID()}`,
      home_team_name: home,
      away_team_name: "Away Test NFL",
      competition_name: "NFL",
      scheduled_start_utc: new Date(Date.now() + hours * 3600_000).toISOString(),
      internal_status: status,
    })
    .select("id")
    .single();
  fixtureIds.push(fixture!.id);
  const { data: market } = await admin
    .from("markets")
    .insert({
      provider: "pfd", provider_market_id: `pfd_${randomUUID()}`, question: `Will ${home} win?`, status: "ACTIVE", fixture_id: fixture!.id,
      market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "test", provider_metadata: {},
    })
    .select("id")
    .single();
  marketIds.push(market!.id);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: published ? new Date().toISOString() : null }).select("id").single();
  postIds.push(post!.id);
  return { fixtureId: fixture!.id as string, marketId: market!.id as string, postId: post!.id as string };
}

async function seedUser(displayName: string) {
  const { data } = await admin.auth.admin.createUser({ email: `pfd-${randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  await admin.from("user_profiles").insert({ id: data.user!.id, display_name: displayName, username: `pfd${randomUUID().slice(0, 8)}`, role: "player", is_active: true });
  userIds.push(data.user!.id);
  return data.user!.id as string;
}

async function pick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { error } = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  if (error) throw error;
}

beforeEach(async () => {
  await admin.from("platform_settings").update({ social_prediction_enabled: true }).eq("id", true);
});

afterEach(async () => {
  await admin.from("platform_settings").update({ social_prediction_enabled: true }).eq("id", true);
  // Users first: service_role cannot DELETE post_comments (they are tombstoned), so comments go with their authors — otherwise the
  // Post, then the Fixture, can't be deleted and the leftovers crowd every later run's feed.
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  if (marketIds.length > 0) await admin.from("predictions").delete().in("market_id", marketIds);
  if (postIds.length > 0) await admin.from("posts").delete().in("id", postIds);
  if (marketIds.length > 0) await admin.from("markets").delete().in("id", marketIds);
  if (fixtureIds.length > 0) await admin.from("fixtures").delete().in("id", fixtureIds);
  postIds.length = marketIds.length = fixtureIds.length = userIds.length = 0;
});

describe("getPublicFrontDoorFeed", () => {
  it("returns published Posts for Games that haven't kicked off, and only those", async () => {
    const open = await seedGame({ home: "Open Game FC" });
    const unpublished = await seedGame({ home: "Unpublished FC", published: false });
    const live = await seedGame({ home: "Live FC", status: "LIVE" });
    const completed = await seedGame({ home: "Completed FC", status: "COMPLETED" });

    const ids = (await getPublicFrontDoorFeed(WIDE)).map((i) => i.post.id);
    expect(ids).toContain(open.postId);
    expect(ids).not.toContain(unpublished.postId);
    expect(ids).not.toContain(live.postId);
    expect(ids).not.toContain(completed.postId);
  });

  it("is the member feed with no viewer: Game fields and aggregate sentiment are real, nothing is personalised", async () => {
    const game = await seedGame({ home: "Sentiment FC" });
    const [a, b, c] = [await seedUser("A"), await seedUser("B"), await seedUser("C")];
    await pick(a, game.marketId, "YES");
    await pick(b, game.marketId, "YES");
    await pick(c, game.marketId, "NO");

    const item = (await getPublicFrontDoorFeed(WIDE)).find((i) => i.post.id === game.postId)!;
    expect(item.homeTeamName).toBe("Sentiment FC");
    expect(item.awayTeamName).toBe("Away Test NFL");
    expect(item.competitionName).toBe("NFL");
    expect(item.primaryMarket?.totalPickCount).toBe(3);
    expect(item.primaryMarket?.yesPercent).toBe(67);
    expect(item.primaryMarket?.noPercent).toBe(33);
    expect(item.primaryMarket?.viewerSelection).toBeNull();
    expect(item.isFromFollowedCommunity).toBe(false);
  });

  it("exposes a comment COUNT but never a commenter, a comment, a Pick or a profile", async () => {
    const game = await seedGame({ home: "Privacy FC" });
    const author = await seedUser(DISPLAY_NAME);
    await pick(author, game.marketId, "YES");
    await admin.from("post_comments").insert({ post_id: game.postId, user_id: author, body: COMMENT_BODY });
    await admin.from("post_comments").insert({ post_id: game.postId, user_id: author, body: "deleted one", deleted_at: new Date().toISOString() });

    const item = (await getPublicFrontDoorFeed(WIDE)).find((i) => i.post.id === game.postId)!;
    expect(item.commentCount).toBe(1); // tombstoned comments are not counted
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain(COMMENT_BODY);
    expect(serialized).not.toContain(DISPLAY_NAME);
    expect(serialized).not.toContain(author); // no user id of any participant
    expect(Object.keys(item)).not.toEqual(expect.arrayContaining(["comments", "author", "authorUserId", "createdBy"]));
  });

  it("fails closed with the social switch: no Games at all while the social product is off", async () => {
    await seedGame({ home: "Switch FC" });
    expect((await getPublicFrontDoorFeed(WIDE)).length).toBeGreaterThan(0);
    await admin.from("platform_settings").update({ social_prediction_enabled: false }).eq("id", true);
    expect(await getPublicFrontDoorFeed()).toEqual([]);
  });

  it("never returns more than the front door's page size", async () => {
    for (let i = 0; i < PUBLIC_FEED_LIMIT + 3; i += 1) await seedGame({ home: `Bulk ${i} FC`, hours: 100 + i });
    expect((await getPublicFrontDoorFeed()).length).toBeLessThanOrEqual(PUBLIC_FEED_LIMIT);
  });
});

describe("privacy audit: the anonymous role reads none of the underlying data directly", () => {
  // This is why the front door reads server-side with explicit, narrow fields instead of exposing the tables.
  for (const table of ["posts", "markets", "fixtures", "predictions", "post_comments", "user_profiles", "public_profiles", "communities", "post_communities"]) {
    it(`anon cannot read ${table}`, async () => {
      const anon = getTestAnonClient();
      const { data, error } = await anon.from(table).select("*").limit(1);
      expect(error, `anon read of ${table} should be refused`).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });
  }
});
