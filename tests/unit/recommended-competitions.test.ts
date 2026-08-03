import { describe, expect, it } from "vitest";
import { buildRecommendedCompetitions, type CatalogLeagueRef } from "@/lib/competitions/manager-data";

const PREMIER_LEAGUE: CatalogLeagueRef = {
  name: "Premier League",
  countryName: "England",
  type: "League",
  logoUrl: "logo.png",
  currentSeasonYear: "2026",
};

// Diagnostic/regression coverage for the real production bug: the
// Recommended tab showed zero competitions because
// competition_availability_cache had never been populated (confirmed
// empty in production — no scheduler has ever called the refresh cron).
// This proves the eligibility logic itself was always correct: once a
// priority league resolves a current season, isn't already imported, and
// has a fresh cache row reporting an upcoming fixture, it appears.
describe("buildRecommendedCompetitions", () => {
  it("recommends a priority league with a current season, no existing import, and a fixture within the recommendation window", () => {
    const result = buildRecommendedCompetitions(
      [{ externalLeagueId: "39", tier: "A" }],
      new Map([["39", PREMIER_LEAGUE]]),
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
    expect(result.recommended[0]).toMatchObject({ externalLeagueId: "39", season: "2026", tier: "A", upcomingFixtureCount: 4 });
    expect(result.priorityLeaguesEligible).toBe(1);
    expect(result.priorityLeaguesAlreadyImported).toBe(0);
    expect(result.oldestCheckedAt).not.toBeNull();
  });

  it("reproduces the actual production bug: an empty cache (no rows at all) yields zero recommendations, even though the league is genuinely eligible", () => {
    const result = buildRecommendedCompetitions(
      [{ externalLeagueId: "39", tier: "A" }],
      new Map([["39", PREMIER_LEAGUE]]),
      new Set(),
      [], // the cache, exactly as found empty in production
    );

    expect(result.recommended).toHaveLength(0);
    // Critically, this is distinguishable from "genuinely nothing to
    // recommend" — the caller can tell the two apart via oldestCheckedAt.
    expect(result.priorityLeaguesEligible).toBe(1);
    expect(result.oldestCheckedAt).toBeNull();
  });

  it("excludes a league already imported for its current season", () => {
    const result = buildRecommendedCompetitions(
      [{ externalLeagueId: "39", tier: "A" }],
      new Map([["39", PREMIER_LEAGUE]]),
      new Set(["39:2026"]),
      [{ externalLeagueId: "39", season: "2026", upcomingFixtureCount: 4, nextFixtureAt: null, checkedAt: new Date().toISOString() }],
    );
    expect(result.recommended).toHaveLength(0);
    expect(result.priorityLeaguesAlreadyImported).toBe(1);
  });

  it("excludes a league with zero fixtures in the recommendation window even when the cache has been checked", () => {
    const result = buildRecommendedCompetitions(
      [{ externalLeagueId: "39", tier: "A" }],
      new Map([["39", PREMIER_LEAGUE]]),
      new Set(),
      [{ externalLeagueId: "39", season: "2026", upcomingFixtureCount: 0, nextFixtureAt: null, checkedAt: new Date().toISOString() }],
    );
    expect(result.recommended).toHaveLength(0);
  });

  it("excludes a league with no resolvable current season from the catalog", () => {
    const result = buildRecommendedCompetitions(
      [{ externalLeagueId: "999", tier: "B" }],
      new Map(), // catalog doesn't have this league at all
      new Set(),
      [],
    );
    expect(result.recommended).toHaveLength(0);
    expect(result.priorityLeaguesEligible).toBe(0);
  });
});
