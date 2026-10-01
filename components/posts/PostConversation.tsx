"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { addPostCommentAction, removePostCommentAction } from "@/lib/actions/post-comments";
import type { PostCommentWithAuthor } from "@/lib/post-comments/types";
import { CompactUserIdentity, type UserIdentityReputation } from "@/components/identity/UserIdentity";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Conversation) — the
// one conversation surface for a Post, mirroring CommentSheet.tsx's own
// composer/list/reply shape without its bottom-sheet chrome: this lives
// inline on /post/[id] (a full page, not a compact card), so it renders as
// a normal page section instead of a modal. Deliberately no MentionInput
// (R6 has no @mention engine) and no follow-toggle (not part of this
// milestone's scope) — a plain Textarea and author link are enough.
//
// Phase G (Brohda 2.0 redesign) — each comment's byline now uses the
// canonical identity system (CompactUserIdentity, Phase B/F) instead of a
// hand-built Avatar+Link+name, so a person "looks like the same person"
// in conversation as they do on their own Profile (spec §4, §23, §33).
// Reputation is context, never ranking (spec §5) — a zero-history
// commenter shows no reputation suffix at all (CompactUserIdentity's own
// formatter already omits it rather than showing "0 predicted").

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function CommentRow({
  comment,
  reputation,
  viewer,
  isPending,
  onDelete,
  onReply,
}: {
  comment: PostCommentWithAuthor;
  /** This commenter's canonical reputation, or null for a genuinely zero-history user — CompactUserIdentity already omits the reputation suffix entirely in that case, never a fabricated "0 predicted" (spec §6). */
  reputation: UserIdentityReputation | null;
  viewer: { id: string; isModerator: boolean };
  isPending: boolean;
  onDelete: (commentId: string) => void;
  // Only top-level comments get a Reply affordance — one level deep is
  // enforced here in the UI too, not just by add_post_comment rejecting it.
  onReply?: () => void;
}) {
  const isRemoved = comment.deletedAt !== null;
  const profileHref = `/profile/${comment.author.username ?? comment.author.id}`;
  const canRemove = !isRemoved && (comment.author.id === viewer.id || viewer.isModerator);

  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <CompactUserIdentity
            displayName={comment.author.displayName}
            avatarUrl={comment.author.avatarUrl}
            reputation={reputation}
            href={profileHref}
          />
          <p className="text-xs text-text-muted">{relativeTime(comment.createdAt)}</p>
        </div>
        <p className={isRemoved ? "text-sm italic text-text-muted" : "text-sm text-text-secondary"}>
          {isRemoved ? "[comment deleted]" : comment.body}
        </p>
        {onReply && !isRemoved && (
          <button type="button" onClick={onReply} className="text-xs font-medium text-text-muted hover:text-text-secondary">
            Reply
          </button>
        )}
      </div>
      {canRemove && (
        <Button type="button" variant="ghost" size="icon-xs" disabled={isPending} onClick={() => onDelete(comment.id)} aria-label="Delete comment">
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export function PostConversation({
  postId,
  viewer,
  initialComments,
  reputationByUserId,
}: {
  postId: string;
  viewer: { id: string; isModerator: boolean };
  initialComments: PostCommentWithAuthor[];
  /** Keyed by user id, batched server-side for every commenter in this thread (lib/reputation/repository.ts's getUserPredictionRecords) — a plain object, not a Map, since this crosses the Server->Client Component boundary as a prop. */
  reputationByUserId: Record<string, UserIdentityReputation>;
}) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const [comments, setComments] = useState<PostCommentWithAuthor[]>(initialComments);
  const [body, setBody] = useState("");
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const composerRef = useRef<HTMLTextAreaElement>(null);

  function postComment(text: string, parentCommentId: string | null) {
    setError(null);
    startTransition(async () => {
      const result = await addPostCommentAction(postId, text, parentCommentId);
      if (result.error || !result.comment) {
        setError(result.error ?? "Could not post your comment.");
        return;
      }
      if (parentCommentId) {
        setComments((prev) =>
          prev.map((c) => (c.id === parentCommentId ? { ...c, replies: [...c.replies, result.comment!] } : c)),
        );
        setReplyingToId(null);
        setReplyBody("");
      } else {
        setComments((prev) => [...prev, result.comment!]);
        setBody("");
      }
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    // Stage 4C real-production feedback: submitting a comment could land a
    // subsequent tap on the fixed bottom nav underneath, on mobile — the
    // on-screen keyboard dismissing at the same moment the comment list
    // grows shifts the whole page layout, and this composer sits at the
    // very bottom of it, closest to the nav bar of anything on the page.
    // Blurring immediately, before the mutation/re-render, dismisses the
    // keyboard on our own terms rather than mid-tap.
    composerRef.current?.blur();
    postComment(trimmed, null);
  }

  function handleReplySubmit(e: React.FormEvent, parentCommentId: string) {
    e.preventDefault();
    const trimmed = replyBody.trim();
    if (!trimmed) return;
    postComment(trimmed, parentCommentId);
  }

  function handleDelete(commentId: string) {
    setError(null);
    startTransition(async () => {
      const result = await removePostCommentAction(commentId, postId);
      if (result.error) {
        setError(result.error);
        return;
      }
      // Soft-delete (tombstone) — the row (and any replies beneath it)
      // stays in the tree, only its presentation changes. No cascading
      // removal, unlike legacy pool_comments' hard delete.
      setComments((prev) =>
        prev.map((c) =>
          c.id === commentId
            ? { ...c, deletedAt: new Date().toISOString() }
            : { ...c, replies: c.replies.map((r) => (r.id === commentId ? { ...r, deletedAt: new Date().toISOString() } : r)) },
        ),
      );
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-text-primary">Comments</p>

      <div className="space-y-4">
        {comments.length === 0 ? (
          <p className="text-sm text-text-muted">Be the first to comment.</p>
        ) : (
          comments.map((comment) => (
            <div key={comment.id} className="space-y-3">
              <CommentRow
                comment={comment}
                reputation={reputationByUserId[comment.author.id] ?? null}
                viewer={viewer}
                isPending={isPending}
                onDelete={handleDelete}
                onReply={() => {
                  setReplyingToId(comment.id);
                  setReplyBody("");
                }}
              />

              {comment.replies.map((reply) => (
                // Subtle indentation + a thin left border (spec §8) — just
                // enough to read as "a reply to the comment above," never a
                // deep Reddit-style tree (one level is all the backend
                // allows anyway).
                <div key={reply.id} className="ml-9 border-l border-border-subtle pl-3">
                  <CommentRow comment={reply} reputation={reputationByUserId[reply.author.id] ?? null} viewer={viewer} isPending={isPending} onDelete={handleDelete} />
                </div>
              ))}

              {replyingToId === comment.id && (
                <form onSubmit={(e) => handleReplySubmit(e, comment.id)} className="ml-9 flex items-start gap-2">
                  <Textarea
                    autoFocus
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    placeholder={`Reply to ${comment.author.displayName}…`}
                    className="min-h-10 text-sm"
                  />
                  <Button type="submit" size="sm" disabled={isPending || replyBody.trim().length === 0}>
                    Post
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReplyingToId(null)}>
                    Cancel
                  </Button>
                </form>
              )}
            </div>
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex items-start gap-2">
        <Textarea
          ref={composerRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          className="text-sm"
        />
        <Button type="submit" size="sm" disabled={isPending || body.trim().length === 0}>
          Post
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
