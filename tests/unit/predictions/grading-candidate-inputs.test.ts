import { describe, expect, it } from "vitest";
import { sportsThatCannotEndLevel, canEndLevel } from "@/lib/sports-data/sport-registry";
import { DETERMINISTIC_VOID_STATUS, RESOLVABLE_STATUS } from "@/lib/predictions/sports-resolution";

/**
 * The inputs the grading candidate selection (migration 215) is given. The Game-state model lives in application code and is passed to the database, so a second status
 * model never exists in SQL: these are the same facts the grader itself decides with.
 */
describe("grading candidate inputs", () => {
  it("the two terminal Game statuses are the ones the grader acts on", () => {
    expect(RESOLVABLE_STATUS).toBe("COMPLETED");
    expect(DETERMINISTIC_VOID_STATUS).toBe("CANCELLED");
  });

  it("the level-final sports are exactly those whose finished games cannot end level, derived from the registry (data), never a second list", () => {
    const sports = sportsThatCannotEndLevel();
    expect(sports.length).toBeGreaterThan(0);
    for (const sport of sports) expect(canEndLevel(sport), sport).toBe(false);
    expect(sports).toEqual(expect.arrayContaining(["basketball", "hockey"]));
    // a sport where a tie is a real result (the NFL), and an unknown sport (permissive, as the grader treats it), are never in the list
    expect(sports).not.toContain("american_football");
    expect(sports).not.toContain("some_future_sport");
  });
});
