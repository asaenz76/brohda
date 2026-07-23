import { z } from "zod";

export const addCommentSchema = z
  .object({
    poolId: z.string().uuid(),
    body: z.string().trim().min(1).max(500),
    // Only present for a reply — one level deep, enforced in
    // add_pool_comment (a parent that's itself a reply is rejected there).
    parentCommentId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type AddCommentInput = z.infer<typeof addCommentSchema>;

export const deleteCommentSchema = z
  .object({
    commentId: z.string().uuid(),
  })
  .strict();

export type DeleteCommentInput = z.infer<typeof deleteCommentSchema>;
