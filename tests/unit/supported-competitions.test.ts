import { describe, expect, it } from "vitest";
import {
  SUPPORTED_COMPETITIONS,
  compareCompetitionGroup,
  getSupportedCompetition,
  getSupportedCompetitionGroup,
  getSupportedCompetitionMap,
  isSupportedCompetition,
} from "@/lib/sports-data/supported-competitions";

describe("SUPPORTED_COMPETITIONS", () => {
  it("has no duplicate resolved external league IDs", () => {
    const ids = SUPPORTED_COMPETITIONS.filter((c) => c.externalLeagueId != null).map((c) => c.externalLeagueId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes CONCACAF Central American Cup in the Costa Rica group", () => {
    const entry = SUPPORTED_COMPETITIONS.find((c) => c.externalLeagueId === "1028");
    expect(entry?.group).toBe("COSTA_RICA");
    expect(entry?.enabled).toBe(true);
  });

  it("does not include Colombia Primera A (external id 239) at all", () => {
    expect(SUPPORTED_COMPETITIONS.find((c) => c.externalLeagueId === "239")).toBeUndefined();
  });

  it("leaves Costa Rica Cup and Super Cup unresolved (null id, disabled) rather than guessing an ID", () => {
    const cup = SUPPORTED_COMPETITIONS.find((c) => c.name === "Costa Rica Cup");
    const superCup = SUPPORTED_COMPETITIONS.find((c) => c.name === "Costa Rica Super Cup");
    expect(cup?.externalLeagueId).toBeNull();
    expect(cup?.enabled).toBe(false);
    expect(superCup?.externalLeagueId).toBeNull();
    expect(superCup?.enabled).toBe(false);
  });
});

describe("getSupportedCompetitionMap / isSupportedCompetition", () => {
  it("excludes disabled and unresolved (null id) entries from the lookup map", () => {
    const map = getSupportedCompetitionMap();
    expect([...map.values()].every((c) => c.enabled && c.externalLeagueId != null)).toBe(true);
  });

  it("recognizes a real supported competition", () => {
    expect(isSupportedCompetition("39")).toBe(true); // Premier League
    expect(isSupportedCompetition("162")).toBe(true); // Primera División
  });

  it("rejects an unsupported competition", () => {
    expect(isSupportedCompetition("239")).toBe(false); // Colombia Primera A — removed
    expect(isSupportedCompetition("9999999")).toBe(false); // never existed
  });

  it("rejects null/undefined without throwing", () => {
    expect(isSupportedCompetition(null)).toBe(false);
    expect(isSupportedCompetition(undefined)).toBe(false);
  });
});

describe("getSupportedCompetition / getSupportedCompetitionGroup", () => {
  it("returns the full entry for a supported competition", () => {
    const entry = getSupportedCompetition("253");
    expect(entry?.name).toBe("Major League Soccer");
    expect(entry?.group).toBe("GLOBAL");
  });

  it("returns null for an unsupported competition", () => {
    expect(getSupportedCompetition("239")).toBeNull();
    expect(getSupportedCompetitionGroup("239")).toBeNull();
  });
});

describe("compareCompetitionGroup", () => {
  it("orders GLOBAL before COSTA_RICA", () => {
    expect(compareCompetitionGroup("GLOBAL", "COSTA_RICA")).toBeLessThan(0);
    expect(compareCompetitionGroup("COSTA_RICA", "GLOBAL")).toBeGreaterThan(0);
    expect(compareCompetitionGroup("GLOBAL", "GLOBAL")).toBe(0);
  });
});
