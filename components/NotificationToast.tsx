"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { getNotificationPollStateAction } from "@/lib/actions/notifications";
import { getNotificationTier } from "@/lib/notifications/tiers";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 20_000;
const AUTO_DISMISS_MS = 6_000;

interface ToastState {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string | null;
}

/**
 * Session-local toast for a newly-arrived notification — polls the same
 * unread-count query the nav badge already uses, no realtime subscription
 * (Decision 5). The first poll only establishes a baseline so notifications
 * that predate this page load never surface a toast.
 */
export function NotificationToast({ initialUnreadCount }: { initialUnreadCount: number }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const seenIdRef = useRef<string | null>(null);
  const seenCountRef = useRef(initialUnreadCount);
  const hasBaselineRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      // A background poll failing (session expired, transient network
      // blip) isn't worth surfacing — swallow it here rather than let an
      // unhandled rejection repeat every POLL_INTERVAL_MS for the rest of
      // the tab's lifetime.
      let state;
      try {
        state = await getNotificationPollStateAction();
      } catch {
        return;
      }
      if (cancelled) return;

      if (!hasBaselineRef.current) {
        hasBaselineRef.current = true;
        seenIdRef.current = state.latestId;
        seenCountRef.current = state.unreadCount;
        return;
      }

      const unreadIncreased = state.unreadCount > seenCountRef.current;

      if (state.latestId != null && state.latestId !== seenIdRef.current && unreadIncreased && state.latestTitle) {
        setToast({
          id: state.latestId,
          type: state.latestType ?? "",
          title: state.latestTitle,
          body: state.latestBody ?? "",
          href: state.latestHref,
        });
      }

      seenIdRef.current = state.latestId;
      seenCountRef.current = state.unreadCount;
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timeout);
  }, [toast]);

  if (!toast) return null;

  // Reuses the same pool-win/pool-loss tier-1 treatment already established
  // in PoolStatusNotice.tsx and the Activity list, so a win reads as the
  // same distinct, celebratory event no matter which of the three surfaces
  // the player happens to see it on first.
  const tier = getNotificationTier(toast.type);
  const isWin = toast.type === "SETTLED_WON";
  const isLoss = toast.type === "SETTLED_LOST";

  const titleClassName = cn(
    "text-sm font-medium text-text-primary",
    tier === 1 && "text-base font-bold",
    tier === 1 && isWin && "text-pool-win",
    tier === 1 && isLoss && "text-pool-loss",
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed inset-x-4 bottom-20 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-xl border border-border-subtle bg-surface-primary p-4 shadow-lg animate-[toast-slide-in_0.25s_ease-out]",
        tier === 1 && isWin && "bg-pool-win/10 animate-[toast-slide-in_0.25s_ease-out,celebrate-pop_0.4s_ease-out]",
        tier === 1 && isLoss && "bg-pool-loss/10",
      )}
    >
      {toast.href ? (
        // Plain <a>, not next/link — see TransactionRow's comment: a
        // hash-only target needs a native anchor navigation so
        // "hashchange" actually fires when this toast is shown while
        // already sitting on /activity.
        <a href={toast.href} className="flex-1" onClick={() => setToast(null)}>
          <p className={titleClassName}>{toast.title}</p>
          {toast.body && <p className="mt-0.5 text-sm text-text-secondary">{toast.body}</p>}
        </a>
      ) : (
        <div className="flex-1">
          <p className={titleClassName}>{toast.title}</p>
          {toast.body && <p className="mt-0.5 text-sm text-text-secondary">{toast.body}</p>}
        </div>
      )}
      <button
        type="button"
        onClick={() => setToast(null)}
        aria-label="Dismiss notification"
        className="text-text-muted hover:text-text-primary"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
