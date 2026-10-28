import { describe, expect, it } from "vitest";
import { MIN_COHORT, parseActivationFunnel, rateLabel, tooSmall } from "@/lib/activation/format";

const good = {
  from: "2026-09-28T00:00:00Z", to: "2026-10-28T00:00:00Z", registered: 40, registered_24h_old: 38, picked_ever: 20, picked_within_24h: 12, median_minutes_to_first_pick: 14.5,
  activated_7d_old: 15, second_pick_within_7d: 9, first_graded_48h_old: 10, came_back_within_48h: 6, commented: 5, called_bs: 2, weekly_min_decided: 5, ranked_this_week: 3,
  by_week: [{ week: "2026-10-19", registered: 25, registered_24h_old: 23, picked_within_24h: 8 }],
};

describe("parseActivationFunnel (fail-closed)", () => {
  it("parses exactly what the database function returns", () => {
    const f = parseActivationFunnel(good)!;
    expect(f).toMatchObject({ registered: 40, pickedWithin24h: 12, secondPickWithin7d: 9, cameBackWithin48h: 6, rankedThisWeek: 3, medianMinutesToFirstPick: 14.5 });
    expect(f.byWeek).toEqual([{ week: "2026-10-19", registered: 25, registered24hOld: 23, pickedWithin24h: 8 }]);
    expect(parseActivationFunnel({ ...good, median_minutes_to_first_pick: null })!.medianMinutesToFirstPick).toBeNull();
  });
  it.each([
    ["null", null],
    ["a missing count", { ...good, registered: undefined }],
    ["a negative count", { ...good, commented: -1 }],
    ["a numerator above its denominator (24h)", { ...good, picked_within_24h: 30, picked_ever: 20 }],
    ["an activation numerator above the 24-hour-old cohort", { ...good, picked_within_24h: 20, picked_ever: 20, registered_24h_old: 18 }],
    ["more second picks than activated Members", { ...good, second_pick_within_7d: 16 }],
    ["more returns than first results", { ...good, came_back_within_48h: 11 }],
    ["a malformed week", { ...good, by_week: [{ week: 1, registered: 1, registered_24h_old: 1, picked_within_24h: 0 }] }],
    ["by_week not a list", { ...good, by_week: "x" }],
  ])("refuses %s", (_l, value) => expect(parseActivationFunnel(value)).toBeNull());
});

describe("rateLabel — never a percentage without a population", () => {
  it("shows plain counts below the minimum cohort, a percentage at or above it, and 'no one yet' for nobody", () => {
    expect(rateLabel(2, 4)).toBe("2 of 4");
    expect(rateLabel(3, MIN_COHORT - 1)).toBe(`3 of ${MIN_COHORT - 1}`);
    expect(rateLabel(15, MIN_COHORT)).toBe(`15 of ${MIN_COHORT} (50%)`);
    expect(rateLabel(0, 0)).toBe("no one yet");
    expect(tooSmall(4)).toBe(true);
    expect(tooSmall(0)).toBe(false);
    expect(tooSmall(MIN_COHORT)).toBe(false);
  });
});
