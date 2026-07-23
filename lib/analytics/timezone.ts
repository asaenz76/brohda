export const DEFAULT_ANALYTICS_TIMEZONE = "America/Costa_Rica";

// Fixed-offset strings ("-06:00", "+05:30", "GMT-6", "UTC+6") are not IANA
// zones — they carry no DST rule, so a "-06:00" stored today would be
// silently wrong the day daylight saving starts/ends. Intl.DateTimeFormat
// happily accepts them unchanged (verified: `new Intl.DateTimeFormat("en-US",
// { timeZone: "-06:00" })` does not throw), so they must be rejected
// explicitly before ever reaching Intl.
const OFFSET_LIKE_PATTERN = /^[+-]\d{2}:?\d{2}$/;
const NAMED_OFFSET_PATTERN = /^(UTC|GMT)[+-]\d/i;

/**
 * Validates and canonicalizes a user-supplied IANA timezone identifier.
 *
 * - Rejects raw UTC offsets and named-offset strings (-06:00, GMT-6, UTC+6).
 * - Rejects free text that isn't a real zone (Intl throws on "Costa Rica").
 * - Rejects pure casing drift (america/costa_rica) — the caller must type
 *   the canonical form; this is a stricter bar than Intl applies on its
 *   own (Intl silently lowercases/uppercases to the canonical form).
 * - Accepts genuine IANA aliases/deprecated link names (e.g. a legacy zone
 *   name that differs from its modern target by more than case) and
 *   returns the canonical identifier Intl's resolver assigns to it —
 *   this is the "cannot reliably canonicalize a valid alias" case: we
 *   don't invent a mapping, we store whatever the platform resolver says.
 *
 * Returns null for anything invalid — callers must reject, not fall back
 * to a default silently.
 */
export function normalizeIanaTimezone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (OFFSET_LIKE_PATTERN.test(trimmed) || NAMED_OFFSET_PATTERN.test(trimmed)) return null;

  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    if (resolved.toLowerCase() === trimmed.toLowerCase() && resolved !== trimmed) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

export function isValidIanaTimezone(input: string): boolean {
  return normalizeIanaTimezone(input) !== null;
}

interface ZonedDateParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Reads the wall-clock date/time an absolute instant corresponds to in a
// given IANA zone — the building block for converting between "local
// calendar day" and "UTC instant" without a date library.
function getZonedDateParts(instant: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// The zone's offset from UTC (minutes, positive = ahead of UTC) at the
// given instant — derived by round-tripping through Intl rather than
// hardcoding offsets, so it's automatically correct across DST
// transitions for the specific instant being asked about.
function getTimezoneOffsetMinutes(instant: Date, timeZone: string): number {
  const zoned = getZonedDateParts(instant, timeZone);
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Converts a local wall-clock date/time in `timeZone` into the UTC
 * instant it represents — e.g. "2026-07-31 00:00:00 America/Costa_Rica"
 * -> the corresponding Date. Used for calendar-boundary math (start of
 * month/year in the user's zone), never for bucketing raw ledger rows
 * (that's done in SQL via `at time zone`, operating on the full table
 * rather than one instant at a time).
 *
 * Ambiguous/nonexistent local times (DST fall-back/spring-forward) are
 * resolved by construction: the offset is computed from a first-pass UTC
 * guess and applied once, which lands within the same DST segment for
 * all but the ~1-hour transition window itself — an acceptable, standard
 * trade-off for calendar-boundary math (month/year starts never fall
 * inside a transition window in practice).
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const naiveUtcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimezoneOffsetMinutes(naiveUtcGuess, timeZone);
  return new Date(naiveUtcGuess.getTime() - offsetMinutes * 60_000);
}

/** The {year, month, day} an instant corresponds to in `timeZone` — the calendar-boundary counterpart to zonedTimeToUtc. */
export function getZonedYearMonthDay(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const { year, month, day } = getZonedDateParts(instant, timeZone);
  return { year, month, day };
}

/** Full wall-clock parts (year through second) an instant corresponds to in `timeZone`. */
export function getZonedDateTimeParts(instant: Date, timeZone: string): ZonedDateParts {
  return getZonedDateParts(instant, timeZone);
}
