import { describe, expect, it } from "vitest";
import { normalizeElapsedMinutes } from "@/lib/sports-data/api-nfl-provider";

// Regression test for a real production incident: API-NFL's
// status.timer returned "15:00" (a quarter-clock string) for an
// in-progress game, and the old code passed it straight through as
// elapsedMinutes (an integer column), failing an entire 314-fixture
// batch upsert with "invalid input syntax for type integer: \"15:00\"".
describe("normalizeElapsedMinutes", () => {
  it("passes through a real integer unchanged", () => {
    expect(normalizeElapsedMinutes(15)).toBe(15);
    expect(normalizeElapsedMinutes(0)).toBe(0);
  });

  it("stores null for a clock-string shape rather than guessing a conversion", () => {
    expect(normalizeElapsedMinutes("15:00")).toBeNull();
    expect(normalizeElapsedMinutes("0:00")).toBeNull();
  });

  it("passes through null unchanged", () => {
    expect(normalizeElapsedMinutes(null)).toBeNull();
  });
});
