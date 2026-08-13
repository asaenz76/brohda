import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  CATEGORY_LABELS,
  TABS,
  buildCompetitionOptions,
  tabsForSport,
  type FixtureOption,
} from "@/app/(admin)/admin/pools/new/template-cards";

function fixture(overrides: Partial<FixtureOption>): FixtureOption {
  return {
    id: "f1",
    externalFixtureId: null,
    homeTeamExternalId: null,
    homeTeamName: "Home",
    homeTeamLogoUrl: null,
    awayTeamExternalId: null,
    awayTeamName: "Away",
    awayTeamLogoUrl: null,
    competitionType: null,
    sport: "football",
    league: "England | Premier League",
    label: "Home vs Away",
    scheduledStartUtc: "2026-01-01T00:00:00.000Z",
    competitionKey: "api_football:39:2026",
    ...overrides,
  };
}

describe("template-cards", () => {
  it("every card carries a Question Family (or null only for none)", () => {
    for (const card of ALL_CARDS) {
      expect(card.family, card.id).not.toBeUndefined();
    }
  });

  it("moves WHO_WILL_ADVANCE/REGULATION_RESULT into their own TRADITIONAL category, separate from the registry MATCH_RESULT templates", () => {
    const whoWillAdvance = ALL_CARDS.find((c) => c.id === "WHO_WILL_ADVANCE")!;
    const regulationResult = ALL_CARDS.find((c) => c.id === "REGULATION_RESULT")!;
    const homeTeamToWin = ALL_CARDS.find((c) => c.id === "HOME_TEAM_TO_WIN")!;

    expect(whoWillAdvance.category).toBe("TRADITIONAL");
    expect(regulationResult.category).toBe("TRADITIONAL");
    expect(homeTeamToWin.category).toBe("MATCH_RESULT");

    // Still the same Question Family — duplicate/mirror detection must
    // keep catching the overlap even though they're in different tabs now.
    expect(whoWillAdvance.family).toBe("MATCH_RESULT");
    expect(homeTeamToWin.family).toBe("MATCH_RESULT");
  });

  it("TABS includes TRADITIONAL and every category has a label", () => {
    expect(TABS).toContain("TRADITIONAL");
    for (const tab of TABS) {
      expect(CATEGORY_LABELS[tab]).toBeTruthy();
    }
  });

  it("tabsForSport excludes TRADITIONAL for american_football — both legacy pool types are disabled for NFL, so the tab has nothing to show", () => {
    const nflTabs = tabsForSport("american_football");
    expect(nflTabs).not.toContain("TRADITIONAL");
    expect(nflTabs).toContain("GOALS");
  });

  it("tabsForSport still includes TRADITIONAL for football", () => {
    expect(tabsForSport("football")).toContain("TRADITIONAL");
  });
});

describe("buildCompetitionOptions", () => {
  it("groups fixtures by competitionKey and counts them", () => {
    const options = buildCompetitionOptions([
      fixture({ id: "f1", competitionKey: "api_football:39:2026" }),
      fixture({ id: "f2", competitionKey: "api_football:39:2026" }),
      fixture({ id: "f3", competitionKey: "api_football:140:2026", league: "Spain | LaLiga" }),
    ]);

    const premierLeague = options.find((o) => o.key === "api_football:39:2026");
    const laLiga = options.find((o) => o.key === "api_football:140:2026");
    expect(premierLeague?.fixtureCount).toBe(2);
    expect(laLiga?.fixtureCount).toBe(1);
  });

  it("excludes fixtures with no competitionKey", () => {
    const options = buildCompetitionOptions([fixture({ competitionKey: null })]);
    expect(options).toHaveLength(0);
  });

  it("assigns group from the supported competitions config, null when unknown", () => {
    const options = buildCompetitionOptions([
      fixture({ competitionKey: "api_football:39:2026" }), // Premier League, Global
      fixture({ id: "f2", competitionKey: "api_football:999999:2026", league: "Unranked League" }),
    ]);
    expect(options.find((o) => o.key === "api_football:39:2026")?.group).toBe("GLOBAL");
    expect(options.find((o) => o.key === "api_football:999999:2026")?.group).toBeNull();
  });

  it("sorts options alphabetically by label", () => {
    const options = buildCompetitionOptions([
      fixture({ id: "f1", competitionKey: "api_football:140:2026", league: "Spain | LaLiga" }),
      fixture({ id: "f2", competitionKey: "api_football:39:2026", league: "England | Premier League" }),
    ]);
    expect(options.map((o) => o.label)).toEqual(["England | Premier League", "Spain | LaLiga"]);
  });
});
