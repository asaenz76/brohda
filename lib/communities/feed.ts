import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Post } from "@/lib/posts/types";
import { listFollowedCommunityIds } from "./follows";

// Milestone R4 (§21-22): the canonical Post-centric discovery queries.
// Neither function clones a Post — both return the same canonical `posts`
// rows, looked up through the `post_communities` distribution relation,
// never a Community-owned copy.

interface PostRow {
  id: string;
  fixture_id: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

function toPost(row: PostRow): Post {
  return { id: row.id, fixtureId: row.fixture_id, publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Fetches published Posts by id, preserving the caller's given order (the order distribution/relevance already determined) and silently dropping any id that turns out unpublished or missing — the same "published-only" boundary lib/posts/repository.ts's getPublishedPostById enforces for a single Post. */
async function hydratePublishedPostsInOrder(postIds: string[]): Promise<Post[]> {
  if (postIds.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("posts").select("*").in("id", postIds).not("published_at", "is", null);
  if (error) throw error;
  const byId = new Map((data as PostRow[]).map((row) => [row.id, toPost(row)]));
  return postIds.map((id) => byId.get(id)).filter((post): post is Post => post !== undefined);
}

/**
 * "Give me published Posts distributed to Community X" (§21). Ordered by
 * distribution recency, deterministic, no duplicates (post_communities'
 * composite primary key already guarantees a Post appears at most once per
 * Community, so no in-memory dedup is needed here — only getPersonalizedFeed
 * below, which spans multiple Communities, needs that).
 */
export async function getCommunityFeed(communityId: string, limit = 50): Promise<Post[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("post_communities").select("post_id").eq("community_id", communityId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return hydratePublishedPostsInOrder((data ?? []).map((row) => row.post_id));
}

/**
 * "Show me Posts relevant to Communities I follow" (§22), deduplicated
 * (§28's own worked example: a Post distributed to two Communities the
 * user follows must appear once, not twice). Deliberately no ranking
 * algorithm — deterministic recency order, first-seen-wins dedup. An
 * over-fetch (5x limit) absorbs the fact that N distribution rows across
 * several followed Communities can collapse to fewer distinct Posts.
 */
export async function getPersonalizedFeed(userId: string, limit = 50): Promise<Post[]> {
  const followedCommunityIds = await listFollowedCommunityIds(userId);
  if (followedCommunityIds.length === 0) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("post_communities")
    .select("post_id")
    .in("community_id", followedCommunityIds)
    .order("created_at", { ascending: false })
    .limit(limit * 5);
  if (error) throw error;

  const seen = new Set<string>();
  const orderedPostIds: string[] = [];
  for (const row of data ?? []) {
    if (seen.has(row.post_id)) continue;
    seen.add(row.post_id);
    orderedPostIds.push(row.post_id);
    if (orderedPostIds.length >= limit) break;
  }

  return hydratePublishedPostsInOrder(orderedPostIds);
}
