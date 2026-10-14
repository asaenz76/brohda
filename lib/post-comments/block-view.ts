import type { PostCommentWithAuthor } from "./types";

/**
 * Per-viewer presentation of a Member block: the blocker does not see the blocked Member's comments. A blocked top-level comment that other Members replied to stays as a placeholder (so their replies keep
 * their context); one with no visible replies, and every blocked reply, is simply left out. Nothing is deleted or changed for anyone else — a block is a boundary between two Members, not moderation.
 */
export function hideBlockedAuthors(tree: PostCommentWithAuthor[], blocked: ReadonlySet<string>): PostCommentWithAuthor[] {
  if (blocked.size === 0) return tree;
  const out: PostCommentWithAuthor[] = [];
  for (const comment of tree) {
    const replies = comment.replies.filter((r) => !blocked.has(r.userId));
    if (!blocked.has(comment.userId)) {
      out.push({ ...comment, replies });
    } else if (replies.length > 0) {
      out.push({ ...comment, body: "", author: { id: comment.userId, displayName: "Blocked Member", username: null, avatarUrl: null }, replies, hiddenByBlock: true });
    }
  }
  return out;
}
