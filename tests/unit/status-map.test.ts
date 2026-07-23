import { describe, expect, it } from "vitest";
import { normalizeApiFootballStatus, isTerminalStatus } from "@/lib/sports-data/status-map";

describe("normalizeApiFootballStatus", () => {
  const cases: Array<[string, string]> = [
    ["TBD", "NOT_STARTED"],
    ["NS", "NOT_STARTED"],
    ["1H", "LIVE"],
    ["2H", "LIVE"],
    ["LIVE", "LIVE"],
    ["HT", "HALFTIME"],
    ["ET", "EXTRA_TIME"],
    ["BT", "EXTRA_TIME"],
    ["P", "PENALTIES"],
    ["FT", "COMPLETED"],
    ["AET", "COMPLETED"],
    ["PEN", "COMPLETED"],
    ["PST", "POSTPONED"],
    ["SUSP", "SUSPENDED"],
    ["INT", "SUSPENDED"],
    ["ABD", "ABANDONED"],
    ["CANC", "CANCELLED"],
    ["AWD", "AWARDED"],
    ["WO", "AWARDED"],
  ];

  it.each(cases)("maps %s to %s", (code, expected) => {
    expect(normalizeApiFootballStatus(code)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(normalizeApiFootballStatus("ft")).toBe("COMPLETED");
  });

  it("falls back to UNKNOWN for an unrecognized code", () => {
    expect(normalizeApiFootballStatus("SOMETHING_NEW")).toBe("UNKNOWN");
  });

  it("falls back to UNKNOWN for null/undefined/empty", () => {
    expect(normalizeApiFootballStatus(null)).toBe("UNKNOWN");
    expect(normalizeApiFootballStatus(undefined)).toBe("UNKNOWN");
    expect(normalizeApiFootballStatus("")).toBe("UNKNOWN");
  });
});

describe("isTerminalStatus", () => {
  it("is true for COMPLETED, CANCELLED, ABANDONED, AWARDED", () => {
    expect(isTerminalStatus("COMPLETED")).toBe(true);
    expect(isTerminalStatus("CANCELLED")).toBe(true);
    expect(isTerminalStatus("ABANDONED")).toBe(true);
    expect(isTerminalStatus("AWARDED")).toBe(true);
  });

  it("is false for non-terminal statuses", () => {
    expect(isTerminalStatus("NOT_STARTED")).toBe(false);
    expect(isTerminalStatus("LIVE")).toBe(false);
    expect(isTerminalStatus("POSTPONED")).toBe(false);
    expect(isTerminalStatus("UNKNOWN")).toBe(false);
  });
});
