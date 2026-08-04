import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATE_RANGE_PRESET,
  isDateWindowError,
  isWithinDateWindow,
  localDateKeyFor,
  MAX_CUSTOM_RANGE_DAYS,
  parseDateRangeParam,
  resolveFixtureDateWindow,
  type FixtureDateWindow,
} from "@/lib/fixtures/date-window";

const TZ = "America/Costa_Rica"; // UTC-6, no DST

function assertWindow(result: ReturnType<typeof resolveFixtureDateWindow>): FixtureDateWindow {
  if (isDateWindowError(result)) throw new Error(`expected a window, got error: ${result.error}`);
  return result;
}

describe("resolveFixtureDateWindow — Costa Rica boundary correctness", () => {
  it("Today includes exactly one Costa Rica calendar date", () => {
    const now = new Date("2026-08-04T18:00:00.000Z"); // noon in Costa Rica (UTC-6)
    const window = assertWindow(resolveFixtureDateWindow("today", { timeZone: TZ, now }));
    expect(window.localFromDate).toBe("2026-08-04");
    expect(window.localToDate).toBe("2026-08-04");
    // Costa Rica midnight Aug 4 -> 06:00 UTC; midnight Aug 5 -> 06:00 UTC next day.
    expect(window.utcWindowStart).toBe("2026-08-04T06:00:00.000Z");
    expect(window.utcWindowEnd).toBe("2026-08-05T06:00:00.000Z");
  });

  it("Today + Tomorrow includes exactly two Costa Rica calendar dates", () => {
    const now = new Date("2026-08-04T18:00:00.000Z");
    const window = assertWindow(resolveFixtureDateWindow("today_tomorrow", { timeZone: TZ, now }));
    expect(window.localFromDate).toBe("2026-08-04");
    expect(window.localToDate).toBe("2026-08-05");
    expect(window.utcWindowStart).toBe("2026-08-04T06:00:00.000Z");
    expect(window.utcWindowEnd).toBe("2026-08-06T06:00:00.000Z");
  });

  it("Tomorrow resolves to exactly the next Costa Rica calendar date, not today", () => {
    const now = new Date("2026-08-04T18:00:00.000Z");
    const window = assertWindow(resolveFixtureDateWindow("tomorrow", { timeZone: TZ, now }));
    expect(window.localFromDate).toBe("2026-08-05");
    expect(window.localToDate).toBe("2026-08-05");
  });

  it("Next 3 days spans exactly 3 local calendar dates starting today", () => {
    const now = new Date("2026-08-04T18:00:00.000Z");
    const window = assertWindow(resolveFixtureDateWindow("next_3_days", { timeZone: TZ, now }));
    expect(window.localFromDate).toBe("2026-08-04");
    expect(window.localToDate).toBe("2026-08-06");
  });

  it("Next 7 days spans exactly 7 local calendar dates starting today", () => {
    const now = new Date("2026-08-04T18:00:00.000Z");
    const window = assertWindow(resolveFixtureDateWindow("next_7_days", { timeZone: TZ, now }));
    expect(window.localFromDate).toBe("2026-08-04");
    expect(window.localToDate).toBe("2026-08-10");
  });

  it("a fixture near midnight UTC appears under the correct Costa Rica calendar date, not the UTC date", () => {
    // 2026-08-05T03:00:00Z is still 2026-08-04 21:00 in Costa Rica (UTC-6) —
    // the exact "near midnight UTC" case the spec calls out by name.
    const nearMidnightUtc = "2026-08-05T03:00:00.000Z";
    expect(localDateKeyFor(nearMidnightUtc, TZ)).toBe("2026-08-04");

    const now = new Date("2026-08-04T18:00:00.000Z");
    const todayWindow = assertWindow(resolveFixtureDateWindow("today", { timeZone: TZ, now }));
    expect(isWithinDateWindow(nearMidnightUtc, todayWindow)).toBe(true);

    // and NOT under the (wrong) UTC-date reading of "tomorrow"
    const tomorrowWindow = assertWindow(resolveFixtureDateWindow("tomorrow", { timeZone: TZ, now }));
    expect(isWithinDateWindow(nearMidnightUtc, tomorrowWindow)).toBe(false);
  });

  it("computes the UTC query dates needed to cover the whole local window, including any UTC-side spillover", () => {
    const now = new Date("2026-08-04T18:00:00.000Z");
    const window = assertWindow(resolveFixtureDateWindow("today", { timeZone: TZ, now }));
    // Costa Rica's single local day 08-04 spans UTC instants from
    // 08-04T06:00Z through 08-05T05:59:59.999Z — i.e. two UTC calendar
    // dates must be queried to catch every fixture.
    expect(window.utcQueryDates).toEqual(["2026-08-04", "2026-08-05"]);
  });
});

describe("resolveFixtureDateWindow — custom range validation", () => {
  it("accepts a valid custom range", () => {
    const window = assertWindow(
      resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-08-04", customToDate: "2026-08-06" }),
    );
    expect(window.localFromDate).toBe("2026-08-04");
    expect(window.localToDate).toBe("2026-08-06");
  });

  it("rejects a missing from/to date", () => {
    const result = resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-08-04" });
    expect(isDateWindowError(result)).toBe(true);
  });

  it("rejects a malformed date string", () => {
    const result = resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "not-a-date", customToDate: "2026-08-06" });
    expect(isDateWindowError(result)).toBe(true);
  });

  it("rejects a calendar-impossible date (e.g. Feb 30)", () => {
    const result = resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-02-30", customToDate: "2026-03-01" });
    expect(isDateWindowError(result)).toBe(true);
  });

  it("rejects an inverted range (end before start)", () => {
    const result = resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-08-06", customToDate: "2026-08-04" });
    expect(isDateWindowError(result)).toBe(true);
  });

  it("enforces the maximum custom range", () => {
    const okResult = resolveFixtureDateWindow("custom", {
      timeZone: TZ,
      customFromDate: "2026-01-01",
      customToDate: `2026-01-${String(MAX_CUSTOM_RANGE_DAYS).padStart(2, "0")}`, // exactly MAX_CUSTOM_RANGE_DAYS days
    });
    expect(isDateWindowError(okResult)).toBe(false);

    const tooLongResult = resolveFixtureDateWindow("custom", {
      timeZone: TZ,
      customFromDate: "2026-01-01",
      customToDate: `2026-01-${String(MAX_CUSTOM_RANGE_DAYS + 1).padStart(2, "0")}`,
    });
    expect(isDateWindowError(tooLongResult)).toBe(true);
  });

  it("August 1 through August 31 inclusive is exactly 31 calendar days and is accepted, never silently rejected", () => {
    const result = assertWindow(
      resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-08-01", customToDate: "2026-08-31" }),
    );
    expect(result.localFromDate).toBe("2026-08-01");
    expect(result.localToDate).toBe("2026-08-31");
    expect(result.utcQueryDates.length).toBeGreaterThanOrEqual(31); // may include a UTC buffer day past the local range
  });

  it("August 1 through September 1 inclusive is 32 calendar days and is rejected", () => {
    const result = resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-08-01", customToDate: "2026-09-01" });
    expect(isDateWindowError(result)).toBe(true);
  });

  it("a same-day range is exactly 1 calendar day and is accepted", () => {
    const result = assertWindow(
      resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-08-04", customToDate: "2026-08-04" }),
    );
    expect(result.localFromDate).toBe("2026-08-04");
    expect(result.localToDate).toBe("2026-08-04");
  });

  it("rejects an unrecognized timezone rather than silently falling back", () => {
    const result = resolveFixtureDateWindow("today", { timeZone: "Not/AZone" });
    expect(isDateWindowError(result)).toBe(true);
  });
});

describe("UTC buffer date is queried and correctly trimmed by local post-filtering", () => {
  it("a Costa Rica Aug 1-31 range queries the UTC Sep 1 buffer date, but a fixture actually on Sep 1 local is excluded after trimming", () => {
    const window = assertWindow(
      resolveFixtureDateWindow("custom", { timeZone: TZ, customFromDate: "2026-08-01", customToDate: "2026-08-31" }),
    );
    // Costa Rica is UTC-6 with no DST: local Aug 31 23:00 is Sep 1 05:00
    // UTC — the provider must be asked about UTC Sep 1 to avoid missing
    // that late-night fixture, even though Sep 1 isn't in the local range.
    expect(window.utcQueryDates).toContain("2026-09-01");

    // A fixture still within Aug 31 local time (23:00 CR = Sep 1 05:00 UTC) survives the trim.
    expect(isWithinDateWindow("2026-09-01T05:00:00.000Z", window)).toBe(true);
    // A fixture actually on Sep 1 local time (01:00 CR = Sep 1 07:00 UTC) is correctly excluded.
    expect(isWithinDateWindow("2026-09-01T07:00:00.000Z", window)).toBe(false);
  });
});

describe("isWithinDateWindow", () => {
  it("excludes the instant exactly at the exclusive end boundary", () => {
    const now = new Date("2026-08-04T18:00:00.000Z");
    const window = assertWindow(resolveFixtureDateWindow("today", { timeZone: TZ, now }));
    expect(isWithinDateWindow(window.utcWindowEnd, window)).toBe(false);
    expect(isWithinDateWindow(window.utcWindowStart, window)).toBe(true);
  });
});

describe("parseDateRangeParam", () => {
  it("maps descriptive slugs to their preset", () => {
    expect(parseDateRangeParam("today")).toBe("today");
    expect(parseDateRangeParam("tomorrow")).toBe("tomorrow");
    expect(parseDateRangeParam("today_tomorrow")).toBe("today_tomorrow");
    expect(parseDateRangeParam("next_3_days")).toBe("next_3_days");
    expect(parseDateRangeParam("next_7_days")).toBe("next_7_days");
    expect(parseDateRangeParam("custom")).toBe("custom");
  });

  it("maps shorthand day-count params to their preset", () => {
    expect(parseDateRangeParam("2d")).toBe("today_tomorrow");
    expect(parseDateRangeParam("3d")).toBe("next_3_days");
    expect(parseDateRangeParam("7d")).toBe("next_7_days");
  });

  it("falls back to the default preset for missing or unrecognized values", () => {
    expect(parseDateRangeParam(undefined)).toBe(DEFAULT_DATE_RANGE_PRESET);
    expect(parseDateRangeParam(null)).toBe(DEFAULT_DATE_RANGE_PRESET);
    expect(parseDateRangeParam("")).toBe(DEFAULT_DATE_RANGE_PRESET);
    expect(parseDateRangeParam("not_a_real_preset")).toBe(DEFAULT_DATE_RANGE_PRESET);
    expect(parseDateRangeParam("14d")).toBe(DEFAULT_DATE_RANGE_PRESET);
  });
});
