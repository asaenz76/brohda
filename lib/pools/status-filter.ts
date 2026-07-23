import type { PoolStatus } from "./card-state";

/**
 * The curated subset of pool_status Feed lets a player filter by —
 * deliberately excludes admin-internal statuses (DRAFT, SCHEDULED,
 * READY_FOR_REVIEW, SETTLEMENT_REVERSED, REVERSAL_FAILED_MANUAL_REVIEW)
 * a player has no reason to filter by. "All" means every status in this
 * list, not literally every PoolStatus.
 */
export const FEED_STATUS_OPTIONS: readonly PoolStatus[] = [
  "OPEN",
  "LOCKED",
  "AWAITING_RESULT",
  "CANCELLED",
  "VOIDED",
  "SETTLED",
];

export function isFeedStatus(value: string): value is PoolStatus {
  return (FEED_STATUS_OPTIONS as readonly string[]).includes(value);
}

/**
 * Same race lib/pools/card-state.ts's deriveCardState already corrects for
 * on the card itself: the lock cron only runs once a minute (and not at
 * all outside Vercel Cron), so a pool past its locks_at can sit with
 * pools.status still 'OPEN' in the DB until that job catches up. A status
 * filter driven by the raw DB column alone would let such a pool show
 * under "Open" even though it's no longer available to bet on.
 */
export function effectivePoolStatus(row: { status: string; locksAt: string }): string {
  if (row.status === "OPEN" && Date.now() >= new Date(row.locksAt).getTime()) {
    return "LOCKED";
  }
  return row.status;
}
