import type { FixtureInternalStatus } from "@/lib/sports-data/types";

export type PoolVoidReason =
  | "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY"
  | "MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY"
  | "MATCH_ABANDONED"
  | "MATCH_CANCELLED"
  | "MATCH_AWARDED"
  | "MATCH_STATUS_UNKNOWN"
  | "MINIMUM_ENTRIES_NOT_REACHED"
  | "NO_WINNING_ENTRIES"
  | "ALL_ENTRIES_WINNING"
  | "ADMIN_MANUAL_CANCEL"
  | "NO_WINNING_ENTRIES_FEE_RETAINED"
  | "COMBO_PLAYER_DID_NOT_PLAY";

// Spec §16.4: these statuses never enter normal settlement. X.7.1 names the
// first four explicitly; AWARDED/UNKNOWN are folded into the same automatic
// void machinery since neither implies a match that resolves through play.
const ANOMALY_STATUSES: readonly FixtureInternalStatus[] = [
  "POSTPONED",
  "SUSPENDED",
  "ABANDONED",
  "CANCELLED",
  "AWARDED",
  "UNKNOWN",
];

export function isAnomalyStatus(status: FixtureInternalStatus): boolean {
  return ANOMALY_STATUSES.includes(status);
}

// X.7.1 applies the same-calendar-day grace window to all four of its named
// statuses (even ABANDONED/CANCELLED, per its literal wording). AWARDED and
// UNKNOWN are not part of X.7.1 — they void immediately, since neither
// describes a match that might still resume.
const SAME_DAY_WAIT_STATUSES: readonly FixtureInternalStatus[] = [
  "POSTPONED",
  "SUSPENDED",
  "ABANDONED",
  "CANCELLED",
];

export function requiresSameDayWait(status: FixtureInternalStatus): boolean {
  return SAME_DAY_WAIT_STATUSES.includes(status);
}

export function mapAnomalyToVoidReason(status: FixtureInternalStatus): PoolVoidReason {
  switch (status) {
    case "POSTPONED":
      return "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY";
    case "SUSPENDED":
      return "MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY";
    case "ABANDONED":
      return "MATCH_ABANDONED";
    case "CANCELLED":
      return "MATCH_CANCELLED";
    case "AWARDED":
      return "MATCH_AWARDED";
    case "UNKNOWN":
      return "MATCH_STATUS_UNKNOWN";
    default:
      throw new Error(`${status} is not an anomaly status`);
  }
}

function calendarDateInTimezone(date: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD, which is directly string-comparable.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * X.7.2: "same calendar day" means the local calendar date of the match
 * venue (falls back through competition timezone to DEFAULT_TIMEZONE before
 * this function is ever called — see lib/sports-data/timezone.ts). Returns
 * true once the current date, in that timezone, is later than the match's
 * scheduled date — i.e. the grace window has closed without completion.
 */
export function hasCalendarDayEnded(
  scheduledStartUtc: string,
  timezone: string,
  now: Date = new Date(),
): boolean {
  const matchDay = calendarDateInTimezone(new Date(scheduledStartUtc), timezone);
  const currentDay = calendarDateInTimezone(now, timezone);
  return currentDay > matchDay;
}
