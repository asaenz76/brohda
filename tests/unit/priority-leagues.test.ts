import { describe, expect, it } from "vitest";
import {
  PRIORITY_LEAGUES,
  compareLeagueTier,
  getPriorityLeagueMap,
  isLeagueInSeason,
} from "@/lib/sports-data/priority-leagues";

describe("getPriorityLeagueMap", () => {
  it("keys every curated league by its external id", () => {
    const map = getPriorityLeagueMap();
    expect(map.size).toBe(PRIORITY_LEAGUES.length);
    expect(map.get("39")?.tier).toBe("A"); // Premier League
  });

  it("returns undefined for a league not in the curated set", () => {
    expect(getPriorityLeagueMap().get("999999")).toBeUndefined();
  });
});

describe("isLeagueInSeason", () => {
  it("is true for a month in the league's activeMonths", () => {
    const premierLeague = getPriorityLeagueMap().get("39")!;
    expect(isLeagueInSeason(premierLeague, 10)).toBe(true); // October
  });

  it("is false for a month outside the league's activeMonths (summer break)", () => {
    const premierLeague = getPriorityLeagueMap().get("39")!;
    expect(isLeagueInSeason(premierLeague, 7)).toBe(false); // July
  });

  it("is true year-round for a split-calendar league", () => {
    const ligaMx = getPriorityLeagueMap().get("262")!;
    for (let month = 1; month <= 12; month++) {
      expect(isLeagueInSeason(ligaMx, month)).toBe(true);
    }
  });
});

describe("compareLeagueTier", () => {
  it("orders A before B before C", () => {
    expect(compareLeagueTier("A", "B")).toBeLessThan(0);
    expect(compareLeagueTier("B", "C")).toBeLessThan(0);
    expect(compareLeagueTier("A", "C")).toBeLessThan(0);
  });

  it("is zero for equal tiers", () => {
    expect(compareLeagueTier("B", "B")).toBe(0);
  });
});
