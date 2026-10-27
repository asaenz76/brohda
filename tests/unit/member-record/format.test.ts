import { describe, expect, it } from "vitest";
import { formLabel, formSpoken, identityRecordText, parseMemberRecordSummary, percentIfEnough, recordLabel, sportName, streakLabel } from "@/lib/member-record/format";

const valid = {
  correct: 7,
  incorrect: 3,
  void: 1,
  form: ["W", "L", "W"],
  current_streak: { kind: "CORRECT", length: 4 },
  best_correct_streak: 8,
  this_week: { correct: 2, incorrect: 1 },
  confidence: { picks: 5, correct: 3, incorrect: 1 },
  by_sport: [{ sport: "american_football", correct: 7, incorrect: 3, void: 1 }],
  by_season: [{ sport: "american_football", season: "2026", correct: 7, incorrect: 3 }],
};

describe("parseMemberRecordSummary — fail closed", () => {
  it("accepts a well-formed summary and maps it", () => {
    const s = parseMemberRecordSummary(valid)!;
    expect(s).toMatchObject({ correct: 7, incorrect: 3, void: 1, form: ["W", "L", "W"], currentStreak: { kind: "CORRECT", length: 4 }, bestCorrectStreak: 8, thisWeek: { correct: 2, incorrect: 1 }, confidence: { picks: 5, correct: 3, incorrect: 1 } });
    expect(s.bySeason).toEqual([{ sport: "american_football", season: "2026", correct: 7, incorrect: 3 }]);
  });

  it("accepts an empty record (no streak)", () => {
    expect(parseMemberRecordSummary({ ...valid, correct: 0, incorrect: 0, void: 0, form: [], current_streak: null, best_correct_streak: 0, by_sport: [], by_season: [] })?.currentStreak).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["a negative count", { ...valid, correct: -1 }],
    ["a fractional count", { ...valid, incorrect: 1.5 }],
    ["a bad form entry", { ...valid, form: ["W", "X"] }],
    ["a bad streak kind", { ...valid, current_streak: { kind: "WIN", length: 2 } }],
    ["a missing week", { ...valid, this_week: null }],
    ["a bad sport row", { ...valid, by_sport: [{ sport: 1, correct: 1, incorrect: 0, void: 0 }] }],
  ])("rejects %s instead of trusting it", (_, raw) => {
    expect(parseMemberRecordSummary(raw)).toBeNull();
  });
});

describe("percentages are only shown when there is enough to mean something", () => {
  it("hides below the configured minimum and shows the raw record instead", () => {
    expect(percentIfEnough({ correct: 1, incorrect: 0 }, 5)).toBeNull();
    expect(percentIfEnough({ correct: 4, incorrect: 0 }, 5)).toBeNull();
    expect(percentIfEnough({ correct: 5, incorrect: 0 }, 5)).toBe(100);
    expect(percentIfEnough({ correct: 7, incorrect: 3 }, 5)).toBe(70);
  });
  it("a minimum of 0 or 1 shows it from the first decided pick, but never for zero decided", () => {
    expect(percentIfEnough({ correct: 1, incorrect: 0 }, 1)).toBe(100);
    expect(percentIfEnough({ correct: 1, incorrect: 0 }, 0)).toBe(100);
    expect(percentIfEnough({ correct: 0, incorrect: 0 }, 0)).toBeNull();
  });
  it("rounds to a whole percent", () => {
    expect(percentIfEnough({ correct: 2, incorrect: 1 }, 1)).toBe(67);
  });
});

describe("labels", () => {
  it("record", () => expect(recordLabel({ correct: 7, incorrect: 3 })).toBe("7–3"));
  it("streak reads as words, for a run and for a single pick", () => {
    expect(streakLabel({ kind: "CORRECT", length: 4 })).toBe("4 correct in a row");
    expect(streakLabel({ kind: "INCORRECT", length: 3 })).toBe("3 misses in a row");
    expect(streakLabel({ kind: "CORRECT", length: 1 })).toBe("Last pick correct");
    expect(streakLabel({ kind: "INCORRECT", length: 1 })).toBe("Last pick incorrect");
    expect(streakLabel(null)).toBeNull();
  });
  it("form: 'Last 10: 7–3', and the spoken version names each result", () => {
    expect(formLabel(["W", "W", "L", "W", "W", "L", "W", "W", "L", "W"])).toBe("Last 10: 7–3");
    expect(formLabel(["L"])).toBe("Last 1: 0–1");
    expect(formLabel([])).toBeNull();
    expect(formSpoken(["W", "L"])).toBe("correct, incorrect");
  });
  it("a sport reads as the league members know it; an unknown key is not guessed", () => {
    expect(sportName("american_football")).toBe("NFL");
    expect(sportName("basketball")).toBe("NBA");
    expect(sportName("unknown")).toBe("Other");
    expect(sportName("curling")).toBe("curling");
  });
});

describe("the identity line of a tiny sample", () => {
  const rep = (correct: number, incorrect: number, min?: number) => ({ correct, incorrect, decided: correct + incorrect, accuracy: correct + incorrect ? correct / (correct + incorrect) : null, minDecidedForLeaderboard: min });
  it("shows the raw record below the minimum and the percentage at it", () => {
    expect(identityRecordText(rep(1, 0, 5))).toEqual({ percent: null, record: "1–0" });
    expect(identityRecordText(rep(3, 1, 5))).toEqual({ percent: null, record: "3–1" });
    expect(identityRecordText(rep(4, 1, 5))).toEqual({ percent: 80, record: null });
  });
  it("without the record fields (a caller that only has the old three) the percentage is unchanged", () => {
    expect(identityRecordText({ decided: 1, accuracy: 1 })).toEqual({ percent: 100, record: null });
  });
  it("no decided pick: nothing is fabricated", () => {
    expect(identityRecordText(rep(0, 0, 5))).toEqual({ percent: null, record: null });
  });
});
