// Brohda 2.1 M4 — which Members are "in the conversation" on a Post, read from the thread as it is shown. Pure and client-safe: the Post page uses it to decide who gets a Call BS control inside their comment
// (and who stays in the "Other picks" list), and the thread uses it to put that control on each Member's FIRST visible comment only, so a Member who commented four times is not offered four buttons.

import type { PostCommentWithAuthor } from "./types";

/** Every comment in reading order: a top-level comment, then the replies beneath it, then the next top-level comment. */
export function flattenThread(comments: PostCommentWithAuthor[]): PostCommentWithAuthor[] {
  return comments.flatMap((comment) => [comment, ...comment.replies]);
}

/** A comment that shows its author and text: neither deleted (tombstoned) nor hidden because the viewer blocked its author. */
export function isVisibleComment(comment: Pick<PostCommentWithAuthor, "deletedAt" | "hiddenByBlock">): boolean {
  return comment.deletedAt === null && !comment.hiddenByBlock;
}

/** comment id → the author's user id, for each Member's first VISIBLE comment in reading order. */
export function firstVisibleCommentByAuthor(comments: PostCommentWithAuthor[]): Map<string, string> {
  const firstByAuthor = new Map<string, string>();
  for (const comment of flattenThread(comments)) {
    if (!isVisibleComment(comment) || firstByAuthor.has(comment.author.id)) continue;
    firstByAuthor.set(comment.author.id, comment.id);
  }
  return new Map([...firstByAuthor].map(([authorId, commentId]) => [commentId, authorId]));
}

/** The Members with at least one visible comment on the thread. */
export function visibleCommenterIds(comments: PostCommentWithAuthor[]): Set<string> {
  return new Set(flattenThread(comments).filter(isVisibleComment).map((comment) => comment.author.id));
}
