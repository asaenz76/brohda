import type { FixtureInternalStatus } from "@/lib/sports-data/types";

export type PoolStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "OPEN"
  | "LOCKED"
  | "AWAITING_RESULT"
  | "READY_FOR_REVIEW"
  | "SETTLED"
  | "VOIDED"
  | "CANCELLED"
  | "SETTLEMENT_REVERSED"
  | "REVERSAL_FAILED_MANUAL_REVIEW"
  | "MANUAL_REVIEW";

export type CardState =
  | "OPEN_PRE_VOTE"
  | "OPEN_POST_VOTE"
  | "LOCKED"
  | "LIVE"
  | "READY_FOR_REVIEW"
  | "SETTLED_WON"
  | "SETTLED_LOST"
  | "VOIDED"
  | "POSTPONED_NOTICE"
  | "CANCELLED_NOTICE"
  | "SUSPENDED_NOTICE";

export type EntryStatusForCard = "ACTIVE" | "WON" | "LOST" | "VOID" | "REFUNDED" | null;

export type PoolVisibility = "VISIBLE_TO_ALL_MEMBERS" | "HIDDEN";

const LIVE_FIXTURE_STATUSES: readonly FixtureInternalStatus[] = [
  "LIVE",
  "HALFTIME",
  "EXTRA_TIME",
  "PENALTIES",
];

/**
 * card_state = f(pool.status, fixture.internal_status, current user's entry)
 * — spec §21/X.5.1. Derived only, never persisted; LIVE is not a pool
 * status. Implemented completely (including branches unreachable before
 * Phase 5 settlement/reversal) since spec wants this written once.
 */
export function deriveCardState(
  pool: { status: PoolStatus; locksAt?: string },
  fixture: { internalStatus: FixtureInternalStatus },
  entryStatus: EntryStatusForCard,
): CardState {
  const hasActiveEntry = entryStatus === "ACTIVE" || entryStatus === "WON" || entryStatus === "LOST";
  const isLiveFixture = LIVE_FIXTURE_STATUSES.includes(fixture.internalStatus);

  switch (pool.status) {
    case "DRAFT":
    case "SCHEDULED":
      // Not reachable via RLS (DRAFT) or not produced by Phase 4's publish
      // flow (SCHEDULED) — closest available bucket if it ever occurs.
      return "OPEN_PRE_VOTE";

    case "OPEN":
      // The lock cron only runs once a minute (and not at all outside
      // Vercel Cron) — without this, a pool past its lock time still reads
      // as open/enterable client-side until that job catches up, even
      // though create_pool_entry's own now() >= locks_at check already
      // rejects the entry server-side. Treat it as locked the moment the
      // clock says so, regardless of what pools.status still says.
      if (pool.locksAt != null && Date.now() >= new Date(pool.locksAt).getTime()) {
        return "LOCKED";
      }
      return hasActiveEntry ? "OPEN_POST_VOTE" : "OPEN_PRE_VOTE";

    case "LOCKED":
    case "AWAITING_RESULT":
      // X.7.3: the system notice replaces interactive controls the moment
      // the provider reports an anomaly — before the same-calendar-day
      // grace window closes and the pool actually voids (that's the VOIDED
      // branch below). AWARDED/UNKNOWN fall through to LIVE/LOCKED, same as
      // the VOIDED branch's fallback for them.
      if (fixture.internalStatus === "POSTPONED") return "POSTPONED_NOTICE";
      if (fixture.internalStatus === "CANCELLED") return "CANCELLED_NOTICE";
      if (fixture.internalStatus === "SUSPENDED") return "SUSPENDED_NOTICE";
      if (fixture.internalStatus === "ABANDONED") return "CANCELLED_NOTICE";
      return isLiveFixture ? "LIVE" : "LOCKED";

    case "READY_FOR_REVIEW":
    case "SETTLEMENT_REVERSED":
    case "REVERSAL_FAILED_MANUAL_REVIEW":
    case "MANUAL_REVIEW":
      // Back under admin review either way, from a player's perspective —
      // MANUAL_REVIEW included: an integrity issue with the pool's own
      // data, not something a player's entry status distinguishes.
      return "READY_FOR_REVIEW";

    case "SETTLED":
      // No neutral "settled, didn't play" bucket exists in X.5.1 — a
      // non-participant reads as SETTLED_LOST; the view-model's separate
      // `hasEntered` flag lets downstream copy distinguish that case.
      return entryStatus === "WON" ? "SETTLED_WON" : "SETTLED_LOST";

    case "VOIDED":
      if (fixture.internalStatus === "POSTPONED") return "POSTPONED_NOTICE";
      if (fixture.internalStatus === "CANCELLED") return "CANCELLED_NOTICE";
      if (fixture.internalStatus === "SUSPENDED") return "SUSPENDED_NOTICE";
      if (fixture.internalStatus === "ABANDONED") return "CANCELLED_NOTICE";
      return "VOIDED";

    case "CANCELLED":
      return "CANCELLED_NOTICE";

    default:
      return "VOIDED";
  }
}
