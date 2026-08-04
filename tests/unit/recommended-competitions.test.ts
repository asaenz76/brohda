import { describe, expect, it } from "vitest";
import { buildRecommendedCompetitions } from "@/lib/competitions/manager-data";
import type { SupportedCompetition } from "@/lib/sports-data/supported-competitions";

const PREMIER_LEAGUE: SupportedCompetition = {
  externalLeagueId: "39",
  name: "Premier League",
  country: "England",
  group: "GLOBAL",
  type: "LEAGUE",
  enabled: true,
};

// Diagnostic/regression coverage for the real production bug: the
// Recommended tab showed zero competitions because
// competition_availability_cache had never been populated (confirmed
// empty in production — no scheduler has ever called the refresh cron).
// This proves the eligibility logic itself was always correct: once a
// supported competition has a cache row reporting a resolved season and
// isn't already imported, and that cache row shows an upcoming fixture,
// it appears — entirely from the DB + static config, no catalog fetch.
describe("buildRecommendedCompetitions", () => {
  it("recommends a supported competition with a cache-resolved season, no existing import, and a fixture within the recommendation window", () => {
    const result = buildRecommendedCompetitions(
      [PREMIER_LEAGUE],
      new Set(), // nothing imported yet
      [
        {
          externalLeagueId: "39",
          season: "2026",
          upcomingFixtureCount: 4,
          nextFixtureAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
          checkedAt: new Date().toISOString(),
        },
      ],
    );

    expect(result.recommended).toHaveLength(1);
    expect(result.recommended[0]).toMatchObject({ externalLeagueId: "39", season: "2026", group: "GLOBAL", upcomingFixtureCount: 4 });
    expect(result.supportedCompetitionsEligible).toBe(1);
    expect(result.supportedCompetitionsAlreadyImported).toBe(0);
    expect(result.oldestCheckedAt).not.toBeNull();
  });

  it("reproduces the actual production bug: an empty cache (no rows at all) yields zero recommendations, even though the competition is genuinely eligible", () => {
    const result = buildRecommendedCompetitions([PREMIER_LEAGUE], new Set(), []); // the cache, exactly as found empty in production

    expect(result.recommended).toHaveLength(0);
    // Critically, this is distinguishable from "genuinely nothing to
    // recommend" — the caller can tell the two apart via oldestCheckedAt.
    expect(result.supportedCompetitionsEligible).toBe(0);
    expect(result.oldestCheckedAt).toBeNull();
  });

  it("excludes a competition already imported for its cache-resolved season", () => {
    const result = buildRecommendedCompetitions(
      [PREMIER_LEAGUE],
      new Set(["39:2026"]),
      [{ externalLeagueId: "39", season: "2026", upcomingFixtureCount: 4, nextFixtureAt: null, checkedAt: new Date().toISOString() }],
    );
    expect(result.recommended).toHaveLength(0);
    expect(result.supportedCompetitionsAlreadyImported).toBe(1);
  });

  it("excludes a competition with zero fixtures in the recommendation window even when the cache has been checked", () => {
    const result = buildRecommendedCompetitions(
      [PREMIER_LEAGUE],
      new Set(),
      [{ externalLeagueId: "39", season: "2026", upcomingFixtureCount: 0, nextFixtureAt: null, checkedAt: new Date().toISOString() }],
    );
    expect(result.recommended).toHaveLength(0);
  });

  it("excludes a competition with no cache row at all (never checked)", () => {
    const result = buildRecommendedCompetitions([{ ...PREMIER_LEAGUE, externalLeagueId: "999" }], new Set(), []);
    expect(result.recommended).toHaveLength(0);
    expect(result.supportedCompetitionsEligible).toBe(0);
  });

  it("skips a disabled or unresolved (null externalLeagueId) entry entirely", () => {
    const unresolved: SupportedCompetition = { externalLeagueId: null, name: "Costa Rica Cup", country: "Costa Rica", group: "COSTA_RICA", type: "CUP", enabled: false };
    const result = buildRecommendedCompetitions([unresolved], new Set(), []);
    expect(result.recommended).toHaveLength(0);
    expect(result.supportedCompetitionsEligible).toBe(0);
  });

  it("sorts recommendations by group (Global before Costa Rica), then name", () => {
    const crCompetition: SupportedCompetition = { externalLeagueId: "162", name: "Primera División", country: "Costa Rica", group: "COSTA_RICA", type: "LEAGUE", enabled: true };
    const laliga: SupportedCompetition = { externalLeagueId: "140", name: "LaLiga", country: "Spain", group: "GLOBAL", type: "LEAGUE", enabled: true };
    const cache = [
      { externalLeagueId: "162", season: "2026", upcomingFixtureCount: 3, nextFixtureAt: null, checkedAt: new Date().toISOString() },
      { externalLeagueId: "140", season: "2026", upcomingFixtureCount: 3, nextFixtureAt: null, checkedAt: new Date().toISOString() },
      { externalLeagueId: "39", season: "2026", upcomingFixtureCount: 3, nextFixtureAt: null, checkedAt: new Date().toISOString() },
    ];
    const result = buildRecommendedCompetitions([crCompetition, laliga, PREMIER_LEAGUE], new Set(), cache);
    expect(result.recommended.map((r) => r.name)).toEqual(["LaLiga", "Premier League", "Primera División"]);
  });
});
