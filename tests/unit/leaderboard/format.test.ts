import { describe, expect, it } from "vitest";
import { accuracyPercent, parseWeeklyLeaderboard, picksNeededLabel, qualificationRule, timeLeftLabel, weekRangeLabel, weeklyRecord } from "@/lib/leaderboard/format";
import { parseLeaderboardConfig } from "@/lib/leaderboard/config";

const entry = { rank: 1, tied: false, user_id: "u1", display_name: "Maria", username: "maria", avatar_url: null, correct: 8, incorrect: 2, decided: 10, accuracy: 0.8 };
const good = {
  week_start: "2026-10-26T06:00:00+00:00",
  week_end: "2026-11-02T06:00:00+00:00",
  min_decided: 5,
  top_n: 20,
  total_ranked: 1,
  entries: [entry],
  me: { eligible: true, ranked: true, rank: 1, correct: 8, incorrect: 2, decided: 10, accuracy: 0.8, needed: 0 },
};

describe("parseWeeklyLeaderboard (fail-closed)", () => {
  it("parses exactly the shape the database function returns", () => {
    const board = parseWeeklyLeaderboard(good)!;
    expect(board.minDecided).toBe(5);
    expect(board.entries[0]).toMatchObject({ rank: 1, displayName: "Maria", username: "maria", correct: 8, incorrect: 2, decided: 10, accuracy: 0.8, tied: false });
    expect(board.viewer).toEqual({ eligible: true, ranked: true, rank: 1, correct: 8, incorrect: 2, decided: 10, accuracy: 0.8, needed: 0 });
  });

  it("accepts the other viewer shapes: unqualified, not-ranked account, no viewer", () => {
    expect(parseWeeklyLeaderboard({ ...good, me: { eligible: true, ranked: false, rank: null, correct: 2, incorrect: 1, decided: 3, accuracy: 0.6667, needed: 2 } })!.viewer).toMatchObject({ ranked: false, rank: null, needed: 2 });
    expect(parseWeeklyLeaderboard({ ...good, me: { ranked: false, eligible: false, reason: "not_ranked_account" } })!.viewer).toEqual({ eligible: false, reason: "not_ranked_account" });
    expect(parseWeeklyLeaderboard({ ...good, me: null })!.viewer).toBeNull();
    expect(parseWeeklyLeaderboard({ ...good, entries: [] })!.entries).toEqual([]);
  });

  it("falls back to the username, then a neutral word, never an email or an id, for the name", () => {
    expect(parseWeeklyLeaderboard({ ...good, entries: [{ ...entry, display_name: "  " }] })!.entries[0].displayName).toBe("maria");
    expect(parseWeeklyLeaderboard({ ...good, entries: [{ ...entry, display_name: "", username: null }] })!.entries[0].displayName).toBe("A Member");
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["a bad week", { ...good, week_start: "not a date" }],
    ["a minimum below one", { ...good, min_decided: 0 }],
    ["missing entries", { ...good, entries: undefined }],
    ["a record that does not add up", { ...good, entries: [{ ...entry, decided: 11 }] }],
    ["an entry with no decided pick", { ...good, entries: [{ ...entry, correct: 0, incorrect: 0, decided: 0 }] }],
    ["an accuracy above one", { ...good, entries: [{ ...entry, accuracy: 1.4 }] }],
    ["a rank of zero", { ...good, entries: [{ ...entry, rank: 0 }] }],
    ["a ranked viewer with no rank", { ...good, me: { ...good.me, rank: null } }],
    ["a viewer of an unknown shape", { ...good, me: "me" }],
  ])("refuses %s", (_label, value) => {
    expect(parseWeeklyLeaderboard(value)).toBeNull();
  });
});

describe("wording", () => {
  it("shows the raw record first and a whole-percent accuracy", () => {
    expect(weeklyRecord(8, 2)).toBe("8–2");
    expect(accuracyPercent(0.8)).toBe("80%");
    expect(accuracyPercent(0.6667)).toBe("67%");
  });

  it("says the week the way Costa Rica sees it, ending on the Sunday", () => {
    expect(weekRangeLabel("2026-10-26T06:00:00+00:00", "2026-11-02T06:00:00+00:00")).toBe("Oct 26 – Nov 1");
  });

  it("says how long is left", () => {
    const end = "2026-11-02T06:00:00+00:00";
    expect(timeLeftLabel(end, new Date("2026-10-29T05:00:00Z"))).toBe("4 days left");
    expect(timeLeftLabel(end, new Date("2026-11-01T06:00:00Z"))).toBe("1 day left");
    expect(timeLeftLabel(end, new Date("2026-11-02T01:30:00Z"))).toBe("4 hours left");
    expect(timeLeftLabel(end, new Date("2026-11-02T05:00:01Z"))).toBe("Less than an hour left");
    expect(timeLeftLabel(end, new Date("2026-11-02T06:00:00Z"))).toBe("Ending now");
  });

  it("states the rule and the progress in plain words — no points, no betting language", () => {
    expect(qualificationRule(5)).toBe("5 decided Picks this week to qualify. Ranked by accuracy, then most correct.");
    expect(picksNeededLabel(2)).toBe("You need 2 more Picks");
    expect(picksNeededLabel(1)).toBe("You need 1 more Pick");
    for (const text of [qualificationRule(5), picksNeededLabel(2)]) expect(text).not.toMatch(/points?|earn|bet|wager|prize/i);
  });
});

describe("parseLeaderboardConfig (fails closed)", () => {
  it("is on only for a literal true with valid numbers", () => {
    expect(parseLeaderboardConfig({ leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: 20 })).toEqual({ weeklyMinDecidedPicks: 5, topN: 20 });
    for (const row of [
      null,
      undefined,
      {},
      { leaderboard_enabled: false, leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: 20 },
      { leaderboard_enabled: "true", leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: 20 },
      { leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: 0, leaderboard_top_n: 20 },
      { leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: 5.5, leaderboard_top_n: 20 },
      { leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: 2 },
      { leaderboard_enabled: true, leaderboard_weekly_min_decided_picks: 5, leaderboard_top_n: null },
    ]) {
      expect(parseLeaderboardConfig(row as never)).toBeNull();
    }
  });
});
