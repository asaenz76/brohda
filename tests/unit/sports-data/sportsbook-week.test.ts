import { describe, expect, it } from "vitest";
import { getCurrentSportsbookWeek } from "@/lib/sports-data/sportsbook-week";

// Real-production incident fix (Stage 4C): bounding fixture-ingestion
// eligibility to "this week only" depends entirely on getting this
// Monday-00:00-through-next-Monday-00:00 (exclusive) boundary exactly
// right in America/New_York — an off-by-one-day error here would either
// silently reintroduce months of over-fetching or drop the current
// week's own games. Every case below is checked against a real,
// independently-verified ET wall-clock offset for that date.

describe("getCurrentSportsbookWeek", () => {
  it("a Wednesday mid-week resolves to that week's own Monday-to-Monday bounds (EDT, UTC-4)", () => {
    // 2026-09-30 is a Wednesday. EDT (UTC-4) is in effect.
    const now = new Date("2026-09-30T15:00:00.000Z");
    const { weekStartUtc, weekEndUtc } = getCurrentSportsbookWeek(now);
    expect(weekStartUtc).toBe("2026-09-28T04:00:00.000Z"); // Mon Sep 28 00:00 EDT
    expect(weekEndUtc).toBe("2026-10-05T04:00:00.000Z"); // Mon Oct 5 00:00 EDT
  });

  it("Monday at exactly 00:00:00 ET is the first instant of its own week, not the previous week", () => {
    const now = new Date("2026-09-28T04:00:00.000Z"); // Mon Sep 28 00:00:00 EDT exactly
    const { weekStartUtc } = getCurrentSportsbookWeek(now);
    expect(weekStartUtc).toBe("2026-09-28T04:00:00.000Z");
  });

  it("one millisecond before Monday 00:00 ET still belongs to the PRIOR week", () => {
    const now = new Date("2026-09-28T03:59:59.999Z"); // Sun Sep 27 23:59:59.999 EDT
    const { weekStartUtc, weekEndUtc } = getCurrentSportsbookWeek(now);
    expect(weekStartUtc).toBe("2026-09-21T04:00:00.000Z"); // the prior Monday
    expect(weekEndUtc).toBe("2026-09-28T04:00:00.000Z"); // this instant is excluded from the new week
  });

  it("Sunday just before midnight ET is still inside its week, not already rolled into the next one", () => {
    const now = new Date("2026-10-05T03:59:00.000Z"); // Sun Oct 4 23:59 EDT
    const { weekStartUtc, weekEndUtc } = getCurrentSportsbookWeek(now);
    expect(weekStartUtc).toBe("2026-09-28T04:00:00.000Z");
    expect(weekEndUtc).toBe("2026-10-05T04:00:00.000Z");
  });

  it("correctly spans a month boundary (EDT, UTC-4)", () => {
    // 2026-10-01 is a Thursday, week runs Mon Sep 28 - Mon Oct 5.
    const now = new Date("2026-10-01T12:00:00.000Z");
    const { weekStartUtc, weekEndUtc } = getCurrentSportsbookWeek(now);
    expect(weekStartUtc).toBe("2026-09-28T04:00:00.000Z");
    expect(weekEndUtc).toBe("2026-10-05T04:00:00.000Z");
  });

  it("correctly spans a year boundary (EST, UTC-5)", () => {
    // 2026-12-31 is a Thursday, week runs Mon Dec 28 2026 - Mon Jan 4 2027. EST in effect.
    const now = new Date("2026-12-31T12:00:00.000Z");
    const { weekStartUtc, weekEndUtc } = getCurrentSportsbookWeek(now);
    expect(weekStartUtc).toBe("2026-12-28T05:00:00.000Z"); // Mon Dec 28 00:00 EST (UTC-5)
    expect(weekEndUtc).toBe("2027-01-04T05:00:00.000Z"); // Mon Jan 4 00:00 EST
  });

  it("correctly straddles the DST fall-back transition (2026-11-01, US clocks move EDT->EST)", () => {
    // Week of Mon Oct 26 - Mon Nov 2, 2026: starts in EDT (UTC-4), the
    // following Monday already reads EST (UTC-5) — the two boundaries of
    // the SAME week must use their own, different, correct UTC offsets.
    const now = new Date("2026-10-28T12:00:00.000Z"); // Wed, still EDT
    const { weekStartUtc, weekEndUtc } = getCurrentSportsbookWeek(now);
    expect(weekStartUtc).toBe("2026-10-26T04:00:00.000Z"); // Mon Oct 26 00:00 EDT (UTC-4)
    expect(weekEndUtc).toBe("2026-11-02T05:00:00.000Z"); // Mon Nov 2 00:00 EST (UTC-5) — offset already flipped
  });

  it("accepts a different IANA time zone for a future sport with its own convention", () => {
    const now = new Date("2026-09-30T15:00:00.000Z");
    const utcBounds = getCurrentSportsbookWeek(now, "UTC");
    expect(utcBounds.weekStartUtc).toBe("2026-09-28T00:00:00.000Z");
    expect(utcBounds.weekEndUtc).toBe("2026-10-05T00:00:00.000Z");
  });
});
