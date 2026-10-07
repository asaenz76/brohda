"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { hasInAppBack, markNextNavigationReplace } from "@/components/shell/InAppHistoryTracker";

/**
 * The detail pages' Back control: it takes you back to where you CAME FROM. Normal in-app navigation uses the real previous history entry
 * (router.back(), so the page you left — and its scroll position — is restored). A visitor with no in-app previous page (a shared link, a
 * notification, a bookmark, a reload) is sent to `fallbackHref`, the page's canonical parent, replacing the entry they were on. The href is real, so it also works with a
 * modified click (new tab) and without JavaScript. The text is visible at every width: Back must never be only a bare arrow.
 */
export function BackLink({ fallbackHref, label = "Back" }: { fallbackHref: string; label?: string }) {
  const router = useRouter();
  return (
    <Link
      href={fallbackHref}
      onClick={(event) => {
        // Let the browser handle new-tab / new-window / download gestures.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (hasInAppBack()) {
          router.back();
        } else {
          // No in-app previous page: take the fallback by REPLACING this entry, so Back never bounces between a deep-linked page and its fallback.
          markNextNavigationReplace();
          router.replace(fallbackHref);
        }
      }}
      className="-ml-2 flex h-9 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-text-secondary outline-none hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowLeft className="size-5" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}
