"use client";

import { useEffect } from "react";

// Depending on how the project's Auth is configured, the verification redirect can carry tokens in the URL fragment. Nothing here uses them, so they are
// removed from the address bar (and history) immediately.
export function ScrubUrlHash() {
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return null;
}
