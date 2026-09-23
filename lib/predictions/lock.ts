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

/** Whether, as of `now`, ordinary Pick creation/editing has stopped for a Game with the given canonical kickoff. */
export function isPastEffectiveLock(scheduledStartUtc: string, lockMinutesBeforeKickoff: number, now: Date): boolean {
  return now.getTime() >= computeEffectiveLockAt(scheduledStartUtc, lockMinutesBeforeKickoff).getTime();
}
