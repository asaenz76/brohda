// Milestone R5 (docs/BROHDA_2_0_MILESTONE_MAP.md, Pick Editing + Locking).
// The Pick-cutoff calculation, centralized (§35: "do not duplicate the
// cutoff value in frontend code"). Pure — no I/O, no `new Date()` inline —
// so any future countdown/presentation surface computes the exact same
// instant this domain already uses, without re-deriving the formula.
//
// This is presentation/display-support ONLY. The authoritative enforcement
// of this same formula lives inside the `set_pick` SQL function itself
// (supabase/migrations/20260101000152_pick_editing_and_locking.sql),
// re-read fresh on every call — nothing computed here is ever trusted as
// the actual eligibility decision (§11, §28).

/** The instant ordinary Pick creation/editing stops for a Game with the given canonical kickoff. */
export function computeEffectiveLockAt(scheduledStartUtc: string, lockMinutesBeforeKickoff: number): Date {
  return new Date(new Date(scheduledStartUtc).getTime() - lockMinutesBeforeKickoff * 60_000);
}

/**
 * Whether new predictions on a Game are closed as of `now`: the same two conditions the database enforces — the Game is no longer NOT_STARTED, or the effective lock (kickoff minus the configured lock minutes) has passed.
 * Used only to decide what may be SHOWN (aggregate sentiment can no longer influence a new prediction once this is true); the write path decides on its own, inside the database.
 */
export function arePredictionsClosed(game: { internalStatus: string; scheduledStartUtc: string }, lockMinutesBeforeKickoff: number, now: Date): boolean {
  return game.internalStatus !== "NOT_STARTED" || isPastEffectiveLock(game.scheduledStartUtc, lockMinutesBeforeKickoff, now);
}

/**
 * What the Pick controls should show for a Game as of `now`: closed once the Game is no longer NOT_STARTED OR the effective lock (kickoff minus the configured minutes) has passed — the same two conditions the database enforces. A Game that is still open also
 * says WHEN it locks, so a page that stays open on a phone can close its own controls at that instant instead of waiting for someone to tap and be refused. The status alone is not enough: the provider only reports a Game as live after it has started.
 */
export function pickLockState(game: { internalStatus: string; scheduledStartUtc: string }, lockMinutesBeforeKickoff: number, now: Date): { closed: boolean; lockAt: string | null } {
  if (arePredictionsClosed(game, lockMinutesBeforeKickoff, now)) return { closed: true, lockAt: null };
  return { closed: false, lockAt: computeEffectiveLockAt(game.scheduledStartUtc, lockMinutesBeforeKickoff).toISOString() };
}

/** Whether, as of `now`, ordinary Pick creation/editing has stopped for a Game with the given canonical kickoff. */
export function isPastEffectiveLock(scheduledStartUtc: string, lockMinutesBeforeKickoff: number, now: Date): boolean {
  return now.getTime() >= computeEffectiveLockAt(scheduledStartUtc, lockMinutesBeforeKickoff).getTime();
}
