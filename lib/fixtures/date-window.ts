// Pure local-calendar-date <-> UTC boundary math for the date-first
// fixture discovery workflow (see app/(admin)/admin/fixtures, mode=date).
// No provider/database access here — everything is a plain function of
// (preset, timezone, now) so the timezone-correctness rules ("Today is
// exactly one Costa Rica calendar date", "a fixture near midnight UTC
// lands on the right local date") are fully unit-testable without a
// server or network call. Built on the same zonedTimeToUtc/
// getZonedYearMonthDay primitives lib/analytics/date-ranges.ts already
// uses for calendar-boundary math — not duplicated, imported directly.
import { getZonedYearMonthDay, normalizeIanaTimezone, zonedTimeToUtc } from "@/lib/analytics/timezone";

export const DEFAULT_FIXTURES_TIMEZONE = "America/Costa_Rica";
export const MAX_CUSTOM_RANGE_DAYS = 31;

export type DateRangePreset = "today" | "tomorrow" | "today_tomorrow" | "next_3_days" | "next_7_days" | "custom";

export const DATE_RANGE_PRESET_LABEL: Record<DateRangePreset, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  today_tomorrow: "Today + Tomorrow",
  next_3_days: "Next 3 days",
  next_7_days: "Next 7 days",
  custom: "Custom range",
};

export const DEFAULT_DATE_RANGE_PRESET: DateRangePreset = "today_tomorrow";

// Accepts both the descriptive preset slug and the shorthand "Nd" form
// used in quick-link URLs (see the Competition Workspace's "Browse
// upcoming fixtures" action and spec §10/§11's own examples, e.g.
// `range=7d`) — never throws, falls back to the default preset for
// anything unrecognized so a malformed URL degrades to a sane view
// instead of a broken one.
const RANGE_PARAM_ALIASES: Record<string, DateRangePreset> = {
  today: "today",
  tomorrow: "tomorrow",
  today_tomorrow: "today_tomorrow",
  "2d": "today_tomorrow",
  next_3_days: "next_3_days",
  "3d": "next_3_days",
  next_7_days: "next_7_days",
  "7d": "next_7_days",
  custom: "custom",
};

export function parseDateRangeParam(range: string | undefined | null): DateRangePreset {
  if (!range) return DEFAULT_DATE_RANGE_PRESET;
  return RANGE_PARAM_ALIASES[range] ?? DEFAULT_DATE_RANGE_PRESET;
}

export interface FixtureDateWindow {
  preset: DateRangePreset;
  timeZone: string;
  /** Inclusive, YYYY-MM-DD, in `timeZone`. */
  localFromDate: string;
  /** Inclusive, YYYY-MM-DD, in `timeZone`. */
  localToDate: string;
  /** Inclusive UTC instant (ISO) — the real, exact window start. */
  utcWindowStart: string;
  /** Exclusive UTC instant (ISO) — the real, exact window end. */
  utcWindowEnd: string;
  /** Every UTC calendar date (YYYY-MM-DD) that overlaps the window at
   * all — what the provider actually gets queried for, one `date=`
   * request per entry (see lib/fixtures/discovery.ts). Always a superset
   * of the true local window; results are trimmed back down to
   * [utcWindowStart, utcWindowEnd) after merging. */
  utcQueryDates: string[];
}

export interface DateWindowError {
  error: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

interface YearMonthDay {
  year: number;
  month: number;
  day: number;
}

// Adding N*86_400_000ms to a zone's local-midnight UTC instant and then
// re-deriving the local Y/M/D lands on the correct calendar date even
// across a month/year boundary or a DST transition day (which is at most
// 23h or 25h long, never enough to miss or double a calendar day here
// since we always start from a local midnight instant).
function addLocalDays(base: YearMonthDay, deltaDays: number, timeZone: string): YearMonthDay {
  const instant = zonedTimeToUtc(base.year, base.month, base.day, 0, 0, 0, timeZone);
  const shifted = new Date(instant.getTime() + deltaDays * 86_400_000);
  return getZonedYearMonthDay(shifted, timeZone);
}

const CUSTOM_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCustomDate(value: string): YearMonthDay | null {
  const match = CUSTOM_DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Reject calendar-impossible dates (e.g. 2026-02-30) — construct in UTC
  // and check it round-trips, cheaper and just as reliable as a full
  // calendar library for this narrow validation.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * Resolves a date-range preset (or validated custom range) into an exact
 * UTC window, in the given IANA timezone (America/Costa_Rica by
 * default — this deployment's configured admin timezone, never the
 * browser's). Returns a validation error instead of a window for any
 * unsupported preset, malformed/inverted/oversized custom range, or
 * unrecognized timezone — callers must never fall through to a provider
 * request on an error result.
 */
export function resolveFixtureDateWindow(
  preset: DateRangePreset,
  options: { timeZone?: string; now?: Date; customFromDate?: string; customToDate?: string } = {},
): FixtureDateWindow | DateWindowError {
  const timeZone = options.timeZone ? normalizeIanaTimezone(options.timeZone) : DEFAULT_FIXTURES_TIMEZONE;
  if (!timeZone) return { error: `"${options.timeZone}" is not a recognized timezone.` };

  const now = options.now ?? new Date();
  const today = getZonedYearMonthDay(now, timeZone);

  let localFrom: YearMonthDay = today;
  let localTo: YearMonthDay = today;

  switch (preset) {
    case "today":
      break;
    case "tomorrow": {
      const tomorrow = addLocalDays(today, 1, timeZone);
      localFrom = tomorrow;
      localTo = tomorrow;
      break;
    }
    case "today_tomorrow":
      localTo = addLocalDays(today, 1, timeZone);
      break;
    case "next_3_days":
      localTo = addLocalDays(today, 2, timeZone);
      break;
    case "next_7_days":
      localTo = addLocalDays(today, 6, timeZone);
      break;
    case "custom": {
      if (!options.customFromDate || !options.customToDate) {
        return { error: "A custom range requires both a start and an end date." };
      }
      const from = parseCustomDate(options.customFromDate);
      const to = parseCustomDate(options.customToDate);
      if (!from || !to) return { error: "Dates must be valid calendar dates in YYYY-MM-DD format." };
      localFrom = from;
      localTo = to;
      const fromInstant = zonedTimeToUtc(from.year, from.month, from.day, 0, 0, 0, timeZone);
      const toInstant = zonedTimeToUtc(to.year, to.month, to.day, 0, 0, 0, timeZone);
      if (toInstant.getTime() < fromInstant.getTime()) {
        return { error: "The end date must be on or after the start date." };
      }
      const spanDays = Math.round((toInstant.getTime() - fromInstant.getTime()) / 86_400_000) + 1;
      if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
        return { error: `Date ranges are limited to ${MAX_CUSTOM_RANGE_DAYS} days — narrow the range and try again.` };
      }
      break;
    }
    default:
      return { error: `Unsupported date range preset: ${preset}` };
  }

  const utcWindowStartDate = zonedTimeToUtc(localFrom.year, localFrom.month, localFrom.day, 0, 0, 0, timeZone);
  const dayAfterTo = addLocalDays(localTo, 1, timeZone);
  const utcWindowEndDate = zonedTimeToUtc(dayAfterTo.year, dayAfterTo.month, dayAfterTo.day, 0, 0, 0, timeZone);

  const utcQueryDates: string[] = [];
  const lastIncludedInstant = new Date(utcWindowEndDate.getTime() - 1);
  let cursor = Date.UTC(utcWindowStartDate.getUTCFullYear(), utcWindowStartDate.getUTCMonth(), utcWindowStartDate.getUTCDate());
  const lastUtcDay = Date.UTC(lastIncludedInstant.getUTCFullYear(), lastIncludedInstant.getUTCMonth(), lastIncludedInstant.getUTCDate());
  while (cursor <= lastUtcDay) {
    const d = new Date(cursor);
    utcQueryDates.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    cursor += 86_400_000;
  }

  return {
    preset,
    timeZone,
    localFromDate: formatLocalDate(localFrom.year, localFrom.month, localFrom.day),
    localToDate: formatLocalDate(localTo.year, localTo.month, localTo.day),
    utcWindowStart: utcWindowStartDate.toISOString(),
    utcWindowEnd: utcWindowEndDate.toISOString(),
    utcQueryDates,
  };
}

export function isDateWindowError(result: FixtureDateWindow | DateWindowError): result is DateWindowError {
  return "error" in result;
}

/** Whether a fixture's scheduled UTC instant falls inside the exact
 * (not merely date-overlapping) window — the trim step after merging
 * every per-UTC-date provider response. */
export function isWithinDateWindow(scheduledStartUtc: string, window: FixtureDateWindow): boolean {
  const t = new Date(scheduledStartUtc).getTime();
  return t >= new Date(window.utcWindowStart).getTime() && t < new Date(window.utcWindowEnd).getTime();
}

/** The local (Costa Rica, or whatever `timeZone` is) calendar date a
 * fixture's kickoff falls on — the grouping key for display, distinct
 * from whichever UTC date the provider indexed it under. */
export function localDateKeyFor(scheduledStartUtc: string, timeZone: string): string {
  const { year, month, day } = getZonedYearMonthDay(new Date(scheduledStartUtc), timeZone);
  return formatLocalDate(year, month, day);
}
