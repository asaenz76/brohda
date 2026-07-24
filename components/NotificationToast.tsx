"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { getNotificationPollStateAction } from "@/lib/actions/notifications";

const POLL_INTERVAL_MS = 20_000;
const AUTO_DISMISS_MS = 6_000;

interface ToastState {
  id: string;
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

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-20 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-xl border border-border-subtle bg-surface-primary p-4 shadow-lg animate-[toast-slide-in_0.25s_ease-out]"
    >
      {toast.href ? (
        // Plain <a>, not next/link — see TransactionRow's comment: a
        // hash-only target needs a native anchor navigation so
        // "hashchange" actually fires when this toast is shown while
        // already sitting on /activity.
        <a href={toast.href} className="flex-1" onClick={() => setToast(null)}>
          <p className="text-sm font-medium text-text-primary">{toast.title}</p>
          {toast.body && <p className="mt-0.5 text-sm text-text-secondary">{toast.body}</p>}
        </a>
      ) : (
        <div className="flex-1">
          <p className="text-sm font-medium text-text-primary">{toast.title}</p>
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
