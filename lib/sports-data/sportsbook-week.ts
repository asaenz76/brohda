// Real-production incident (Milestone R13.10, Stage 4C): `ingest-nfl-markets`
// fetched fresh odds for every not-yet-started fixture in the ENTIRE
// season (up to ~226 fixtures, months out) on every 15-minute tick — 226 x
// 96 runs/day ≈ 21,700 real provider requests/day, ~3x the API-NFL PRO
// plan's entire 7,500/day limit, exhausting it before 8am UTC for at least
// three consecutive days. This is the fix's shared foundation, meant to
// generalize across sports (not an NFL-only concept): a "sportsbook week"
// runs Monday 00:00 through the following Monday 00:00 (exclusive), in a
// given IANA time zone — the same convention real sportsbooks use to
// group a week's slate. Bounding ingestion to "this week only" turns an
// unbounded, ever-growing candidate set into a small, constant one
// (~14-16 NFL games), regardless of how far into the season real fixture
// rows already exist.
//
// No date library in this codebase (confirmed: no date-fns/luxon/dayjs/
// moment in package.json) — timezone-correct wall-clock math is done here
// with only Intl.DateTimeFormat + Date arithmetic, matching this
// directory's own established convention (lib/sports-data/timezone.ts).

export interface SportsbookWeekBounds {
  /** Monday 00:00:00.000 in `timeZone`, as a UTC ISO instant. Inclusive. */
  weekStartUtc: string;
  /** The FOLLOWING Monday 00:00:00.000 in `timeZone`, as a UTC ISO instant. Exclusive — a fixture query should use `< weekEndUtc`, never `<=`. */
  weekEndUtc: string;
}

/**
 * Resolves the wall-clock year/month/day/weekday `instant` reads as inside
 * `timeZone`. `weekday` is 1 (Monday) through 7 (Sunday) — ISO-8601
 * numbering, chosen so "days back to Monday" is a plain `weekday - 1`.
 */
function getZonedDateParts(instant: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const weekdayIso: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayIso[parts.weekday as string],
  };
}

/**
 * The UTC instant corresponding to a specific wall-clock date/time inside
 * `timeZone` (e.g. "2026-09-28 00:00:00 in America/New_York"). Correct
 * across a DST transition: guesses assuming the wall clock IS UTC, then
 * measures how far that guess actually renders in `timeZone` and corrects
 * for the difference — the standard technique for this without a date
 * library, since `Date` itself has no "construct from zoned wall time"
 * constructor.
 */
function zonedWallTimeToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guessUtcMs)).map((p) => [p.type, p.value]));
  // Intl renders midnight as "24" under hour12:false in some engines —
  // normalize back to 0 so the arithmetic below stays on the same day.
  const renderedHour = parts.hour === "24" ? 0 : Number(parts.hour);
  const renderedAsIfUtcMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), renderedHour, Number(parts.minute), Number(parts.second), 0);
  const driftMs = renderedAsIfUtcMs - guessUtcMs;
  return new Date(guessUtcMs - driftMs);
}

/**
 * The current sportsbook week's bounds — Monday 00:00 through the
 * following Monday 00:00 (exclusive), in `timeZone`. Defaults to
 * `America/New_York`: the NFL's own home time zone and the real-world
 * sportsbook-industry convention for this sport; pass a different zone for
 * a future sport whose own convention differs.
 */
export function getCurrentSportsbookWeek(now: Date = new Date(), timeZone = "America/New_York"): SportsbookWeekBounds {
  const { year, month, day, weekday } = getZonedDateParts(now, timeZone);
  const daysSinceMonday = weekday - 1;

  const mondayThisWeekUtcMs = Date.UTC(year, month - 1, day - daysSinceMonday);
  const mondayThisWeek = new Date(mondayThisWeekUtcMs);
  const { year: y, month: m, day: d } = getZonedDateParts(mondayThisWeek, "UTC");

  const weekStart = zonedWallTimeToUtc(y, m, d, timeZone);
  const weekEnd = zonedWallTimeToUtc(y, m, d + 7, timeZone);

  return { weekStartUtc: weekStart.toISOString(), weekEndUtc: weekEnd.toISOString() };
}
