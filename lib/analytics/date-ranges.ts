import type { DateRangePreset } from "./types";
import { getZonedDateTimeParts, getZonedYearMonthDay, zonedTimeToUtc } from "./timezone";

// Rolling-window presets (7D/30D/90D/CUSTOM/ALL_TIME) are pure durations —
// "the last 7 days" is the same absolute span regardless of timezone, so
// they need no zone awareness. Only THIS_MONTH/YTD have calendar semantics
// ("the start of this month") that depend on which zone's calendar you're
// asking about — those two use `timeZone` to compute the boundary as the
// user's local midnight, not UTC midnight (a Jul 31 23:58 America/Costa_Rica
// entry must land in July, not silently roll into August because the
// boundary was computed in UTC).
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  from: Date;
  to: Date;
}

// Far enough back to predate any real platform data — used as ALL_TIME's
// concrete lower bound so every consumer (including the monthly-activity
// RPC, which requires non-null bounds) can treat every preset uniformly
// as a concrete {from, to} pair rather than special-casing "no lower bound."
const ALL_TIME_START = new Date("2000-01-01T00:00:00.000Z");

export function resolveDateRange(
  preset: DateRangePreset,
  timeZone: string,
  custom?: { from: Date; to: Date },
): DateRange {
  const now = new Date();

  switch (preset) {
    case "7D":
      return { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
    case "30D":
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
    case "90D":
      return { from: new Date(now.getTime() - 90 * DAY_MS), to: now };
    case "THIS_MONTH": {
      const { year, month } = getZonedYearMonthDay(now, timeZone);
      return { from: zonedTimeToUtc(year, month, 1, 0, 0, 0, timeZone), to: now };
    }
    case "YTD": {
      const { year } = getZonedYearMonthDay(now, timeZone);
      return { from: zonedTimeToUtc(year, 1, 1, 0, 0, 0, timeZone), to: now };
    }
    case "ALL_TIME":
      return { from: ALL_TIME_START, to: now };
    case "CUSTOM":
      if (!custom) throw new Error("resolveDateRange: CUSTOM preset requires a custom range");
      return { from: custom.from, to: custom.to };
  }
}

// Equivalent preceding range for a "vs. previous period" comparison
// (spec: selected Jul 1–30 -> comparison Jun 1–30). Calendar-aware for
// the two calendar-boundary presets (THIS_MONTH/YTD — shift by whole
// months/years in the user's zone, not a raw millisecond duration, so
// "this month" always compares against the immediately preceding full
// calendar month in that zone); every other preset (including CUSTOM)
// shifts back by the exact duration of the selected range with no
// overlap. ALL_TIME has no meaningful "previous" — returns null, and
// callers should omit the comparison.
export function previousPeriod(range: DateRange, preset: DateRangePreset, timeZone: string): DateRange | null {
  if (preset === "ALL_TIME") return null;

  if (preset === "THIS_MONTH") {
    const { year, month } = getZonedYearMonthDay(range.from, timeZone);
    const prevMonthStart = zonedTimeToUtc(year, month - 1, 1, 0, 0, 0, timeZone);
    return { from: prevMonthStart, to: range.from };
  }

  if (preset === "YTD") {
    const { year: fromYear } = getZonedYearMonthDay(range.from, timeZone);
    const prevYearStart = zonedTimeToUtc(fromYear - 1, 1, 1, 0, 0, 0, timeZone);
    const to = getZonedDateTimeParts(range.to, timeZone);
    const prevYearEquivalentEnd = zonedTimeToUtc(to.year - 1, to.month, to.day, to.hour, to.minute, to.second, timeZone);
    return { from: prevYearStart, to: prevYearEquivalentEnd };
  }

  const durationMs = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - durationMs), to: range.from };
}
