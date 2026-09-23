// Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Conversation).
// A Comment belongs to exactly one canonical Post — never a Community,
// Market, or Pick (see docs/architecture/post-conversation.md). Deleted
// users/removed comments are handled by presentation, never by mutating
// this domain shape itself.

export interface PostComment {
  id: string;
  postId: string;
  userId: string;
  /** Null for a top-level comment; a top-level comment's own id for a reply. One level of nesting only — enforced by add_post_comment(). */
  parentCommentId: string | null;
  body: string;
  /** Non-null means removed (soft-delete/tombstone) — the row, and any replies beneath it, remain structurally intact. See post_comments.deleted_at's own migration comment. */
  deletedAt: string | null;
  createdAt: string;
}

/** Presentation-safe author fields only (public_profiles), never private profile data (§31). */
export interface PostCommentAuthor {
  id: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
}

export interface PostCommentWithAuthor extends PostComment {
  author: PostCommentAuthor;
  replies: PostCommentWithAuthor[];
}
