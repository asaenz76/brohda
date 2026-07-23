import { describe, expect, it } from "vitest";
import { getZonedYearMonthDay, isValidIanaTimezone, normalizeIanaTimezone, zonedTimeToUtc } from "@/lib/analytics/timezone";

describe("normalizeIanaTimezone", () => {
  it("accepts canonical IANA identifiers unchanged", () => {
    expect(normalizeIanaTimezone("America/Costa_Rica")).toBe("America/Costa_Rica");
    expect(normalizeIanaTimezone("America/New_York")).toBe("America/New_York");
    expect(normalizeIanaTimezone("Europe/London")).toBe("Europe/London");
  });

  it("rejects free text that isn't a real zone", () => {
    expect(normalizeIanaTimezone("Costa Rica")).toBeNull();
  });

  it("rejects named-offset strings", () => {
    expect(normalizeIanaTimezone("GMT-6")).toBeNull();
    expect(normalizeIanaTimezone("UTC+6")).toBeNull();
  });

  it("rejects raw UTC offsets, which Intl would otherwise accept unchanged", () => {
    expect(normalizeIanaTimezone("-06:00")).toBeNull();
    expect(normalizeIanaTimezone("+05:30")).toBeNull();
  });

  it("rejects casing variants rather than silently canonicalizing them", () => {
    expect(normalizeIanaTimezone("america/costa_rica")).toBeNull();
    expect(normalizeIanaTimezone("AMERICA/COSTA_RICA")).toBeNull();
  });

  it("rejects malformed paths that merely resemble a zone name", () => {
    expect(normalizeIanaTimezone("America/Costa Rica")).toBeNull();
  });

  it("rejects empty/whitespace-only input", () => {
    expect(normalizeIanaTimezone("")).toBeNull();
    expect(normalizeIanaTimezone("   ")).toBeNull();
  });

  it("isValidIanaTimezone mirrors normalizeIanaTimezone's accept/reject decision", () => {
    expect(isValidIanaTimezone("America/Costa_Rica")).toBe(true);
    expect(isValidIanaTimezone("-06:00")).toBe(false);
  });
});

// A DST-observing zone in addition to America/Costa_Rica (which never
// observes DST) — proves bucketing logic downstream can't quietly assume
// every day is 24 hours.
describe("DST-observing timezone edge cases (America/New_York)", () => {
  it("accepts the zone", () => {
    expect(normalizeIanaTimezone("America/New_York")).toBe("America/New_York");
  });

  it("a 23-hour day (spring-forward) still resolves a valid wall-clock offset", () => {
    // 2026-03-08 is the US spring-forward date: 2:00 AM -> 3:00 AM.
    const before = new Date("2026-03-08T06:00:00.000Z"); // 1:00 AM EST (UTC-5)
    const after = new Date("2026-03-08T08:00:00.000Z"); // 4:00 AM EDT (UTC-4)
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    });
    expect(fmt.format(before)).toBe("01");
    expect(fmt.format(after)).toBe("04");
  });

  it("a 25-hour day (fall-back) still resolves distinct wall-clock instants", () => {
    // 2026-11-01 is the US fall-back date: 2:00 AM -> 1:00 AM.
    const firstPass = new Date("2026-11-01T05:30:00.000Z"); // 1:30 AM EDT (UTC-4)
    const secondPass = new Date("2026-11-01T06:30:00.000Z"); // 1:30 AM EST (UTC-5)
    expect(firstPass.getTime()).not.toBe(secondPass.getTime());
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    // Both instants format to the same ambiguous local wall-clock time —
    // this is expected and correct: the two UTC instants are genuinely an
    // hour apart, but the DST-observing zone reuses the 1:00-2:00 AM
    // local label for both. Bucketing must key off the UTC instant (or a
    // zone-aware library), never off a re-parsed local-time string.
    expect(fmt.format(firstPass)).toBe("01:30");
    expect(fmt.format(secondPass)).toBe("01:30");
  });

  it("zonedTimeToUtc + getZonedYearMonthDay round-trip a spring-forward calendar boundary", () => {
    // Midnight March 8 2026 in New York is EST (UTC-5) — before the 2am
    // spring-forward, so this is an unambiguous, existing local time.
    const utcInstant = zonedTimeToUtc(2026, 3, 8, 0, 0, 0, "America/New_York");
    expect(utcInstant.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(getZonedYearMonthDay(utcInstant, "America/New_York")).toEqual({ year: 2026, month: 3, day: 8 });
  });

  it("America/Costa_Rica never observes DST — no ambiguous or nonexistent local times", () => {
    const marchInstant = new Date("2026-03-08T06:00:00.000Z");
    const novemberInstant = new Date("2026-11-01T06:00:00.000Z");
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Costa_Rica",
      timeZoneName: "shortOffset",
    });
    const marchOffset = fmt.formatToParts(marchInstant).find((p) => p.type === "timeZoneName")?.value;
    const novemberOffset = fmt.formatToParts(novemberInstant).find((p) => p.type === "timeZoneName")?.value;
    expect(marchOffset).toBe(novemberOffset);
  });
});
