import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PostComment, PostCommentAuthor, PostCommentWithAuthor } from "./types";

// Milestone R6 — the sole query/mutation surface for `post_comments`,
// matching this codebase's established one-repository-per-table
// convention. Mutations go through add_post_comment()/remove_post_comment()
// (SQL functions, service-role only) — never a plain insert/update here.

interface PostCommentRow {
  id: string;
  post_id: string;
  user_id: string;
  parent_comment_id: string | null;
  body: string;
  deleted_at: string | null;
  created_at: string;
}

function toDomain(row: PostCommentRow): PostComment {
  return {
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    parentCommentId: row.parent_comment_id,
    body: row.body,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

export async function addPostComment(input: { postId: string; userId: string; body: string; parentCommentId: string | null }): Promise<PostComment> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("add_post_comment", {
      p_post_id: input.postId,
      p_user_id: input.userId,
      p_body: input.body,
      p_parent_comment_id: input.parentCommentId,
    })
    .single();
  if (error) throw error;
  return toDomain(data as PostCommentRow);
}

export async function removePostComment(commentId: string, userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("remove_post_comment", { p_comment_id: commentId, p_user_id: userId });
  if (error) throw error;
}

// A safe, bounded default — not real cursor pagination (no established
// pattern for that exists yet in this codebase; see
// docs/architecture/post-conversation.md), but never an unbounded query
// either (§47).
const DEFAULT_TOP_LEVEL_LIMIT = 100;

/**
 * The canonical conversation query (§46): top-level Comments (oldest
 * first, matching pool_comments' own established reading order) plus every
 * reply beneath the returned page of top-level Comments, each with
 * presentation-safe author data joined from `public_profiles` (never
 * private profile fields — §31). Two queries plus one batched author
 * lookup — no N+1.
 */
export async function getPostConversation(postId: string, limit: number = DEFAULT_TOP_LEVEL_LIMIT): Promise<PostCommentWithAuthor[]> {
  const admin = createAdminClient();

  // This query runs on the service role (batched author lookups, no
  // per-viewer RLS need — unlike pool_comments' own read path), so it
  // doesn't inherit the read_comments_on_published_posts RLS policy for
  // free. Re-assert the same eligibility rule here directly: a comment can
  // never actually exist against an unpublished Post (add_post_comment
  // enforces this at creation, and posts.published_at is set-once/never
  // reverted — lib/posts/repository.ts), but this keeps the read path
  // correct in its own right rather than resting entirely on that
  // invariant holding elsewhere.
  const { data: post, error: postError } = await admin.from("posts").select("id").eq("id", postId).not("published_at", "is", null).maybeSingle();
  if (postError) throw postError;
  if (!post) return [];

  const { data: topLevelRows, error: topLevelError } = await admin
    .from("post_comments")
    .select("*")
    .eq("post_id", postId)
    .is("parent_comment_id", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (topLevelError) throw topLevelError;
  const topLevel = (topLevelRows as PostCommentRow[]).map(toDomain);
  if (topLevel.length === 0) return [];

  const topLevelIds = topLevel.map((c) => c.id);
  const { data: replyRows, error: replyError } = await admin
    .from("post_comments")
    .select("*")
    .in("parent_comment_id", topLevelIds)
    .order("created_at", { ascending: true });
  if (replyError) throw replyError;
  const replies = (replyRows as PostCommentRow[]).map(toDomain);

  // Not `public_profiles` here: that view grants SELECT to `authenticated`
  // only, not `service_role` (by design — see its own grants), and this
  // repository always runs on the service role. The four columns below are
  // exactly `public_profiles`' own unconditional (non-visibility-gated)
  // columns for id/display_name/avatar_url/username — nothing this query
  // reads is hidden behind show_pronouns/show_gender/show_bio, so reading
  // them straight from user_profiles exposes nothing the view wouldn't.
  const userIds = [...new Set([...topLevel, ...replies].map((c) => c.userId))];
  const { data: profileRows, error: profileError } = await admin
    .from("user_profiles")
    .select("id, display_name, username, avatar_url")
    .eq("is_active", true)
    .in("id", userIds);
  if (profileError) throw profileError;
  const authorsById = new Map<string, PostCommentAuthor>(
    (profileRows ?? []).map((p) => [p.id, { id: p.id, displayName: p.display_name, username: p.username, avatarUrl: p.avatar_url }]),
  );
  const unknownAuthor = (id: string): PostCommentAuthor => authorsById.get(id) ?? { id, displayName: "Unknown", username: null, avatarUrl: null };

  const repliesByParent = new Map<string, PostCommentWithAuthor[]>();
  for (const reply of replies) {
    const withAuthor: PostCommentWithAuthor = { ...reply, author: unknownAuthor(reply.userId), replies: [] };
    const list = repliesByParent.get(reply.parentCommentId as string) ?? [];
    list.push(withAuthor);
    repliesByParent.set(reply.parentCommentId as string, list);
  }

  return topLevel.map((comment) => ({ ...comment, author: unknownAuthor(comment.userId), replies: repliesByParent.get(comment.id) ?? [] }));
}

/**
 * Live count (§20) — deliberately not a denormalized counter (unlike
 * pool_comments.comment_count): R6's own instruction prefers deriving this
 * correctly over a cache that can drift, and Post-conversation volume
 * doesn't demonstrate the performance need a cache would justify. Counts
 * every non-tombstoned Comment (top-level and replies) for the Post —
 * removed comments don't count as content anymore, but a reply beneath a
 * removed parent still does.
 */
export async function getPostCommentCount(postId: string): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin.from("post_comments").select("id", { count: "exact", head: true }).eq("post_id", postId).is("deleted_at", null);
  if (error) throw error;
  return count ?? 0;
}
