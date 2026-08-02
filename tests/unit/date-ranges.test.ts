import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previousPeriod, resolveDateRange } from "@/lib/analytics/date-ranges";

const FIXED_NOW = new Date("2026-07-15T12:00:00.000Z");

describe("resolveDateRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("7D/30D/90D span exactly N days ending now, regardless of timezone", () => {
    expect(resolveDateRange("7D", "UTC")).toEqual({
      from: new Date(FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
      to: FIXED_NOW,
    });
    expect(resolveDateRange("30D", "UTC").from.getTime()).toBe(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(resolveDateRange("90D", "America/Costa_Rica").from.getTime()).toBe(FIXED_NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
  });

  it("THIS_MONTH starts at the first of the current UTC month when timeZone is UTC", () => {
    const range = resolveDateRange("THIS_MONTH", "UTC");
    expect(range.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(range.to).toEqual(FIXED_NOW);
  });

  it("YTD starts at Jan 1 of the current UTC year when timeZone is UTC", () => {
    const range = resolveDateRange("YTD", "UTC");
    expect(range.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("THIS_MONTH starts at local midnight in a non-UTC timezone, not UTC midnight", () => {
    // America/Costa_Rica is UTC-6 year-round (no DST) — local midnight
    // July 1 is 06:00 UTC July 1.
    const range = resolveDateRange("THIS_MONTH", "America/Costa_Rica");
    expect(range.from.toISOString()).toBe("2026-07-01T06:00:00.000Z");
  });

  it("a late-night entry near a month boundary lands in the correct local month, not the UTC month", () => {
    // 2026-07-31 23:58 America/Costa_Rica = 2026-08-01 05:58 UTC. If
    // THIS_MONTH's boundary were computed in UTC, "August" would start at
    // 2026-08-01T00:00:00Z and incorrectly exclude entries from local Jul 31
    // evening that are still Aug 1 in UTC terms — this proves the boundary
    // itself is anchored to the user's local calendar, not UTC's.
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
    const range = resolveDateRange("THIS_MONTH", "America/Costa_Rica");
    // Local Aug 1 00:00 America/Costa_Rica = Aug 1 06:00 UTC — a 05:58 UTC
    // entry (Jul 31 23:58 local) falls *before* this boundary, correctly
    // excluded from "this month" (August) and attributed to July instead.
    expect(range.from.toISOString()).toBe("2026-08-01T06:00:00.000Z");
    const lateNightEntryUtc = new Date("2026-08-01T05:58:00.000Z");
    expect(lateNightEntryUtc.getTime()).toBeLessThan(range.from.getTime());
  });

  it("ALL_TIME uses a fixed far-past sentinel, not null", () => {
    const range = resolveDateRange("ALL_TIME", "UTC");
    expect(range.from.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(range.to).toEqual(FIXED_NOW);
  });

  it("CUSTOM returns the supplied range verbatim", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");
    expect(resolveDateRange("CUSTOM", "UTC", { from, to })).toEqual({ from, to });
  });

  it("CUSTOM without a supplied range throws rather than guessing", () => {
    expect(() => resolveDateRange("CUSTOM", "UTC")).toThrow();
  });
});

describe("previousPeriod", () => {
  // Only the last test below (THIS_MONTH's previous-period boundary) calls
  // resolveDateRange with an implicit "now" — every other test here builds
  // its range from literal dates, so it doesn't need the clock frozen. But
  // that one test silently depended on the real wall clock still being in
  // the same month FIXED_NOW is in, which broke the moment real time moved
  // past July 2026 — freezing it here, matching the sibling describe
  // block's pattern, makes every test in this file time-independent.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shifts 7D/30D/90D back by the exact duration with no overlap", () => {
    const range = { from: new Date("2026-07-01T00:00:00.000Z"), to: new Date("2026-07-08T00:00:00.000Z") };
    const prev = previousPeriod(range, "7D", "UTC");
    expect(prev).toEqual({
      from: new Date("2026-06-24T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    });
  });

  it("THIS_MONTH compares against the immediately preceding full calendar month", () => {
    const range = { from: new Date("2026-07-01T00:00:00.000Z"), to: new Date("2026-07-30T12:00:00.000Z") };
    const prev = previousPeriod(range, "THIS_MONTH", "UTC");
    expect(prev).toEqual({
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    });
  });

  it("THIS_MONTH handles the January -> December-of-prior-year rollover", () => {
    const range = { from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-01-15T00:00:00.000Z") };
    const prev = previousPeriod(range, "THIS_MONTH", "UTC");
    expect(prev).toEqual({
      from: new Date("2025-12-01T00:00:00.000Z"),
      to: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("YTD compares against the same year-to-date window one year earlier", () => {
    const range = { from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-07-15T12:00:00.000Z") };
    const prev = previousPeriod(range, "YTD", "UTC");
    expect(prev).toEqual({
      from: new Date("2025-01-01T00:00:00.000Z"),
      to: new Date("2025-07-15T12:00:00.000Z"),
    });
  });

  it("ALL_TIME has no meaningful previous period", () => {
    const range = resolveDateRange("ALL_TIME", "UTC");
    expect(previousPeriod(range, "ALL_TIME", "UTC")).toBeNull();
  });

  it("CUSTOM shifts back by the exact selected duration", () => {
    const range = { from: new Date("2026-06-01T00:00:00.000Z"), to: new Date("2026-06-11T00:00:00.000Z") };
    const prev = previousPeriod(range, "CUSTOM", "UTC");
    expect(prev).toEqual({
      from: new Date("2026-05-22T00:00:00.000Z"),
      to: new Date("2026-06-01T00:00:00.000Z"),
    });
  });

  it("THIS_MONTH's previous-period boundary is also timezone-aware", () => {
    const range = resolveDateRange("THIS_MONTH", "America/Costa_Rica");
    const prev = previousPeriod(range, "THIS_MONTH", "America/Costa_Rica");
    expect(prev?.from.toISOString()).toBe("2026-06-01T06:00:00.000Z");
    expect(prev?.to).toEqual(range.from);
  });
});
