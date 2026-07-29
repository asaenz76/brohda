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
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging || pending) return;
    const next = Math.min(Math.max(0, e.clientX - startXRef.current), trackWidthPx);
    setDragX(next);
  }

  function handlePointerUp() {
    if (!dragging) return;
    setDragging(false);
    const ratio = dragX / trackWidthPx;
    if (ratio >= THRESHOLD) {
      setDragX(trackWidthPx);
      fireConfirmFeedback();
      onConfirm();
    } else {
      setDragX(0);
    }
  }

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
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
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
