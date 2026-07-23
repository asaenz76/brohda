import { describe, expect, it } from "vitest";
import {
  hasCalendarDayEnded,
  isAnomalyStatus,
  mapAnomalyToVoidReason,
  requiresSameDayWait,
} from "@/lib/pools/anomaly";

describe("isAnomalyStatus", () => {
  it("flags all six anomaly statuses", () => {
    for (const status of [
      "POSTPONED",
      "SUSPENDED",
      "ABANDONED",
      "CANCELLED",
      "AWARDED",
      "UNKNOWN",
    ] as const) {
      expect(isAnomalyStatus(status)).toBe(true);
    }
  });

  it("does not flag normal statuses", () => {
    for (const status of ["NOT_STARTED", "LIVE", "HALFTIME", "COMPLETED"] as const) {
      expect(isAnomalyStatus(status)).toBe(false);
    }
  });
});

describe("requiresSameDayWait", () => {
  it("waits for X.7.1's four named statuses", () => {
    for (const status of ["POSTPONED", "SUSPENDED", "ABANDONED", "CANCELLED"] as const) {
      expect(requiresSameDayWait(status)).toBe(true);
    }
  });

  it("does not wait for AWARDED/UNKNOWN — neither implies a match that might resume", () => {
    expect(requiresSameDayWait("AWARDED")).toBe(false);
    expect(requiresSameDayWait("UNKNOWN")).toBe(false);
  });
});

describe("mapAnomalyToVoidReason", () => {
  it("maps each anomaly status to its spec-recommended reason", () => {
    expect(mapAnomalyToVoidReason("POSTPONED")).toBe("MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY");
    expect(mapAnomalyToVoidReason("SUSPENDED")).toBe("MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY");
    expect(mapAnomalyToVoidReason("ABANDONED")).toBe("MATCH_ABANDONED");
    expect(mapAnomalyToVoidReason("CANCELLED")).toBe("MATCH_CANCELLED");
    expect(mapAnomalyToVoidReason("AWARDED")).toBe("MATCH_AWARDED");
    expect(mapAnomalyToVoidReason("UNKNOWN")).toBe("MATCH_STATUS_UNKNOWN");
  });

  it("throws for a non-anomaly status", () => {
    expect(() => mapAnomalyToVoidReason("COMPLETED")).toThrow();
  });
});

describe("hasCalendarDayEnded (X.7.2 same-calendar-day rule)", () => {
  it("is false while still the same calendar day in the venue timezone", () => {
    const scheduledStartUtc = "2026-03-10T18:00:00Z"; // 1pm America/Costa_Rica
    const stillSameDay = new Date("2026-03-10T23:30:00Z"); // 6:30pm CR, still Mar 10
    expect(hasCalendarDayEnded(scheduledStartUtc, "America/Costa_Rica", stillSameDay)).toBe(false);
  });

  it("is true once the current date has rolled over in the venue timezone", () => {
    const scheduledStartUtc = "2026-03-10T18:00:00Z";
    const nextDay = new Date("2026-03-11T06:30:00Z"); // 12:30am CR on Mar 11
    expect(hasCalendarDayEnded(scheduledStartUtc, "America/Costa_Rica", nextDay)).toBe(true);
  });

  it("uses the given timezone, not UTC — a match late in the UTC day can still be 'today' locally", () => {
    // 11pm UTC on Mar 10 is only 5pm in America/Costa_Rica (UTC-6) — same day.
    const scheduledStartUtc = "2026-03-10T23:00:00Z";
    const laterSameUtcDay = new Date("2026-03-10T23:30:00Z");
    expect(hasCalendarDayEnded(scheduledStartUtc, "America/Costa_Rica", laterSameUtcDay)).toBe(
      false,
    );
  });
});
