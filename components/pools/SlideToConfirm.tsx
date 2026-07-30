"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface SlideToConfirmProps {
  onConfirm: () => void;
  pending: boolean;
  label?: string;
  pendingLabel?: string;
}

const THRESHOLD = 0.85;
const THUMB_SIZE = 40;

// iOS never implemented the Vibration API (no Safari, no third-party iOS
// browser — they're all WebKit under the hood) and never will, so a chime
// is the only one of the three feedback channels that actually reaches an
// iPhone. Synthesized via Web Audio rather than an audio file — no asset
// to ship, and playing it directly inside the confirming tap/drag-release
// (a genuine user gesture) satisfies Safari's autoplay-unlock rule. Web
// Audio already respects the hardware silent switch on iOS, unlike some
// <audio>-element playback configurations, so a muted phone stays muted.
function playConfirmChime() {
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    // Two quick ascending notes — a short, unmistakable "confirmed" chime.
    [660, 880].forEach((frequency, i) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const start = now + i * 0.09;
      // Ramped envelope (not an instant on/off) so each note doesn't click.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.16);
    });

    // Browsers cap how many AudioContext instances can be alive at once —
    // close it shortly after both notes finish rather than leaking one per
    // confirmed entry.
    setTimeout(() => ctx.close(), 400);
  } catch {
    // Unsupported browser, blocked by a permissions policy, etc. — the
    // visual pop (and vibration where supported) already cover this.
  }
}

// X.5.9: a real pointer-drag gesture (not a styled button) — disables
// during submission, prevents repeated taps, and ships a keyboard-
// accessible + standard-button fallback for accessibility settings.
export function SlideToConfirm({
  onConfirm,
  pending,
  label = "Slide to Lock In",
  pendingLabel = "Locking in…",
}: SlideToConfirmProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [trackWidthPx, setTrackWidthPx] = useState(1);
  const [justConfirmed, setJustConfirmed] = useState(false);
  const startXRef = useRef(0);
  // Callers (EntryConfirmationSheet) pass a fresh onConfirm closure every
  // render — read the latest one through a ref inside the window-level
  // drag listeners below instead of depending on it directly, so those
  // listeners never need to tear down and re-attach mid-drag. Updated in
  // an effect (not during render) since refs aren't meant to be written
  // while rendering.
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => {
    onConfirmRef.current = onConfirm;
  });

  // Instant micro-feedback at the moment of the gesture itself — not
  // gated on the server round trip, so it lands immediately regardless of
  // network latency. Vibration is feature-detected (unsupported on iOS —
  // see playConfirmChime's comment) and silently no-ops there; the chime
  // and visual pop still play on every platform. Reduced-motion is
  // already handled globally (globals.css zeroes every animation duration
  // under prefers-reduced-motion), so no extra guard is needed here.
  function fireConfirmFeedback() {
    setJustConfirmed(true);
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(15);
    playConfirmChime();
  }

  // Ref reads (clientWidth) belong in an effect, not render — measure via
  // ResizeObserver rather than computing from trackRef.current during render.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    function updateWidth() {
      setTrackWidthPx(Math.max(1, el!.clientWidth - THUMB_SIZE - 4));
    }

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (pending) return;
    setDragging(true);
    startXRef.current = e.clientX - dragX;
  }

  // Listening on window (not just the thumb's own onPointerMove/onPointerUp)
  // once dragging starts, rather than relying solely on setPointerCapture —
  // real touch gestures on iOS Safari don't reliably re-deliver pointerup
  // to the origin element (a known WebKit quirk), which silently dropped
  // both the entry and the confirm feedback on a real device even though a
  // slower mouse-simulated drag in desktop testing never showed it. Also
  // computes the final ratio directly from the release event's own
  // coordinate rather than trusting the last committed dragX, since a fast
  // swipe can outrun however many intermediate pointermove events actually
  // arrive before the finger lifts.
  useEffect(() => {
    if (!dragging) return;

    function clamp(clientX: number) {
      return Math.min(Math.max(0, clientX - startXRef.current), trackWidthPx);
    }

    function handleMove(e: PointerEvent) {
      setDragX(clamp(e.clientX));
    }

    function handleUp(e: PointerEvent) {
      setDragging(false);
      const finalX = clamp(e.clientX);
      const ratio = trackWidthPx > 0 ? finalX / trackWidthPx : 0;
      if (ratio >= THRESHOLD) {
        setDragX(trackWidthPx);
        fireConfirmFeedback();
        onConfirmRef.current();
      } else {
        setDragX(0);
      }
    }

    // A cancelled gesture (e.g. an incoming call, iOS's own edge-swipe
    // taking over) always snaps back, regardless of how far it had
    // dragged — cancellation means the gesture didn't complete normally,
    // so it must never still count as a confirm the way handleUp's
    // threshold check would.
    function handleCancel() {
      setDragging(false);
      setDragX(0);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    };
  }, [dragging, trackWidthPx]);

  const ratio = trackWidthPx > 0 ? dragX / trackWidthPx : 0;

  return (
    <div className="space-y-2">
      <div
        ref={trackRef}
        className="relative h-11 overflow-hidden rounded-full bg-surface-secondary select-none"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent-primary/20"
          style={{ width: `${dragX + THUMB_SIZE / 2}px` }}
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium text-text-secondary"
          style={{ opacity: 1 - ratio }}
        >
          {pending ? pendingLabel : label}
        </span>
        <div
          role="slider"
          tabIndex={pending ? -1 : 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-label={label}
          aria-disabled={pending}
          onPointerDown={handlePointerDown}
          onKeyDown={(e) => {
            if (pending) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setDragX(trackWidthPx);
              fireConfirmFeedback();
              onConfirm();
            }
          }}
          className={cn(
            "absolute top-0.5 left-0.5 flex touch-none items-center justify-center rounded-full bg-accent-primary text-white shadow outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            !dragging && "transition-[left] duration-200",
            pending && "opacity-70",
            justConfirmed && "animate-[celebrate-pop_0.4s_ease-out]",
          )}
          style={{ left: `${dragX + 2}px`, width: THUMB_SIZE, height: THUMB_SIZE }}
        >
          →
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          if (pending) return;
          setDragX(trackWidthPx);
          fireConfirmFeedback();
          onConfirm();
        }}
        disabled={pending}
        className="w-full text-center text-xs text-text-muted underline underline-offset-4 disabled:opacity-50"
      >
        Or tap here to confirm
      </button>
    </div>
  );
}
