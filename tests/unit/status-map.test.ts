import { describe, expect, it } from "vitest";
import { normalizeApiFootballStatus, normalizeApiNflStatus, isTerminalStatus } from "@/lib/sports-data/status-map";

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

describe("normalizeApiNflStatus", () => {
  const cases: Array<[string, string]> = [
    ["NS", "NOT_STARTED"],
    ["FT", "COMPLETED"],
    // A regulation-tied NFL game that goes to overtime finishes with status
    // AOT ("After Over Time"), not FT — found via a live spot-check against
    // the completed 2025 season (16 of 335 games, ~5%). Before this was
    // added to NFL_CODE_MAP, an OT game fell back to UNKNOWN, which is
    // never COMPLETED, so gradeTemplatePool/processAwaitingResults would
    // never grade it — every pool on an overtime game would sit stuck in
    // AWAITING_RESULT forever instead of settling.
    ["AOT", "COMPLETED"],
    ["Q1", "LIVE"],
    ["Q2", "LIVE"],
    ["Q3", "LIVE"],
    ["Q4", "LIVE"],
    ["HT", "HALFTIME"],
    ["OT", "EXTRA_TIME"],
    ["PST", "POSTPONED"],
    ["CANC", "CANCELLED"],
    ["ABD", "ABANDONED"],
  ];

  it.each(cases)("maps %s to %s", (code, expected) => {
    expect(normalizeApiNflStatus(code)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(normalizeApiNflStatus("aot")).toBe("COMPLETED");
  });

  it("falls back to UNKNOWN for an unrecognized code", () => {
    expect(normalizeApiNflStatus("SOMETHING_NEW")).toBe("UNKNOWN");
  });

  it("falls back to UNKNOWN for null/undefined/empty", () => {
    expect(normalizeApiNflStatus(null)).toBe("UNKNOWN");
    expect(normalizeApiNflStatus(undefined)).toBe("UNKNOWN");
    expect(normalizeApiNflStatus("")).toBe("UNKNOWN");
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
