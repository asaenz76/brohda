import { describe, expect, it } from "vitest";
import {
  PRIORITY_LEAGUES,
  compareLeagueTier,
  getPriorityLeagueMap,
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

  it("includes the curated CONCACAF/CONMEBOL cups", () => {
    const map = getPriorityLeagueMap();
    expect(map.get("1028")?.tier).toBe("B"); // CONCACAF Central American Cup
    expect(map.get("22")?.tier).toBe("B"); // CONCACAF Gold Cup
    expect(map.get("536")?.tier).toBe("B"); // CONCACAF Nations League
    expect(map.get("9")?.tier).toBe("B"); // Copa América
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
