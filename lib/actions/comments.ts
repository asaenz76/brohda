"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { addCommentSchema, deleteCommentSchema } from "@/lib/validations/comments";
import { checkCommentRateLimit } from "@/lib/rate-limit/comments";
import { createCommentReplyNotification, createMentionNotifications } from "@/lib/notifications/create";
import { extractMentionedUsernames } from "@/lib/mentions";

export type PoolCommentItem = {
  id: string;
  body: string;
  createdAt: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  username: string | null;
  parentCommentId: string | null;
  // Lets a commenter be followed straight from the thread — reading
  // someone's take and deciding to follow them shouldn't require a full
  // profile-page visit first.
  isFollowing: boolean;
};

// Read path for CommentSheet — uses the RLS-respecting client (comments
// inherit their pool's own read policy), not the service role, since this
// is just a query, not a mutation.
export async function getPoolCommentsAction(poolId: string): Promise<PoolCommentItem[]> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: comments } = await supabase
    .from("pool_comments")
    .select("*")
    .eq("pool_id", poolId)
    .order("created_at", { ascending: true });

  if (!comments || comments.length === 0) return [];

  const userIds = [...new Set(comments.map((c) => c.user_id))];
  const [{ data: profiles }, { data: followRows }] = await Promise.all([
    supabase.from("public_profiles").select("*").in("id", userIds),
    supabase.from("follows").select("followee_id").eq("follower_id", user.id).in("followee_id", userIds),
  ]);
  const followingIds = new Set((followRows ?? []).map((f) => f.followee_id));

  return comments.map((c) => {
    const profile = profiles?.find((p) => p.id === c.user_id);
    return {
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      userId: c.user_id,
      displayName: profile?.display_name ?? "Unknown",
      avatarUrl: profile?.avatar_url ?? null,
      username: profile?.username ?? null,
      parentCommentId: c.parent_comment_id,
      isFollowing: followingIds.has(c.user_id),
    };
  });
}

export type AddCommentResult = { error: string | null; comment: PoolCommentItem | null };

export async function addCommentAction(
  poolId: string,
  body: string,
  parentCommentId: string | null = null,
): Promise<AddCommentResult> {
  const user = await requireUser();

  const parsed = addCommentSchema.safeParse({ poolId, body, parentCommentId });
  if (!parsed.success) {
    return { error: "Comment must be between 1 and 500 characters.", comment: null };
  }

  const allowed = await checkCommentRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many comments. Try again in a moment.", comment: null };
  }

  const adminClient = createAdminClient();
  const { data: commentRow, error } = await adminClient.rpc("add_pool_comment", {
    p_pool_id: parsed.data.poolId,
    p_user_id: user.id,
    p_body: parsed.data.body,
    p_parent_comment_id: parsed.data.parentCommentId ?? null,
  });
  const comment = Array.isArray(commentRow) ? commentRow[0] : commentRow;

  if (error || !comment) {
    // nesting_too_deep is the one add_pool_comment case actually worth a
    // distinct message — the client already hides "Reply" on a reply, but
    // a stale UI or a second tab could still race into it.
    const tooDeep = error?.message?.includes("nesting_too_deep");
    return {
      error: tooDeep ? "Replies can't be nested further." : "Could not post your comment.",
      comment: null,
    };
  }

  if (comment.parent_comment_id) {
    const { data: parentComment } = await adminClient
      .from("pool_comments")
      .select("user_id")
      .eq("id", comment.parent_comment_id)
      .single();

    if (parentComment) {
      await createCommentReplyNotification({
        poolId: parsed.data.poolId,
        parentCommentUserId: parentComment.user_id,
        replierUserId: user.id,
        replierDisplayName: user.display_name,
        replyBody: comment.body,
      });
    }
  }

  const mentionedUsernames = extractMentionedUsernames(comment.body);
  if (mentionedUsernames.length > 0) {
    const supabase = await createClient();
    const { data: mentionedProfiles } = await supabase
      .from("public_profiles")
      .select("id")
      .in("username", mentionedUsernames);

    const mentionedUserIds = [
      ...new Set((mentionedProfiles ?? []).map((p) => p.id).filter((id) => id !== user.id)),
    ];

    await createMentionNotifications({
      poolId: parsed.data.poolId,
      mentionedUserIds,
      mentionerDisplayName: user.display_name,
      commentBody: comment.body,
    });
  }

  // CommentSheet already fully owns the acting user's own view via local
  // optimistic state (appends the new comment / pushes the updated count
  // locally) — see lib/actions/likes.ts's toggleLikeAction for the same
  // reasoning. Keep /pool/[id] only.
  revalidatePath(`/pool/${parsed.data.poolId}`);
  return {
    error: null,
    comment: {
      id: comment.id,
      body: comment.body,
      createdAt: comment.created_at,
      userId: comment.user_id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      username: user.username,
      parentCommentId: comment.parent_comment_id,
      // Always your own fresh comment here — the follow toggle is hidden
      // for the viewer's own rows regardless of this value.
      isFollowing: false,
    },
  };
}

export type DeleteCommentResult = { error: string | null };

export async function deleteCommentAction(
  commentId: string,
  poolId: string,
): Promise<DeleteCommentResult> {
  const user = await requireUser();

  const parsed = deleteCommentSchema.safeParse({ commentId });
  if (!parsed.success) {
    return { error: "Invalid comment." };
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient.rpc("delete_pool_comment", {
    p_comment_id: parsed.data.commentId,
    p_user_id: user.id,
  });

  if (error) {
    return { error: "Could not delete this comment." };
  }

  revalidatePath(`/pool/${poolId}`);
  return { error: null };
}
