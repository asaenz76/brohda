"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { addPostCommentAction, removePostCommentAction } from "@/lib/actions/post-comments";
import type { PostCommentWithAuthor } from "@/lib/post-comments/types";
import { firstVisibleCommentByAuthor, flattenThread, isVisibleComment } from "@/lib/post-comments/commenters";
import type { ConversationSocial, PostSocialSide } from "@/lib/challenges/post-social";
import { CompactUserIdentity, type UserIdentityReputation } from "@/components/identity/UserIdentity";
import { ChallengeAction } from "@/components/predictions/ChallengeAction";
import { HeadToHeadLine } from "@/components/profile/CallBsRecordLine";
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

/** Which side a commenter is arguing from. Text, never colour alone: "Picked Buffalo Bills", and "Other side" when it is not the viewer's. The Member's CURRENT Pick (final once picks lock) — the canonical Pick, not a second per-comment prediction. */
function CommentSide({ side }: { side: PostSocialSide }) {
  return (
    <p className="text-xs text-text-muted" data-slot="comment-side" data-relation={side.relation} data-outcome={side.outcome}>
      <span className="font-medium text-text-secondary">Picked {side.label}</span>
      {side.relation === "opposite" && <span> · Other side</span>}
    </p>
  );
}

function CommentRow({
  comment,
  reputation,
  viewer,
  isPending,
  onDelete,
  onReply,
  side,
  callBsMarketId,
}: {
  comment: PostCommentWithAuthor;
  /** M4: the author's side on the Game, when the viewer has picked (commit-before-crowd: null otherwise), and the Market a Call BS on them would be about — set only on the author's first visible comment. */
  side?: PostSocialSide | null;
  callBsMarketId?: string | null;
  /** This commenter's canonical reputation, or null for a genuinely zero-history user — CompactUserIdentity already omits the reputation suffix entirely in that case, never a fabricated "0 predicted" (spec §6). */
  reputation: UserIdentityReputation | null;
  viewer: { id: string; isModerator: boolean };
  isPending: boolean;
  onDelete: (commentId: string) => void;
  // Only top-level comments get a Reply affordance — one level deep is
  // enforced here in the UI too, not just by add_post_comment rejecting it.
  onReply?: () => void;
}) {
  if (comment.hiddenByBlock) {
    // Placeholder for a comment by a Member the viewer blocked: no author, no text, no actions — it only keeps the replies beneath it in context.
    return (
      <p className="text-sm italic text-text-muted" data-slot="comment-hidden-by-block">
        [comment hidden — you blocked this Member]
      </p>
    );
  }
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
        {side && !isRemoved && <CommentSide side={side} />}
        <p className={isRemoved ? "text-sm italic text-text-muted" : "text-sm text-text-secondary"}>
          {isRemoved ? "[comment deleted]" : comment.body}
        </p>
        {(onReply || (side && callBsMarketId && side.relation === "opposite")) && !isRemoved && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-slot="comment-actions">
            {onReply && (
              <button type="button" onClick={onReply} className="min-h-9 text-xs font-medium text-text-muted hover:text-text-secondary">
                Reply
              </button>
            )}
            {side && callBsMarketId && side.relation === "opposite" && side.action && (
              <div data-slot="comment-call-bs">
                <ChallengeAction marketId={callBsMarketId} state={side.action} targetName={side.displayName} align="start" />
              </div>
            )}
          </div>
        )}
        {side && callBsMarketId && !isRemoved && side.relation === "opposite" && side.headToHead && (
          <HeadToHeadLine opponentName={side.displayName} wins={side.headToHead.wins} losses={side.headToHead.losses} />
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
  social = null,
  gameOver = false,
}: {
  /** M7: the Game has finished (or was cancelled): the prompts talk about the RESULT, not about why someone picked — that moment has passed. */
  gameOver?: boolean;
  /** M4: the viewer's side and every other Member's side on this Game's Market (null until the viewer has picked, exactly as the rest of the Post withholds sides before a Pick). */
  social?: ConversationSocial | null;
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
  const [otherSideOnly, setOtherSideOnly] = useState(false);

  // M4: each Member's Call BS control sits on their FIRST visible comment only; a comment posted by the viewer a moment ago has no side data yet (the next render has), so it simply shows none.
  const sideFor = (userId: string): PostSocialSide | null => social?.byUserId[userId] ?? null;
  const firstCommentOf = firstVisibleCommentByAuthor(comments);
  const callBsMarketFor = (commentId: string): string | null => (social && firstCommentOf.has(commentId) ? social.marketId : null);
  const isOtherSide = (c: PostCommentWithAuthor) => isVisibleComment(c) && sideFor(c.author.id)?.relation === "opposite";
  const threadHasOtherSide = (c: PostCommentWithAuthor) => isOtherSide(c) || c.replies.some(isOtherSide);
  // How many Members on the other side have said something (people, not comments).
  const otherSideFans = new Set(flattenThread(comments).filter(isOtherSide).map((c) => c.author.id)).size;
  const shown = social && otherSideOnly ? comments.filter(threadHasOtherSide) : comments;

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">Comments</p>
        {social && otherSideFans > 0 && (
          <Button type="button" variant={otherSideOnly ? "default" : "outline"} size="sm" aria-pressed={otherSideOnly} data-slot="other-side-filter" onClick={() => setOtherSideOnly((on) => !on)}>
            {otherSideOnly ? "Showing" : "Show only"} {social.otherLabel} fans ({otherSideFans})
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {comments.length === 0 ? (
          <p className="text-sm text-text-muted" data-slot="empty-conversation">
            {gameOver ? "Nobody has said anything yet. Talk about the result." : social ? `Nobody has said anything yet. Say why you picked ${social.viewer.label}.` : "Be the first to comment."}
          </p>
        ) : (
          shown.map((comment) => (
            <div key={comment.id} className="space-y-3">
              <CommentRow
                comment={comment}
                reputation={reputationByUserId[comment.author.id] ?? null}
                viewer={viewer}
                isPending={isPending}
                onDelete={handleDelete}
                side={sideFor(comment.author.id)}
                callBsMarketId={callBsMarketFor(comment.id)}
                onReply={comment.hiddenByBlock ? undefined : () => {
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
                  <CommentRow
                    comment={reply}
                    reputation={reputationByUserId[reply.author.id] ?? null}
                    viewer={viewer}
                    isPending={isPending}
                    onDelete={handleDelete}
                    side={sideFor(reply.author.id)}
                    callBsMarketId={callBsMarketFor(reply.id)}
                  />
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

      {social && comments.length > 0 && (
        <p className="text-xs text-text-muted" data-slot="composer-prompt">
          {gameOver ? "Talk about the result." : <>Say why you picked {social.viewer.label}.</>}
        </p>
      )}
      <form onSubmit={handleSubmit} className="flex items-start gap-2">
        <Textarea
          ref={composerRef}
          aria-label="Add a comment"
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
