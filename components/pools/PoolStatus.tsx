import type { CardState } from "@/lib/pools/card-state";
import { cn } from "@/lib/utils";

// A true status primitive — this pill means exactly one thing: the pool's
// current categorical state (spec's card_state, X.5.1). Everything else
// that used to live here (visibility, posted time, "You're in", the lock
// countdown) has its own home now: visibility/posted-time moved to Pool
// Details (the detail-page-only metadata line), entered/pot/countdown
// moved to PoolSummary. Keeping this component single-purpose is
// deliberate — it's the one piece of card UI every future state (Phase D)
// and every future surface reuses, so scope creep here would spread
// everywhere.
const STATUS_LABEL: Record<CardState, string> = {
  OPEN_PRE_VOTE: "Open",
  OPEN_POST_VOTE: "Open",
  LOCKED: "Locked",
  LIVE: "Live",
  READY_FOR_REVIEW: "Under Review",
  SETTLED_WON: "Final",
  SETTLED_LOST: "Final",
  VOIDED: "Voided",
  POSTPONED_NOTICE: "Postponed",
  CANCELLED_NOTICE: "Cancelled",
  SUSPENDED_NOTICE: "Suspended",
};

// Semantic-only coloring, no new tokens: LIVE reuses the same pool-live
// amber + pulse dot convention LiveMatchStatus already established;
// everything else is a quiet neutral pill — win/loss outcome itself is
// communicated by PoolResult/PoolStatusNotice below, not by this badge, so
// SETTLED_WON and SETTLED_LOST intentionally look identical here ("Final").
function toneClasses(status: CardState): string {
  if (status === "LIVE") return "bg-pool-live/10 text-pool-live";
  if (status === "READY_FOR_REVIEW") return "bg-warning-muted/10 text-warning-muted";
  if (status === "OPEN_PRE_VOTE" || status === "OPEN_POST_VOTE") return "bg-accent-primary-subtle text-accent-primary-label";
  return "bg-surface-secondary text-text-muted";
}

export function PoolStatus({ status }: { status: CardState }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        toneClasses(status),
      )}
    >
      {STATUS_LABEL[status]}
      {/* Small status dot, matching the mockup's pill treatment —
          bg-current so every tone above gets a correctly-colored dot for
          free, no per-status color duplication. LIVE keeps its own pulse
          (the one status where "still changing right now" is real). */}
      <span
        className={cn("size-1.5 shrink-0 rounded-full bg-current", status === "LIVE" && "animate-pulse")}
        aria-hidden="true"
      />
    </span>
  );
}
