"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import {
  addCommentAction,
  deleteCommentAction,
  getPoolCommentsAction,
  type PoolCommentItem,
} from "@/lib/actions/comments";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { MentionInput } from "@/components/pools/MentionInput";
import { MentionText } from "@/components/pools/MentionText";
import { UserFollowToggle } from "@/components/pools/UserFollowToggle";

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
  viewer,
  isPending,
  onDelete,
  onReply,
}: {
  comment: PoolCommentItem;
  viewer: { id: string; isModerator: boolean };
  isPending: boolean;
  onDelete: (commentId: string) => void;
  // Only top-level comments get a Reply affordance — one level deep is
  // enforced here in the UI too, not just by add_pool_comment rejecting it.
  onReply?: () => void;
}) {
  const profileHref = `/profile/${comment.username ?? comment.userId}`;

  return (
    <div className="flex items-start gap-3">
      <Link href={profileHref}>
        <Avatar displayName={comment.displayName} avatarUrl={comment.avatarUrl} size="sm" />
      </Link>
      <div className="flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <Link href={profileHref} className="text-sm font-semibold text-text-primary hover:underline">
            {comment.displayName}
          </Link>
          <p className="text-xs text-text-muted">{relativeTime(comment.createdAt)}</p>
          {comment.userId !== viewer.id && (
            <UserFollowToggle
              userId={comment.userId}
              displayName={comment.displayName}
              initiallyFollowing={comment.isFollowing}
            />
          )}
        </div>
        <MentionText text={comment.body} className="text-sm text-text-secondary" />
        {onReply && (
          <button
            type="button"
            onClick={onReply}
            className="text-xs font-medium text-text-muted hover:text-text-secondary"
          >
            Reply
          </button>
        )}
      </div>
      {(comment.userId === viewer.id || viewer.isModerator) && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={isPending}
          onClick={() => onDelete(comment.id)}
          aria-label="Delete comment"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

// v1 scope: one level of nesting — a top-level comment can have replies,
// but a reply can't itself be replied to. Mirrors
// EntryConfirmationSheet.tsx's focus-trapped bottom sheet for the
// read/compose surface.
export function CommentSheet({
  poolId,
  viewer,
  onClose,
  onCountChange,
}: {
  poolId: string;
  viewer: { id: string; isModerator: boolean };
  onClose: () => void;
  onCountChange: (count: number) => void;
}) {
  // relativeTime() below is a pure read of Date.now() — with nothing else
  // ticking this component's re-render, "Posted Xm ago" would otherwise
  // freeze at whatever it showed on first render for as long as the sheet
  // stays open. 30s matches the minute-level display granularity.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const [comments, setComments] = useState<PoolCommentItem[] | null>(null);
  const [body, setBody] = useState("");
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const sheetRef = useRef<HTMLDivElement>(null);
  // Skips the initial fetch below — SocialPoolCard's count already starts
  // from its own server-computed viewModel.commentCount, so only a *later*
  // change (post/delete) needs to be pushed back up to it.
  const isInitialLoad = useRef(true);

  useEffect(() => {
    getPoolCommentsAction(poolId).then(setComments);
  }, [poolId]);

  // Reacting to our own state change here (not calling onCountChange
  // synchronously inside the setComments updaters below) avoids React's
  // "Cannot update a component while rendering a different component"
  // warning — SocialPoolCard's setCommentCount must only ever be called
  // from an effect/event handler, never from inside another component's
  // state updater function.
  useEffect(() => {
    if (comments === null) return;
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      return;
    }
    onCountChange(comments.length);
  }, [comments, onCountChange]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;

      const focusables = sheetRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  function postComment(text: string, parentCommentId: string | null) {
    setError(null);
    startTransition(async () => {
      const result = await addCommentAction(poolId, text, parentCommentId);
      if (result.error || !result.comment) {
        setError(result.error ?? "Could not post your comment.");
        return;
      }
      setComments((prev) => [...(prev ?? []), result.comment!]);
      if (parentCommentId) {
        setReplyingToId(null);
        setReplyBody("");
      } else {
        setBody("");
      }
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
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
      const result = await deleteCommentAction(commentId, poolId);
      if (result.error) {
        setError(result.error);
        return;
      }
      // A deleted top-level comment cascades to its replies server-side
      // (delete_pool_comment/on delete cascade) — drop both here too.
      setComments((prev) =>
        (prev ?? []).filter((c) => c.id !== commentId && c.parentCommentId !== commentId),
      );
    });
  }

  const topLevelComments = (comments ?? []).filter((c) => c.parentCommentId === null);
  const repliesByParentId = new Map<string, PoolCommentItem[]>();
  for (const comment of comments ?? []) {
    if (!comment.parentCommentId) continue;
    const replies = repliesByParentId.get(comment.parentCommentId) ?? [];
    replies.push(comment);
    repliesByParentId.set(comment.parentCommentId, replies);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Comments"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-[720px] flex-col space-y-4 rounded-t-2xl bg-surface-primary p-5 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-subtle" aria-hidden="true" />

        <p className="text-sm font-semibold text-text-primary">Comments</p>

        <div className="flex-1 space-y-4 overflow-y-auto">
          {comments === null ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : topLevelComments.length === 0 ? (
            <p className="text-sm text-text-muted">Be the first to comment.</p>
          ) : (
            topLevelComments.map((comment) => (
              <div key={comment.id} className="space-y-3">
                <CommentRow
                  comment={comment}
                  viewer={viewer}
                  isPending={isPending}
                  onDelete={handleDelete}
                  onReply={() => {
                    setReplyingToId(comment.id);
                    setReplyBody("");
                  }}
                />

                {(repliesByParentId.get(comment.id) ?? []).map((reply) => (
                  <div key={reply.id} className="ml-9">
                    <CommentRow
                      comment={reply}
                      viewer={viewer}
                      isPending={isPending}
                      onDelete={handleDelete}
                    />
                  </div>
                ))}

                {replyingToId === comment.id && (
                  <form
                    onSubmit={(e) => handleReplySubmit(e, comment.id)}
                    className="ml-9 flex items-center gap-2"
                  >
                    <MentionInput
                      autoFocus
                      value={replyBody}
                      onChange={setReplyBody}
                      placeholder={`Reply to ${comment.displayName}…`}
                      className="w-full rounded-full border border-border-subtle bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={isPending || replyBody.trim().length === 0}
                    >
                      Post
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setReplyingToId(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                )}
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <MentionInput
            value={body}
            onChange={setBody}
            placeholder="Add a comment…"
            className="w-full rounded-full border border-border-subtle bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted"
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
    </div>
  );
}
