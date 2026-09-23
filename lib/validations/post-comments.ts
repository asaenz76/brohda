import { z } from "zod";

// Milestone R6. Mirrors lib/validations/comments.ts's own shape exactly.
// The 2000-char ceiling here matches post_comments.body's own hard
// technical CHECK constraint — the actual enforced product policy (default
// 500) is configurable and re-checked live inside add_post_comment() itself
// (supabase/migrations/20260101000153_post_comments.sql); this schema-level
// bound exists only to reject an obviously-pathological request before it
// ever reaches the database.
export const addPostCommentSchema = z
  .object({
    postId: z.string().uuid(),
    body: z.string().trim().min(1).max(2000),
    // Only present for a reply — one level deep, enforced in
    // add_post_comment (a parent that's itself a reply is rejected there).
    parentCommentId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type AddPostCommentInput = z.infer<typeof addPostCommentSchema>;

export const removePostCommentSchema = z
  .object({
    commentId: z.string().uuid(),
  })
  .strict();

export type RemovePostCommentInput = z.infer<typeof removePostCommentSchema>;
