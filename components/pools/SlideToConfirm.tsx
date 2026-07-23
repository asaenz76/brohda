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
  const startXRef = useRef(0);

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
              onConfirm();
            }
          }}
          className={cn(
            "absolute top-0.5 left-0.5 flex touch-none items-center justify-center rounded-full bg-accent-primary text-white shadow outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            !dragging && "transition-[left] duration-200",
            pending && "opacity-70",
          )}
          style={{ left: `${dragX + 2}px`, width: THUMB_SIZE, height: THUMB_SIZE }}
        >
          →
        </div>
      </div>
      <button
        type="button"
        onClick={() => !pending && onConfirm()}
        disabled={pending}
        className="w-full text-center text-xs text-text-muted underline underline-offset-4 disabled:opacity-50"
      >
        Or tap here to confirm
      </button>
    </div>
  );
}
