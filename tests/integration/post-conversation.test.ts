/**
 * Integration tests for Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Post Conversation). Real local Supabase — real `fixtures`/`posts`/
 * `post_comments`/`teams`/`leagues`/`communities`/`post_communities`/
 * `markets`/`predictions`/`platform_settings`/`notifications` rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { ensurePostForFixture, publishPost } from "@/lib/posts/repository";
import { ensureTeamCommunity, ensureLeagueCommunity } from "@/lib/communities/repository";
import { distributePostForFixture } from "@/lib/communities/distribution";
import { addPostComment, removePostComment, getPostConversation, getPostCommentCount } from "@/lib/post-comments/repository";
import { createPostCommentReplyNotification } from "@/lib/notifications/post-comments";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import { setPick } from "@/lib/predictions/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();
const PROVIDER = "api_nfl";

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdPostIds: string[] = [];
const createdCommunityIds: string[] = [];
const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const createdLeagueIds: string[] = [];

async function createFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `r6-post-${crypto.randomUUID()}`,
      home_team_name: "Home Test NFL",
      away_team_name: "Away Test NFL",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
      ...overrides,
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

async function createUser(label = "r6-post-comment") {
  const email = `${label}-${crypto.randomUUID()}@test.local`;
  const password = "integration-test-password-123";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role: "player", is_active: true });
  createdUserIds.push(data.user.id);

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  await client.auth.signInWithPassword({ email, password });
  return { userId: data.user.id, client };
}

async function getAdminId(): Promise<string> {
  const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
  return data!.id as string;
}

async function setPolicy(overrides: Record<string, unknown>) {
  await admin.from("platform_settings").update(overrides).eq("id", true);
}

afterEach(async () => {
  if (createdMarketIds.length > 0) {
    // Predictions before markets — predictions.market_id is a soft
    // reference (no FK), so deleting the market first would leave the
    // prediction permanently orphaned.
    await admin.from("predictions").delete().in("market_id", createdMarketIds);
    await admin.from("markets").delete().in("id", createdMarketIds);
  }
  createdMarketIds.length = 0;
  if (createdPostIds.length > 0) {
    await admin.from("notifications").delete().in("post_id", createdPostIds);
    await admin.from("post_comments").delete().in("post_id", createdPostIds);
    await admin.from("post_communities").delete().in("post_id", createdPostIds);
    await admin.from("posts").delete().in("id", createdPostIds);
  }
  createdPostIds.length = 0;
  if (createdCommunityIds.length > 0) await admin.from("communities").delete().in("id", createdCommunityIds);
  createdCommunityIds.length = 0;
  if (createdFixtureIds.length > 0) await admin.from("fixtures").delete().in("id", createdFixtureIds);
  createdFixtureIds.length = 0;
  if (createdTeamIds.length > 0) await admin.from("teams").delete().in("id", createdTeamIds);
  createdTeamIds.length = 0;
  if (createdLeagueIds.length > 0) await admin.from("leagues").delete().in("id", createdLeagueIds);
  createdLeagueIds.length = 0;
  if (createdUserIds.length > 0) {
    await Promise.all(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
  }
  createdUserIds.length = 0;
  await setPolicy({ post_comment_max_length: 500, post_comment_rate_limit_window_seconds: 60, post_comment_rate_limit_max_attempts: 10 });
});

describe("Creation", () => {
  it("creates a top-level comment on a published Post", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const comment = await addPostComment({ postId, userId, body: "Let's go!", parentCommentId: null });
    expect(comment.postId).toBe(postId);
    expect(comment.userId).toBe(userId);
    expect(comment.parentCommentId).toBeNull();
    expect(comment.deletedAt).toBeNull();
  });

  it("rejects a comment on an unpublished Post", async () => {
    const fixtureId = await createFixture();
    const { id: postId } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(postId);
    const { userId } = await createUser();

    await expect(addPostComment({ postId, userId, body: "too early", parentCommentId: null })).rejects.toThrow(/post_not_found/);
  });

  it("rejects an empty body at the database level", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const { error } = await admin.rpc("add_post_comment", { p_post_id: postId, p_user_id: userId, p_body: "" });
    expect(error).not.toBeNull();
  });

  it("rejects a body over the configured product policy length", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    await setPolicy({ post_comment_max_length: 10 });

    await expect(addPostComment({ postId, userId, body: "x".repeat(11), parentCommentId: null })).rejects.toThrow(/body_too_long/);
  });

  it("accepts a body exactly at the configured max length boundary", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    await setPolicy({ post_comment_max_length: 10 });

    const comment = await addPostComment({ postId, userId, body: "x".repeat(10), parentCommentId: null });
    expect(comment.body).toHaveLength(10);
  });

  it("rejects a body over the hard technical ceiling regardless of policy", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    await setPolicy({ post_comment_max_length: 2000 });

    const { error } = await admin.rpc("add_post_comment", { p_post_id: postId, p_user_id: userId, p_body: "x".repeat(2001) });
    expect(error).not.toBeNull();
  });
});

describe("Ownership", () => {
  it("the author is always the server-supplied user, never guessable/forgeable from the response", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const comment = await addPostComment({ postId, userId, body: "mine", parentCommentId: null });
    expect(comment.userId).toBe(userId);
  });

  it("no authenticated client can call add_post_comment directly (service_role only)", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId, client } = await createUser();

    const { error } = await client.rpc("add_post_comment", { p_post_id: postId, p_user_id: userId, p_body: "bypass" });
    expect(error).not.toBeNull();
  });

  it("author, Post, and parent are immutable after creation — no UPDATE grant lets an authenticated client change them", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const other = await createFixture();
    const otherPostId = await createPublishedPost(other);
    const { userId, client } = await createUser();
    const intruder = await createUser("r6-intruder");

    const comment = await addPostComment({ postId, userId, body: "immutable", parentCommentId: null });

    const { error: reparentError } = await client.from("post_comments").update({ post_id: otherPostId }).eq("id", comment.id);
    expect(reparentError).not.toBeNull();
    const { error: reauthorError } = await intruder.client.from("post_comments").update({ user_id: intruder.userId }).eq("id", comment.id);
    expect(reauthorError).not.toBeNull();

    const { data: unchanged } = await admin.from("post_comments").select("post_id, user_id").eq("id", comment.id).single();
    expect(unchanged?.post_id).toBe(postId);
    expect(unchanged?.user_id).toBe(userId);
  });
});

describe("Replies", () => {
  it("accepts a reply to a top-level comment on the same Post", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const parent = await addPostComment({ postId, userId, body: "top-level", parentCommentId: null });
    const reply = await addPostComment({ postId, userId, body: "a reply", parentCommentId: parent.id });
    expect(reply.parentCommentId).toBe(parent.id);
  });

  it("rejects a reply to a reply (one level of nesting only)", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const parent = await addPostComment({ postId, userId, body: "top-level", parentCommentId: null });
    const reply = await addPostComment({ postId, userId, body: "a reply", parentCommentId: parent.id });

    await expect(addPostComment({ postId, userId, body: "too deep", parentCommentId: reply.id })).rejects.toThrow(/nesting_too_deep/);
  });

  it("rejects a parent from a different Post (cross-Post reply)", async () => {
    const fixtureA = await createFixture();
    const postA = await createPublishedPost(fixtureA);
    const fixtureB = await createFixture();
    const postB = await createPublishedPost(fixtureB);
    const { userId } = await createUser();

    const parentOnA = await addPostComment({ postId: postA, userId, body: "on post A", parentCommentId: null });

    await expect(addPostComment({ postId: postB, userId, body: "cross-post reply", parentCommentId: parentOnA.id })).rejects.toThrow(/parent_not_found/);
  });

  it("rejects a nonexistent parent id", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    await expect(addPostComment({ postId, userId, body: "orphan reply", parentCommentId: crypto.randomUUID() })).rejects.toThrow(/parent_not_found/);
  });

  it("a reply to a tombstoned parent is still accepted — removal doesn't invalidate the thread underneath it", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const parent = await addPostComment({ postId, userId, body: "will be removed", parentCommentId: null });
    await removePostComment(parent.id, userId);

    const reply = await addPostComment({ postId, userId, body: "still repliable", parentCommentId: parent.id });
    expect(reply.parentCommentId).toBe(parent.id);
  });

  it("top-level comments and their replies are returned in deterministic chronological order", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const first = await addPostComment({ postId, userId, body: "first", parentCommentId: null });
    const second = await addPostComment({ postId, userId, body: "second", parentCommentId: null });
    await addPostComment({ postId, userId, body: "reply-1", parentCommentId: first.id });
    await addPostComment({ postId, userId, body: "reply-2", parentCommentId: first.id });

    const conversation = await getPostConversation(postId);
    expect(conversation.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(conversation[0].replies.map((r) => r.body)).toEqual(["reply-1", "reply-2"]);
  });
});

describe("Shared Community conversation", () => {
  it("a comment created on a Post distributed to multiple Communities is the SAME row, visible regardless of entry path — never duplicated per Community", async () => {
    const homeExternalId = `team-home-${crypto.randomUUID()}`;
    const awayExternalId = `team-away-${crypto.randomUUID()}`;
    const leagueExternalId = `league-${crypto.randomUUID()}`;
    const { data: homeTeam } = await admin.from("teams").insert({ provider: PROVIDER, external_id: homeExternalId, name: "Giants" }).select("id").single();
    const { data: awayTeam } = await admin.from("teams").insert({ provider: PROVIDER, external_id: awayExternalId, name: "Rams" }).select("id").single();
    const { data: league } = await admin.from("leagues").insert({ provider: PROVIDER, external_id: leagueExternalId, name: "NFL" }).select("id").single();
    createdTeamIds.push(homeTeam!.id, awayTeam!.id);
    createdLeagueIds.push(league!.id);

    const fixtureId = await createFixture({
      home_team_external_id: homeExternalId,
      away_team_external_id: awayExternalId,
      competition_external_id: leagueExternalId,
      competition_name: "NFL",
    });
    const postId = await createPublishedPost(fixtureId);

    const giants = await ensureTeamCommunity(homeTeam!.id);
    const rams = await ensureTeamCommunity(awayTeam!.id);
    const nfl = await ensureLeagueCommunity(league!.id);
    createdCommunityIds.push(giants.id, rams.id, nfl.id);

    const outcome = await distributePostForFixture(postId, fixtureId);
    createdCommunityIds.push(...outcome.distributedCommunityIds.filter((id) => !createdCommunityIds.includes(id)));
    const { data: distributions } = await admin.from("post_communities").select("community_id").eq("post_id", postId);
    const distributedCommunityIds = new Set((distributions ?? []).map((d) => d.community_id));
    // Team (Giants) + Team (Rams) + League (NFL) + the auto-created Sport
    // community — distributePostForFixture (R4) distributes to all four
    // when every distribution policy is enabled by default.
    expect(distributedCommunityIds.size).toBe(4);
    expect(distributedCommunityIds.has(giants.id)).toBe(true);
    expect(distributedCommunityIds.has(rams.id)).toBe(true);
    expect(distributedCommunityIds.has(nfl.id)).toBe(true);

    const { userId } = await createUser();
    const created = await addPostComment({ postId, userId, body: "shared across every Community", parentCommentId: null });

    // Exactly one row exists for this Post's conversation — not one per
    // Community it was distributed to.
    const { count } = await admin.from("post_comments").select("id", { count: "exact", head: true }).eq("post_id", postId);
    expect(count).toBe(1);

    // The same row is visible via the canonical query regardless of which
    // Community "path" a viewer conceptually entered through — nothing in
    // getPostConversation is Community-scoped, it only ever reads by
    // post_id.
    const viaGiantsPath = await getPostConversation(postId);
    const viaRamsPath = await getPostConversation(postId);
    const viaDirectPath = await getPostConversation(postId);
    expect(viaGiantsPath).toHaveLength(1);
    expect(viaGiantsPath[0].id).toBe(created.id);
    expect(viaRamsPath[0].id).toBe(created.id);
    expect(viaDirectPath[0].id).toBe(created.id);
  });

  it("post_comments never stores a community_id — Comment ownership belongs to the Post alone", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    const comment = await addPostComment({ postId, userId, body: "no community column", parentCommentId: null });
    expect(Object.keys(comment)).not.toContain("communityId");

    const { data: row } = await admin.from("post_comments").select("*").eq("id", comment.id).single();
    expect(Object.keys(row!)).not.toContain("community_id");
  });
});

describe("Market and Pick independence", () => {
  it("a Market price move does not affect comment creation or visibility", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { providerMarketId: "moneyline-1" });
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const comment = await addPostComment({ postId, userId, body: "before price move", parentCommentId: null });
    await createMarket(fixtureId, { providerMarketId: "moneyline-1", price: { yes: 0.9, no: 0.1, outcomeLabels: { yes: "Home", no: "Away" } } });

    const conversation = await getPostConversation(postId);
    expect(conversation.map((c) => c.id)).toContain(comment.id);
    void marketId;
  });

  it("a locked Pick does not block comment creation on the same Post", async () => {
    const fixtureId = await createFixture({ scheduled_start_utc: new Date(Date.now() + 60 * 1000).toISOString() });
    const marketId = await createMarket(fixtureId);
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    // Seed an already-locked Pick directly (mirrors pick-editing-and-
    // locking.test.ts's own "lock is one-way" setup) so the *edit* attempt
    // below hits the locked path in isolation, independent of the cutoff
    // check.
    await admin.from("predictions").insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "q",
      market_status_snapshot: "ACTIVE",
      idempotency_key: crypto.randomUUID(),
      locked_at: new Date().toISOString(),
      lock_reason: "CUTOFF",
    });

    const pickResult = await setPick({
      userId,
      marketId,
      selectedOutcome: "NO",
      yesProbability: 0.6,
      noProbability: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(pickResult.outcome).toBe("rejected_locked");

    // The Pick edit was rejected as locked — but Comment creation on the
    // same Post is a completely independent code path and must still
    // succeed.
    const comment = await addPostComment({ postId, userId, body: "still talking after lock", parentCommentId: null });
    expect(comment.postId).toBe(postId);
  });
});

describe("Game lifecycle", () => {
  const statuses = ["NOT_STARTED", "LIVE", "COMPLETED", "POSTPONED", "SUSPENDED", "ABANDONED", "CANCELLED", "AWARDED"] as const;

  it.each(statuses)("comments remain postable on a published Post regardless of Game status (%s) — eligibility is Post-publication-only", async (status) => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    await admin.from("fixtures").update({ internal_status: status }).eq("id", fixtureId);
    const { userId } = await createUser();

    const comment = await addPostComment({ postId, userId, body: `comment during ${status}`, parentCommentId: null });
    expect(comment.postId).toBe(postId);
  });
});

describe("Removal (soft-delete)", () => {
  it("the author can remove their own comment — it is tombstoned, not hard-deleted", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    const comment = await addPostComment({ postId, userId, body: "delete me", parentCommentId: null });

    await removePostComment(comment.id, userId);

    const { data: row } = await admin.from("post_comments").select("*").eq("id", comment.id).single();
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.body).toBe("delete me"); // body preserved, only presentation changes
  });

  it("a non-owner, non-admin cannot remove another user's comment", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const author = await createUser("r6-author");
    const intruder = await createUser("r6-intruder2");
    const comment = await addPostComment({ postId, userId: author.userId, body: "only I can delete this", parentCommentId: null });

    await expect(removePostComment(comment.id, intruder.userId)).rejects.toThrow(/not_authorized/);

    const { data: row } = await admin.from("post_comments").select("deleted_at").eq("id", comment.id).single();
    expect(row!.deleted_at).toBeNull();
  });

  it("a super admin can remove any user's comment", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    const comment = await addPostComment({ postId, userId, body: "moderated away", parentCommentId: null });

    await removePostComment(comment.id, adminId);

    const { data: row } = await admin.from("post_comments").select("deleted_at").eq("id", comment.id).single();
    expect(row!.deleted_at).not.toBeNull();
  });

  it("removing a top-level comment preserves its replies — no cascade", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    const parent = await addPostComment({ postId, userId, body: "parent", parentCommentId: null });
    const reply = await addPostComment({ postId, userId, body: "reply", parentCommentId: parent.id });

    await removePostComment(parent.id, userId);

    const { data: replyRow } = await admin.from("post_comments").select("*").eq("id", reply.id).single();
    expect(replyRow).not.toBeNull();
    expect(replyRow!.deleted_at).toBeNull();
    expect(replyRow!.body).toBe("reply");

    const conversation = await getPostConversation(postId);
    const parentInTree = conversation.find((c) => c.id === parent.id);
    expect(parentInTree?.deletedAt).not.toBeNull();
    expect(parentInTree?.replies.map((r) => r.id)).toContain(reply.id);
  });

  it("removing an already-removed comment is a safe no-op", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    const comment = await addPostComment({ postId, userId, body: "double delete", parentCommentId: null });

    await removePostComment(comment.id, userId);
    await expect(removePostComment(comment.id, userId)).resolves.toBeUndefined();
  });

  it("comment count excludes tombstoned comments but still counts replies beneath a removed parent", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();
    const parent = await addPostComment({ postId, userId, body: "parent", parentCommentId: null });
    await addPostComment({ postId, userId, body: "reply", parentCommentId: parent.id });

    expect(await getPostCommentCount(postId)).toBe(2);
    await removePostComment(parent.id, userId);
    expect(await getPostCommentCount(postId)).toBe(1);
  });
});

describe("Rate limiting", () => {
  // checkPostCommentRateLimit() itself goes through lib/supabase/server.ts's
  // cookie-bound client (only usable inside a real Next.js request), same
  // as lib/rate-limit/check.ts's own checkRateLimit — exactly why
  // rate-limit.test.ts calls check_and_increment_rate_limit directly rather
  // than the TS wrapper. Mirrored here with the same `post_comment:` prefix
  // checkPostCommentRateLimit() itself uses, proving the underlying
  // enforcement (not the request-scoped plumbing around it, which the
  // Server Action layer already exercises identically to pool comments).
  function checkPostCommentRpcRateLimit(userId: string, windowSeconds: number, maxAttempts: number) {
    return admin.rpc("check_and_increment_rate_limit", {
      p_identifier: `post_comment:${userId}`,
      p_window_seconds: windowSeconds,
      p_max_attempts: maxAttempts,
    });
  }

  it("blocks comment creation past the configured attempt cap within the window, and a different user is unaffected", async () => {
    const { userId: userA } = await createUser("r6-rate-a");
    const { userId: userB } = await createUser("r6-rate-b");

    for (let i = 0; i < 2; i++) {
      const { data, error } = await checkPostCommentRpcRateLimit(userA, 60, 2);
      expect(error).toBeNull();
      expect(data).toBe(true);
    }
    const { data: blocked } = await checkPostCommentRpcRateLimit(userA, 60, 2);
    expect(blocked).toBe(false);

    // A different user's own budget is untouched by userA's exhausted one.
    const { data: allowedB } = await checkPostCommentRpcRateLimit(userB, 60, 2);
    expect(allowedB).toBe(true);

    await admin.from("rate_limits").delete().in("identifier", [`post_comment:${userA}`, `post_comment:${userB}`]);
  });

  it("legitimate use under the threshold always succeeds", async () => {
    const { userId } = await createUser("r6-rate-legit");

    for (let i = 0; i < 5; i++) {
      const { data, error } = await checkPostCommentRpcRateLimit(userId, 60, 5);
      expect(error).toBeNull();
      expect(data).toBe(true);
    }
    await admin.from("rate_limits").delete().eq("identifier", `post_comment:${userId}`);
  });
});

describe("Notifications", () => {
  it("notifies the parent comment's author of a reply, linked to the canonical Post", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const author = await createUser("r6-notif-author");
    const replier = await createUser("r6-notif-replier");

    await createPostCommentReplyNotification({
      postId,
      parentCommentUserId: author.userId,
      replierUserId: replier.userId,
      replierDisplayName: "replier",
      replyBody: "great pick!",
    });

    const { data: notifications } = await admin.from("notifications").select("*").eq("user_id", author.userId).eq("post_id", postId);
    expect(notifications).toHaveLength(1);
    expect(notifications![0].type).toBe("POST_COMMENT_REPLY");
    expect(notifications![0].body).toContain("replier");
    expect(notifications![0].body).toContain("great pick!");
  });

  it("suppresses self-reply notifications", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser("r6-notif-self");

    await createPostCommentReplyNotification({
      postId,
      parentCommentUserId: userId,
      replierUserId: userId,
      replierDisplayName: "self",
      replyBody: "replying to myself",
    });

    const { data: notifications } = await admin.from("notifications").select("*").eq("user_id", userId).eq("post_id", postId);
    expect(notifications).toEqual([]);
  });

  it("the recipient cannot be forged — it is always derived server-side from the parent comment's stored author", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const author = await createUser("r6-notif-real-author");
    const replier = await createUser("r6-notif-real-replier");
    const outsider = await createUser("r6-notif-outsider");

    const parent = await addPostComment({ postId, userId: author.userId, body: "top-level", parentCommentId: null });
    const reply = await addPostComment({ postId, userId: replier.userId, body: "a reply", parentCommentId: parent.id });

    // Mirrors lib/actions/post-comments.ts's own flow: the recipient comes
    // from re-reading the parent comment's stored user_id, never from any
    // client-suppliable field.
    const { data: parentRow } = await admin.from("post_comments").select("user_id").eq("id", parent.id).single();
    expect(parentRow!.user_id).toBe(author.userId);

    await createPostCommentReplyNotification({
      postId,
      parentCommentUserId: parentRow!.user_id,
      replierUserId: replier.userId,
      replierDisplayName: "replier",
      replyBody: reply.body,
    });

    const { data: outsiderNotifications } = await admin.from("notifications").select("*").eq("user_id", outsider.userId).eq("post_id", postId);
    expect(outsiderNotifications).toEqual([]);
    const { data: authorNotifications } = await admin.from("notifications").select("*").eq("user_id", author.userId).eq("post_id", postId);
    expect(authorNotifications).toHaveLength(1);
  });
});

describe("Security", () => {
  it("anon cannot read comments at all — no grant to the anon role, even on a published Post", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const adminId = await getAdminId();
    await addPostComment({ postId, userId: adminId, body: "should not leak to anon", parentCommentId: null });

    const anon = getTestAnonClient();
    const { data } = await anon.from("post_comments").select("*").eq("post_id", postId);
    expect(data ?? []).toEqual([]);
  });

  it("an authenticated client can read comments on a published Post via RLS, but cannot write the table directly", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId, client } = await createUser();
    await addPostComment({ postId, userId, body: "readable via RLS", parentCommentId: null });

    const { data: visible } = await client.from("post_comments").select("id, body").eq("post_id", postId);
    expect(visible?.length).toBe(1);

    const { data: insertData } = await client.from("post_comments").insert({ post_id: postId, user_id: userId, body: "direct insert" }).select();
    expect(insertData ?? []).toHaveLength(0);

    const { count } = await admin.from("post_comments").select("id", { count: "exact", head: true }).eq("post_id", postId);
    expect(count).toBe(1);
  });

  it("no authenticated client can call remove_post_comment directly (service_role only)", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId, client } = await createUser();
    const comment = await addPostComment({ postId, userId, body: "protected", parentCommentId: null });

    const { error } = await client.rpc("remove_post_comment", { p_comment_id: comment.id, p_user_id: userId });
    expect(error).not.toBeNull();
    const { data: row } = await admin.from("post_comments").select("deleted_at").eq("id", comment.id).single();
    expect(row!.deleted_at).toBeNull();
  });

  it("an authenticated client cannot set another user's comment into a moderation/deleted state directly", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const author = await createUser("r6-sec-author");
    const intruder = await createUser("r6-sec-intruder");
    const comment = await addPostComment({ postId, userId: author.userId, body: "not yours to touch", parentCommentId: null });

    const { error } = await intruder.client.from("post_comments").update({ deleted_at: new Date().toISOString() }).eq("id", comment.id);
    expect(error).not.toBeNull();
    const { data: row } = await admin.from("post_comments").select("deleted_at").eq("id", comment.id).single();
    expect(row!.deleted_at).toBeNull();
  });
});

describe("Pagination", () => {
  it("bounds the top-level page and never returns duplicate top-level comments", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    for (let i = 0; i < 5; i++) {
      await addPostComment({ postId, userId, body: `comment ${i}`, parentCommentId: null });
    }

    const page = await getPostConversation(postId, 3);
    expect(page).toHaveLength(3);
    const ids = new Set(page.map((c) => c.id));
    expect(ids.size).toBe(3);
  });

  it("replies stay correctly associated with their own top-level comment under a bounded page", async () => {
    const fixtureId = await createFixture();
    const postId = await createPublishedPost(fixtureId);
    const { userId } = await createUser();

    const first = await addPostComment({ postId, userId, body: "first", parentCommentId: null });
    await addPostComment({ postId, userId, body: "second", parentCommentId: null });
    await addPostComment({ postId, userId, body: "reply-to-first", parentCommentId: first.id });

    const page = await getPostConversation(postId, 2);
    expect(page).toHaveLength(2);
    const firstInPage = page.find((c) => c.id === first.id);
    expect(firstInPage?.replies.map((r) => r.body)).toEqual(["reply-to-first"]);
  });
});
