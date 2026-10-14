"use client";

import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { markNotificationReadAction } from "@/lib/actions/notifications";

/**
 * One notification row. Opening it marks THAT notification read, then goes where it points — the read mark is awaited first, so the destination page's unread badge is already correct (a fire-and-forget write
 * races the next page's render). If marking fails the Member still gets where they were going. A row with no destination is a button: pressing it marks it read in place. Already-read rows are plain links.
 */
export function NotificationItem({ id, href, unread, className, children }: { id: string; href: string | null; unread: boolean; className?: string; children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!unread) {
    return href ? (
      <a href={href} className={className}>
        {children}
      </a>
    ) : (
      <div className={className}>{children}</div>
    );
  }

  const open = () =>
    startTransition(async () => {
      try {
        await markNotificationReadAction(id);
      } catch {
        // Still go where the Member was going.
      }
      if (href) router.push(href);
      else router.refresh();
    });

  return href ? (
    <a
      href={href}
      className={className}
      aria-busy={pending}
      onClick={(e) => {
        // New-tab and modified clicks are left to the browser; only a plain click is intercepted.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        open();
      }}
    >
      {children}
    </a>
  ) : (
    <button type="button" className={`w-full text-left ${className ?? ""}`} aria-busy={pending} onClick={open}>
      {children}
    </button>
  );
}
