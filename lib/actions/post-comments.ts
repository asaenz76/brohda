"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { addPostComment, getPostConversation, removePostComment } from "@/lib/post-comments/repository";
import { addPostCommentSchema, removePostCommentSchema } from "@/lib/validations/post-comments";
import { checkPostCommentRateLimit } from "@/lib/rate-limit/post-comments";
import { createPostCommentReplyNotification } from "@/lib/notifications/post-comments";
import type { PostCommentWithAuthor } from "@/lib/post-comments/types";

// Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Conversation).
// Mirrors lib/actions/comments.ts's own shape: authenticated + validated +
// rate-limited + server-derived author, no client-supplied user_id ever
// trusted, every write through a SECURITY DEFINER RPC via the service role.
// Deliberately no @mention wiring (unlike pool comments) — not a gap, a
// scope decision: see docs/architecture/post-conversation.md.

export async function getPostConversationAction(postId: string): Promise<PostCommentWithAuthor[]> {
  await requireUser();
  return getPostConversation(postId);
}

export type AddPostCommentResult = { error: string | null; comment: PostCommentWithAuthor | null };

export async function addPostCommentAction(postId: string, body: string, parentCommentId: string | null = null): Promise<AddPostCommentResult> {
  const user = await requireUser();

  const parsed = addPostCommentSchema.safeParse({ postId, body, parentCommentId });
  if (!parsed.success) {
    return { error: "Comment must be between 1 and 2000 characters.", comment: null };
  }

  const allowed = await checkPostCommentRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many comments. Try again in a moment.", comment: null };
  }

  let created;
  try {
    created = await addPostComment({ postId: parsed.data.postId, userId: user.id, body: parsed.data.body, parentCommentId: parsed.data.parentCommentId ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("nesting_too_deep")) return { error: "Replies can't be nested further.", comment: null };
    if (message.includes("post_not_found")) return { error: "This post isn't available for comments.", comment: null };
    if (message.includes("body_too_long")) return { error: "That comment is too long.", comment: null };
    if (message.includes("parent_not_found")) return { error: "That comment couldn't be found.", comment: null };
    return { error: "Could not post your comment.", comment: null };
  }

  if (created.parentCommentId) {
    const admin = createAdminClient();
    const { data: parentComment } = await admin.from("post_comments").select("user_id").eq("id", created.parentCommentId).single();
    if (parentComment) {
      await createPostCommentReplyNotification({
        postId: parsed.data.postId,
        parentCommentUserId: parentComment.user_id,
        replierUserId: user.id,
        replierDisplayName: user.display_name,
        replyBody: created.body,
      });
    }
  }

  revalidatePath(`/post/${parsed.data.postId}`);
  return {
    error: null,
    comment: {
      ...created,
      author: { id: user.id, displayName: user.display_name, username: user.username, avatarUrl: user.avatar_url },
      replies: [],
    },
  };
}

export type RemovePostCommentResult = { error: string | null };

export async function removePostCommentAction(commentId: string, postId: string): Promise<RemovePostCommentResult> {
  const user = await requireUser();

  const parsed = removePostCommentSchema.safeParse({ commentId });
  if (!parsed.success) {
    return { error: "Invalid comment." };
  }

  try {
    await removePostComment(parsed.data.commentId, user.id);
  } catch {
    return { error: "Could not remove this comment." };
  }

  revalidatePath(`/post/${postId}`);
  return { error: null };
}
