import { describe, expect, it } from "vitest";
import {
  computeSeasonState,
  getFullCoverageSummary,
  getPrimaryCoverageSummary,
  resolveDisplaySeason,
} from "@/lib/competitions/catalog-enrichment";
import type { LeagueSeason, LeagueSeasonCoverage } from "@/lib/sports-data/types";

function season(overrides: Partial<LeagueSeason> = {}): LeagueSeason {
  return {
    year: "2026",
    startDate: "2026-08-01",
    endDate: "2027-05-01",
    current: false,
    coverage: null,
    ...overrides,
  };
}

describe("resolveDisplaySeason", () => {
  it("prefers the provider's current:true season over anything else", () => {
    const seasons = [season({ year: "2025", current: false }), season({ year: "2026", current: true })];
    expect(resolveDisplaySeason(seasons)?.year).toBe("2026");
  });

  it("falls back to the nearest future season when nothing is current", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const seasons = [
      season({ year: "2027", startDate: "2027-08-01", endDate: "2028-05-01" }),
      season({ year: "2026", startDate: "2026-08-01", endDate: "2027-05-01" }), // nearer future
    ];
    expect(resolveDisplaySeason(seasons, now)?.year).toBe("2026");
  });

  it("falls back to the most recently completed season when nothing is current or future", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const seasons = [
      season({ year: "2024", startDate: "2024-08-01", endDate: "2025-05-01" }),
      season({ year: "2025", startDate: "2025-08-01", endDate: "2026-05-01" }), // most recently ended
    ];
    expect(resolveDisplaySeason(seasons, now)?.year).toBe("2025");
  });

  it("returns null for a competition with no seasons at all", () => {
    expect(resolveDisplaySeason([])).toBeNull();
  });
});

describe("computeSeasonState", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");

  it("is UNKNOWN when the season has no dates", () => {
    expect(computeSeasonState(null)).toBe("UNKNOWN");
    expect(computeSeasonState(season({ startDate: "", endDate: "" }))).toBe("UNKNOWN");
  });

  it("is UNKNOWN when the date range is contradictory (start after end)", () => {
    expect(computeSeasonState(season({ startDate: "2026-05-01", endDate: "2026-01-01" }))).toBe("UNKNOWN");
  });

  it("is IN_SEASON when today falls within the range and nothing contradicts it", () => {
    const s = season({ startDate: "2026-01-01", endDate: "2026-12-31", current: true });
    expect(computeSeasonState(s, { now })).toBe("IN_SEASON");
  });

  it("does not trust provider_current alone — falls back to OFF_SEASON when both provider_current and known fixtures disagree", () => {
    const s = season({ startDate: "2026-01-01", endDate: "2026-12-31", current: false });
    expect(computeSeasonState(s, { now, hasUpcomingFixtures: false })).toBe("OFF_SEASON");
  });

  it("stays IN_SEASON when provider_current is false but upcoming fixtures are unknown (not a positive contradiction)", () => {
    const s = season({ startDate: "2026-01-01", endDate: "2026-12-31", current: false });
    expect(computeSeasonState(s, { now })).toBe("IN_SEASON");
  });

  it("is STARTS_SOON when the season starts within 45 days", () => {
    const s = season({ startDate: "2026-07-20", endDate: "2027-05-01" }); // ~35 days out from `now`
    expect(computeSeasonState(s, { now })).toBe("STARTS_SOON");
  });

  it("is OFF_SEASON when the next season starts more than 45 days out", () => {
    const s = season({ startDate: "2026-09-01", endDate: "2027-05-01" }); // ~78 days out
    expect(computeSeasonState(s, { now })).toBe("OFF_SEASON");
  });

  it("is RECENTLY_ENDED when the season ended within the last 30 days", () => {
    const s = season({ startDate: "2025-08-01", endDate: "2026-06-01" }); // ended 14 days before `now`
    expect(computeSeasonState(s, { now })).toBe("RECENTLY_ENDED");
  });

  it("is OFF_SEASON when the season ended more than 30 days ago", () => {
    const s = season({ startDate: "2025-01-01", endDate: "2026-01-01" }); // ended ~165 days before `now`
    expect(computeSeasonState(s, { now })).toBe("OFF_SEASON");
  });
});

describe("coverage summaries", () => {
  const fullCoverage: LeagueSeasonCoverage = {
    fixtures: { events: true, lineups: true, statistics_fixtures: false, statistics_players: false },
    standings: true,
    players: true,
    top_scorers: false,
    top_assists: false,
    top_cards: false,
    injuries: false,
    predictions: true,
    odds: true,
  };

  it("returns all UNKNOWN marks when coverage was never checked", () => {
    const summary = getPrimaryCoverageSummary(null);
    expect(summary.every((s) => s.mark === "UNKNOWN")).toBe(true);
  });

  it("maps the 5 primary indicators to their real coverage flags", () => {
    const summary = getPrimaryCoverageSummary(fullCoverage);
    expect(summary).toEqual([
      { label: "Fixtures", mark: "YES" },
      { label: "Events", mark: "YES" },
      { label: "Lineups", mark: "YES" },
      { label: "Players", mark: "YES" },
      { label: "Odds", mark: "YES" },
    ]);
  });

  it("the full summary adds Standings/Injuries/Predictions", () => {
    const summary = getFullCoverageSummary(fullCoverage);
    expect(summary.map((s) => s.label)).toEqual(["Fixtures", "Events", "Lineups", "Players", "Odds", "Standings", "Injuries", "Predictions"]);
    expect(summary.find((s) => s.label === "Injuries")?.mark).toBe("NO");
  });
});
