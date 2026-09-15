"use client";

import { useEffect, useState } from "react";
import { Users, Trophy, Clock } from "lucide-react";
import { formatCents } from "@/lib/utils/money";
import { cn } from "@/lib/utils";

interface PoolSummaryProps {
  participantCount: number;
  /** Null for a FREE pool — never rendered as a "$0 pot", omitted entirely. */
  grossPool: number | null;
  locksAt: string;
  // True only while choices are genuinely still closed with no result yet
  // (LOCKED/LIVE) — a resolved pool hides the countdown line entirely
  // rather than showing a stale/misleading value (PoolResult/
  // PoolStatusNotice already carry the accurate terminal-state copy).
  isLocked: boolean;
  isResolved: boolean;
}

function countdown(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "Locked";
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  if (days > 0) return `Locks in ${days}d ${hourRemainder}h`;
  const remainder = minutes % 60;
  return hours > 0 ? `Locks in ${hours}h ${remainder}m` : `Locks in ${remainder}m`;
}

// "Check before kickoff — that's the last chance to see who's with the
// room" only reads as a real moment if the countdown itself signals
// urgency once it's actually close. 15 minutes matches the same
// last-call window a countdown timer conventionally uses.
const URGENT_LOCK_WINDOW_MS = 15 * 60_000;

function isUrgentLock(iso: string): boolean {
  const diffMs = new Date(iso).getTime() - Date.now();
  return diffMs > 0 && diffMs <= URGENT_LOCK_WINDOW_MS;
}

// Bottom summary row: how many entered, how big the pot is, how long until
// lock — three even, icon-led stats (matches the approved mockup's
// people/trophy/clock row) rather than an avatar stack or personal
// "You're in" pill. Personal entry state is already conveyed by the
// choice button's own solid-fill selected state above — repeating it here
// would be the same fact twice. Administrative metadata (visibility,
// posted time) deliberately lives elsewhere (Pool Details) — this row is
// about the pool's current activity, not its setup.
export function PoolSummary({ participantCount, grossPool, locksAt, isLocked, isResolved }: PoolSummaryProps) {
  // countdown() is a pure read of Date.now() — with nothing else ticking
  // this component's re-render, the very first render's text would
  // otherwise freeze in the DOM for as long as the card stays mounted. 30s
  // matches the minute-level display granularity without over-rendering.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (isResolved) return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [isResolved]);

  const lockText = isResolved ? null : isLocked ? "Choices Locked" : countdown(locksAt);
  const urgent = !isResolved && !isLocked && isUrgentLock(locksAt);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs font-medium text-text-secondary sm:text-sm">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <Users className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        {participantCount} {grossPool == null ? "predicted" : "entered"}
      </span>
      {grossPool != null && (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <Trophy className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
          {formatCents(grossPool)} pot
        </span>
      )}
      {lockText && (
        <span className={cn("flex items-center gap-1.5 whitespace-nowrap", urgent && "font-semibold text-warning-muted")}>
          <Clock className={cn("size-3.5 shrink-0", urgent ? "text-warning-muted" : "text-text-muted")} aria-hidden="true" />
          {lockText}
        </span>
      )}
    </div>
  );
}
