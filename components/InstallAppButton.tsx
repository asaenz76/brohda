"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Download, Share, SquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";

// Chrome/Edge on Android (and desktop) fire this before showing their own
// install UI — capturing and preventDefault()-ing it lets us show our own
// button instead, then trigger the native prompt on click. iOS has no
// equivalent event at all (Apple has never shipped an install API), so
// there's nothing to capture there — see the iOS branch below instead.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as "Macintosh" with touch support — the standard
  // way to distinguish it from a real Mac.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  // iOS Safari's own (non-standard) flag, plus the standard display-mode
  // media query every other install-capable browser sets once installed.
  return (
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

const emptySubscribe = () => () => {};

// Same "only real once hydrated" pattern as ThemeToggle's useIsMounted —
// reading navigator/window during the server's render (where neither
// exists) would otherwise mismatch the client's first render.
function useIsMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

/**
 * "Get the app" — the closest thing to an App Store presence without one.
 * Android/desktop Chrome/Edge get a real one-tap install via
 * beforeinstallprompt; iOS Safari (no install API exists) gets a short
 * instructional sheet for the manual Share -> Add to Home Screen flow.
 * Hidden entirely once already installed, and on browsers that support
 * neither path (nothing useful for the button to do there).
 */
export function InstallAppButton() {
  const mounted = useIsMounted();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showIosSheet, setShowIosSheet] = useState(false);

  useEffect(() => {
    function handleBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    function handleInstalled() {
      setInstalled(true);
      setDeferredPrompt(null);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  if (!mounted) return null;
  if (installed || isStandalone()) return null;
  const iosEligible = isIosSafari();
  if (!deferredPrompt && !iosEligible) return null;

  async function handleClick() {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") setInstalled(true);
      setDeferredPrompt(null);
      return;
    }
    setShowIosSheet(true);
  }

  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Get the app" onClick={handleClick}>
        <Download className="size-4" />
      </Button>
      {showIosSheet && <IosInstallSheet onClose={() => setShowIosSheet(false)} />}
    </>
  );
}

function IosInstallSheet({ onClose }: { onClose: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheetRef.current?.focus();
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Portalled to document.body rather than rendered in place: LandingNav's
  // header has backdrop-blur, and backdrop-filter (like filter) creates a
  // new containing block for position:fixed descendants — without the
  // portal, this sheet's "fixed inset-0" resolves against the header's own
  // small box instead of the viewport, confining it to a sliver under the
  // nav bar instead of covering the screen (caught via a real iPhone
  // screenshot, not local testing — the dev layout doesn't reproduce it
  // because it never renders through LandingNav's header).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" role="presentation" onClick={onClose}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add brohda. to your Home Screen"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] space-y-4 rounded-t-2xl bg-surface-primary p-5 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-subtle" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-text-primary">Add brohda. to your Home Screen</h2>
        <ol className="space-y-3 text-sm text-text-secondary">
          <li className="flex items-center gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-xs font-semibold text-text-primary">
              1
            </span>
            <span className="flex items-center gap-1.5">
              Tap the Share icon <Share className="size-4 shrink-0 text-text-primary" aria-hidden="true" /> in Safari&apos;s toolbar.
            </span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-xs font-semibold text-text-primary">
              2
            </span>
            <span className="flex items-center gap-1.5">
              Scroll down and tap <SquarePlus className="size-4 shrink-0 text-text-primary" aria-hidden="true" /> &quot;Add to Home
              Screen&quot;.
            </span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-xs font-semibold text-text-primary">
              3
            </span>
            <span>Tap &quot;Add&quot; — brohda. opens like a regular app from now on.</span>
          </li>
        </ol>
        <Button type="button" variant="outline" className="w-full" onClick={onClose}>
          Got it
        </Button>
      </div>
    </div>,
    document.body,
  );
}
