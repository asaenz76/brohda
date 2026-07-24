/**
 * Same race lib/pools/card-state.ts's deriveCardState already corrects for
 * on the card itself: the lock cron only runs once a minute (and not at
 * all outside Vercel Cron), so a pool past its locks_at can sit with
 * pools.status still 'OPEN' in the DB until that job catches up. Feed
 * fetches by DB status 'OPEN' but must still exclude these via this
 * function, or a pool past its lock time would show as open a moment
 * longer than it should.
 */
export function effectivePoolStatus(row: { status: string; locksAt: string }): string {
  if (row.status === "OPEN" && Date.now() >= new Date(row.locksAt).getTime()) {
    return "LOCKED";
  }
  return row.status;
}
