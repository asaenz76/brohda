"use client";

import { useEffect, useState } from "react";
import type { PoolVisibility } from "@/lib/pools/card-state";
import type { PoolType } from "@/lib/pools/templates";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import { LeagueFollowToggle } from "@/components/pools/LeagueFollowToggle";

interface PoolLeagueHeaderProps {
  competitionName: string | null;
  competitionCountry: string | null;
  competitionLogoUrl: string | null;
  poolType: PoolType;
  visibility: PoolVisibility;
  createdAt: string;
  locksAt: string;
  // Null whenever there's no viewer to follow as (logged-out landing
  // preview) or the league hasn't been backfilled into `leagues` yet, or
  // the pool has no competition at all (CUSTOM/COMBO).
  leagueFollow?: SocialPoolCardViewModel["fixture"]["leagueFollow"];
  // True only while choices are genuinely still closed with no result yet
  // (LOCKED/LIVE) — not "anything that isn't open." A resolved pool
  // (settled, voided, ready for review, an anomaly notice, ...) has its own
  // accurate copy from PoolStatusNotice below; this line would otherwise
  // wrongly say "Choices Locked" on a pool that's long since settled.
  isLocked: boolean;
  // True for any resolved/terminal state — hides this line entirely rather
  // than showing a stale/misleading "Choices Locked" or countdown.
  isResolved: boolean;
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function countdown(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "Locked";
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `Locks in ${hours}h ${remainder}m` : `Locks in ${remainder}m`;
}

// Every pool is admin-created, so a creator identity (who posted it) isn't
// meaningful the way it would be for user-generated content — every pool
// has the same "author". The league/competition is what actually
// distinguishes one pool from another, so that's the header's identity
// instead. CUSTOM pools have no fixture/competition at all (see
// lib/pools/fetch.ts's synthesized fixture stand-in), hence the fallback
// label. No-logo fallback matches MatchIdentity's own TeamBadge — a plain
// circle, not initials (leagues don't have natural initials the way
// people's names do). COMBO pools get the brand mark instead of that grey
// placeholder — a combo spans multiple legs/fixtures, so there's never a
// single competition logo to show, but "no logo at all" reads as broken
// rather than intentional.
export function PoolLeagueHeader({
  competitionName,
  competitionCountry,
  competitionLogoUrl,
  poolType,
  visibility,
  createdAt,
  locksAt,
  isLocked,
  isResolved,
  leagueFollow = null,
}: PoolLeagueHeaderProps) {
  // relativeTime()/countdown() below are pure reads of Date.now() — with
  // nothing else ticking this component's re-render (no interval anywhere
  // upstream), the very first render's text would otherwise freeze in the
  // DOM for as long as the card stays mounted, showing an increasingly
  // stale "Posted Xm ago"/"Locks in Xm" the longer the tab sits open. 30s
  // matches the minute-level display granularity without over-rendering.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const label = competitionName
    ? competitionCountry
      ? `${competitionCountry} | ${competitionName}`
      : competitionName
    : poolType === "COMBO"
      ? "Combo"
      : "Custom Poll";

  return (
    <div className="flex items-start gap-3">
      {poolType === "COMBO" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/logo-combo.svg" alt="" className="size-8 rounded-full object-contain" />
      ) : competitionLogoUrl ? (
        // External provider logos (arbitrary CDN domains) — plain <img>
        // rather than next/image, same reasoning as MatchIdentity's team
        // badges (no remote-domain whitelist to maintain per provider).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={competitionLogoUrl} alt="" className="size-8 rounded-full object-contain" />
      ) : (
        <span className="size-8 rounded-full bg-surface-elevated" aria-hidden="true" />
      )}
      <div className="flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-text-primary">{label}</p>
          <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] font-medium text-text-muted">
            {visibility === "HIDDEN" ? "Private" : "Public"}
          </span>
          {leagueFollow && (
            <LeagueFollowToggle
              leagueId={leagueFollow.id}
              leagueName={competitionName ?? label}
              initiallyFollowing={leagueFollow.following}
            />
          )}
        </div>
        <p className="text-xs text-text-muted">Posted {relativeTime(createdAt)}</p>
        {!isResolved && (
          <p className="text-xs font-medium text-accent-primary-label">
            {isLocked ? "Choices Locked" : countdown(locksAt)}
          </p>
        )}
      </div>
    </div>
  );
}
