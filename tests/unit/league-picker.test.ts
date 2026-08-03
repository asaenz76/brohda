import { describe, expect, it } from "vitest";
import { categorizeLeaguesForPicker } from "@/lib/sports-data/league-picker";
import type { NormalizedLeague } from "@/lib/sports-data/types";

function league(overrides: Partial<NormalizedLeague> = {}): NormalizedLeague {
  return {
    provider: "api_football",
    externalLeagueId: "1",
    name: "Test League",
    type: "League",
    countryName: "Testland",
    logoUrl: null,
    seasons: [],
    ...overrides,
  };
}

function season(current: boolean) {
  return { year: "2026", startDate: "2026-01-01", endDate: "2026-12-31", current, coverage: null };
}

describe("categorizeLeaguesForPicker", () => {
  it("puts a priority league with a current season in 'in season now'", () => {
    const premierLeague = league({ externalLeagueId: "39", name: "Premier League", seasons: [season(true)] });
    const { inSeason, otherPriority } = categorizeLeaguesForPicker([premierLeague]);
    expect(inSeason).toEqual([premierLeague]);
    expect(otherPriority).toEqual([]);
  });

  it("puts a priority league with no current season in 'other major leagues'", () => {
    // Gold Cup (id 22) is priority but off-cycle most years — no season
    // flagged current.
    const goldCup = league({ externalLeagueId: "22", name: "CONCACAF Gold Cup", type: "Cup", seasons: [season(false)] });
    const { inSeason, otherPriority } = categorizeLeaguesForPicker([goldCup]);
    expect(inSeason).toEqual([]);
    expect(otherPriority).toEqual([goldCup]);
  });

  it("surfaces the Central American Cup in 'in season now' when its season is current", () => {
    const centralAmericanCup = league({
      externalLeagueId: "1028",
      name: "CONCACAF Central American Cup",
      type: "Cup",
      countryName: "World",
      seasons: [season(true)],
    });
    const { inSeason } = categorizeLeaguesForPicker([centralAmericanCup]);
    expect(inSeason).toEqual([centralAmericanCup]);
  });

  it("does NOT surface a non-curated cup in 'in season now' even with a current season", () => {
    // The curated-list decision: only PRIORITY_LEAGUES entries are eligible
    // for the top groups, regardless of the real current flag — otherwise
    // every active regional/youth cup worldwide would flood the top.
    const obscureCup = league({
      externalLeagueId: "999999",
      name: "Some Regional Youth Cup",
      type: "Cup",
      countryName: "Nowhereland",
      seasons: [season(true)],
    });
    const { inSeason, otherPriority, countries } = categorizeLeaguesForPicker([obscureCup]);
    expect(inSeason).toEqual([]);
    expect(otherPriority).toEqual([]);
    expect(countries).toEqual([["Nowhereland", [obscureCup]]]);
  });

  it("orders 'in season now' and 'other major leagues' by tier then name", () => {
    const tierB = league({ externalLeagueId: "162", name: "Costa Rica Liga Promerica", seasons: [season(true)] });
    const tierA = league({ externalLeagueId: "39", name: "Premier League", seasons: [season(true)] });
    const { inSeason } = categorizeLeaguesForPicker([tierB, tierA]);
    expect(inSeason.map((l) => l.externalLeagueId)).toEqual(["39", "162"]);
  });

  it("groups non-priority leagues by country, sorted alphabetically", () => {
    const walesLeague = league({ externalLeagueId: "501", name: "Cymru Premier", countryName: "Wales" });
    const englandLeague = league({ externalLeagueId: "502", name: "National League", countryName: "England" });
    const { countries } = categorizeLeaguesForPicker([walesLeague, englandLeague]);
    expect(countries.map(([country]) => country)).toEqual(["England", "Wales"]);
  });

  it("falls back to 'Other' for a league with no country name", () => {
    const noCountry = league({ externalLeagueId: "600", countryName: null });
    const { countries } = categorizeLeaguesForPicker([noCountry]);
    expect(countries).toEqual([["Other", [noCountry]]]);
  });
});
