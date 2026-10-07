"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { canGoBackInApp, emptyHistory, recordLocation, type InAppHistory, type NavigationKind } from "@/lib/navigation/in-app-history";

// Module state (not React state): a Back control that mounts later must still see the navigation that already happened, and nothing re-renders when it changes.
let history: InAppHistory = emptyHistory();
let nextKind: NavigationKind = "push";
let listening = false;

/** True when the previous history entry is a page of this app (see lib/navigation/in-app-history.ts). */
export const hasInAppBack = (): boolean => canGoBackInApp(history);

/** The next location change replaces the current history entry (a Back control taking its fallback) instead of adding one. */
export const markNextNavigationReplace = (): void => {
  nextKind = "replace";
};

/** Mounted once in the signed-in shell. Renders nothing. */
export function InAppHistoryTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (listening) return;
    listening = true;
    // Next's App Router answers the browser's Back/Forward with a popstate, then updates the pathname; the flag tells the next location change which it was.
    window.addEventListener("popstate", () => {
      nextKind = "history";
    });
  }, []);

  useEffect(() => {
    history = recordLocation(history, pathname, nextKind);
    nextKind = "push";
  }, [pathname]);

  return null;
}
