import { describe, expect, it } from "vitest";
import { EVENT_STATUS_LABEL, isLiveStatus } from "@/lib/fixtures/status-labels";
import type { FixtureInternalStatus } from "@/lib/sports-data/types";

const ALL_STATUSES: FixtureInternalStatus[] = [
  "NOT_STARTED",
  "LIVE",
  "HALFTIME",
  "EXTRA_TIME",
  "PENALTIES",
  "COMPLETED",
  "POSTPONED",
  "SUSPENDED",
  "ABANDONED",
  "CANCELLED",
  "AWARDED",
  "UNKNOWN",
];

describe("EVENT_STATUS_LABEL", () => {
  it("has a label for every FixtureInternalStatus value — no raw status ever falls through to the admin UI", () => {
    for (const status of ALL_STATUSES) {
      expect(EVENT_STATUS_LABEL[status]).toBeTruthy();
    }
  });

  it("maps NOT_STARTED to Upcoming and COMPLETED to Final", () => {
    expect(EVENT_STATUS_LABEL.NOT_STARTED).toBe("Upcoming");
    expect(EVENT_STATUS_LABEL.COMPLETED).toBe("Final");
  });
});

describe("isLiveStatus", () => {
  it("is true for LIVE, HALFTIME, EXTRA_TIME, PENALTIES", () => {
    expect(isLiveStatus("LIVE")).toBe(true);
    expect(isLiveStatus("HALFTIME")).toBe(true);
    expect(isLiveStatus("EXTRA_TIME")).toBe(true);
    expect(isLiveStatus("PENALTIES")).toBe(true);
  });

  it("is false for NOT_STARTED, COMPLETED, and other non-live statuses", () => {
    expect(isLiveStatus("NOT_STARTED")).toBe(false);
    expect(isLiveStatus("COMPLETED")).toBe(false);
    expect(isLiveStatus("POSTPONED")).toBe(false);
  });
});
