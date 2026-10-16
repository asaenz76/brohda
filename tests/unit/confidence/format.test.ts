import { describe, expect, it } from "vitest";
import { FLAME_ROW_MAX, INT4_MAX, confidenceLabel, describeEntry, describeEntryChange, flames, formatConfidence, ladderFlames, formatSignedConfidence, formatWait, isValidStakeLadder, parseStakeLadder } from "@/lib/confidence/format";

describe("Confidence formatting", () => {
  it("writes the unit with the flame and the words for screen readers", () => {
    expect(formatConfidence(50)).toBe("🔥50");
    expect(formatConfidence(1234)).toBe("🔥1,234");
    expect(confidenceLabel(5)).toBe("5 Confidence");
    expect(confidenceLabel(1234)).toBe("1,234 Confidence");
  });

  it("signs changes with a real minus", () => {
    expect(formatSignedConfidence(5)).toBe("+5🔥");
    expect(formatSignedConfidence(-5)).toBe("−5🔥");
    expect(formatSignedConfidence(1)).toBe("+1🔥");
  });

  it("describes entries without ever exposing an admin reason or note", () => {
    expect(describeEntry("INITIAL_GRANT")).toBe("Initial Confidence");
    expect(describeEntry("DAILY_CLAIM")).toBe("Daily Claim");
    expect(describeEntry("ADMIN_ADJUSTMENT")).toBe("Adjustment by Brohda");
    expect(describeEntry("REVERSAL")).toBe("Correction by Brohda");
    expect(describeEntry("SOMETHING_FUTURE")).toBe("Confidence update");
  });

  it("states a rolling wait as a real duration — never a calendar word", () => {
    expect(formatWait(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatWait(42 * 60_000)).toBe("42m");
    expect(formatWait(2 * 3_600_000)).toBe("2h");
    expect(formatWait(0)).toBe("now");
    expect(formatWait(-5)).toBe("now");
    for (const ms of [1, 60_000, 3_600_000, 86_399_000]) expect(formatWait(ms)).not.toMatch(/tomorrow|today|midnight/i);
  });
});

describe("the future stake ladder", () => {
  it("accepts any non-empty, strictly ascending list of positive whole numbers — how many and how large is product policy, not a code limit", () => {
    expect(isValidStakeLadder([1, 2, 3, 4, 5])).toBe(true);
    expect(isValidStakeLadder([5])).toBe(true);
    expect(isValidStakeLadder([1, 5, 10, 1000, 100000])).toBe(true);
    expect(isValidStakeLadder(Array.from({ length: 40 }, (_, i) => i + 1))).toBe(true);
    expect(isValidStakeLadder([1, INT4_MAX])).toBe(true);
  });

  it("rejects empty, unordered, duplicate, non-positive and fractional lists, and anything the 32-bit integer column cannot hold", () => {
    for (const bad of [[], [3, 2, 1], [1, 1, 2], [0, 1], [-1, 2], [1.5, 2], [1, INT4_MAX + 1], "1,2", null, undefined, [1, null], [NaN]]) {
      expect(isValidStakeLadder(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("parses the admin form's text", () => {
    expect(parseStakeLadder("1, 2, 3, 4, 5")).toEqual([1, 2, 3, 4, 5]);
    expect(parseStakeLadder(" 2,4 ")).toEqual([2, 4]);
    for (const bad of ["", "a,b", "1,,x", "1.5", "-1"]) expect(parseStakeLadder(bad), bad).toBeNull();
  });
});

describe("Confidence behind a Pick", () => {
  it("names the four prediction entries in plain words", () => {
    expect(describeEntry("PREDICTION_RESERVE")).toBe("Prediction reserved");
    expect(describeEntry("PREDICTION_RELEASE")).toBe("Prediction void");
    expect(describeEntry("PREDICTION_WIN")).toBe("Prediction correct");
    expect(describeEntry("PREDICTION_LOSS")).toBe("Prediction incorrect");
  });

  it("reads each entry's change from the Member's side: net +N on a win, −N on a loss, 0 on a void, a split on a reserve", () => {
    expect(describeEntryChange("PREDICTION_RESERVE", -3, 3)).toEqual({ headline: "🔥3 reserved", detail: "−3 available · +3 reserved" });
    expect(describeEntryChange("PREDICTION_WIN", 6, -3).headline).toBe("+3🔥");
    expect(describeEntryChange("PREDICTION_LOSS", 0, -3).headline).toBe("−3🔥");
    expect(describeEntryChange("PREDICTION_RELEASE", 3, -3).headline).toBe("🔥3 returned");
    expect(describeEntryChange("DAILY_CLAIM", 1, 0)).toEqual({ headline: "+1🔥", detail: null });
  });

  it("draws the conviction as flames, bounded for layout only (the ladder itself is unbounded)", () => {
    expect(flames(3)).toBe("🔥🔥🔥");
    expect(ladderFlames(2)).toBe("🔥🔥");
    expect(ladderFlames(FLAME_ROW_MAX + 20)).toBe(formatConfidence(FLAME_ROW_MAX + 20));
  });
});
