import { describe, expect, it } from "vitest";
import { aggregateFixturesByCompetition, buildImportedCompetitionRows } from "@/lib/competitions/manager-data";

const TERMINAL = ["COMPLETED", "CANCELLED", "ABANDONED", "AWARDED"];

describe("aggregateFixturesByCompetition", () => {
  it("finds the next future fixture and flags the activation window correctly", () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    const fixtures = [
      { competitionExternalId: "39", season: "2026", scheduledStartUtc: "2026-08-10T00:00:00Z", internalStatus: "NOT_STARTED" }, // within 14d
      { competitionExternalId: "39", season: "2026", scheduledStartUtc: "2026-09-10T00:00:00Z", internalStatus: "NOT_STARTED" }, // beyond 14d
    ];
    const result = aggregateFixturesByCompetition(fixtures, TERMINAL, now);
    const entry = result.get("39:2026")!;
    expect(entry.nextFixtureAt).toBe("2026-08-10T00:00:00Z");
    expect(entry.hasFixtureWithinActivationWindow).toBe(true);
    expect(entry.allKnownFixturesAreTerminal).toBe(false);
  });

  it("reports no upcoming fixture and no activation window when everything is in the past", () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    const fixtures = [
      { competitionExternalId: "39", season: "2025", scheduledStartUtc: "2026-05-01T00:00:00Z", internalStatus: "COMPLETED" },
    ];
    const result = aggregateFixturesByCompetition(fixtures, TERMINAL, now);
    const entry = result.get("39:2025")!;
    expect(entry.nextFixtureAt).toBeNull();
    expect(entry.hasFixtureWithinActivationWindow).toBe(false);
    expect(entry.allKnownFixturesAreTerminal).toBe(true);
  });

  it("is not 'all terminal' if even one fixture is still not-started", () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    const fixtures = [
      { competitionExternalId: "39", season: "2025", scheduledStartUtc: "2026-01-01T00:00:00Z", internalStatus: "COMPLETED" },
      { competitionExternalId: "39", season: "2025", scheduledStartUtc: "2026-12-01T00:00:00Z", internalStatus: "NOT_STARTED" },
    ];
    const result = aggregateFixturesByCompetition(fixtures, TERMINAL, now);
    expect(result.get("39:2025")!.allKnownFixturesAreTerminal).toBe(false);
  });

  it("groups independently by (league, season) — two seasons of the same league don't mix", () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    const fixtures = [
      { competitionExternalId: "39", season: "2025", scheduledStartUtc: "2026-05-01T00:00:00Z", internalStatus: "COMPLETED" },
      { competitionExternalId: "39", season: "2026", scheduledStartUtc: "2026-08-15T00:00:00Z", internalStatus: "NOT_STARTED" },
    ];
    const result = aggregateFixturesByCompetition(fixtures, TERMINAL, now);
    expect(result.get("39:2025")!.allKnownFixturesAreTerminal).toBe(true);
    expect(result.get("39:2026")!.allKnownFixturesAreTerminal).toBe(false);
    expect(result.get("39:2026")!.hasFixtureWithinActivationWindow).toBe(true);
  });
});

describe("buildImportedCompetitionRows", () => {
  it("joins league metadata, fixture aggregates, and the latest job into one row", () => {
    const lsiRows = [
      {
        id: "lsi-1",
        external_league_id: "39",
        season: "2026",
        league_id: "league-1",
        import_status: "IMPORTED" as const,
        sync_status: "IDLE" as const,
        season_end_date: "2027-05-01",
        last_fixture_discovery_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
        fixture_count_imported: 10,
        upcoming_fixture_count: 10,
        provider_fixture_count: 10,
        pool_creation_enabled: true,
        is_active: true,
      },
    ];
    const leaguesById = new Map([["league-1", { id: "league-1", name: "Premier League", logo_url: "logo.png" }]]);
    const tierByExternalId = new Map([["39", "A" as const]]);
    const countryByExternalId = new Map([["39", "England"]]);
    const typeByExternalId = new Map([["39", "League"]]);
    const fixtureAggregates = aggregateFixturesByCompetition(
      [{ competitionExternalId: "39", season: "2026", scheduledStartUtc: new Date(Date.now() + 5 * 86400_000).toISOString(), internalStatus: "NOT_STARTED" }],
      TERMINAL,
    );
    const latestSeasonByExternalId = new Map([["39", "2026"]]);
    const latestJobs = new Map([["lsi-1", { leagueSeasonImportId: "lsi-1", jobId: "job-1", status: "SUCCEEDED" }]]);

    const rows = buildImportedCompetitionRows(
      lsiRows,
      leaguesById,
      tierByExternalId,
      countryByExternalId,
      typeByExternalId,
      fixtureAggregates,
      latestSeasonByExternalId,
      latestJobs,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Premier League",
      countryName: "England",
      tier: "A",
      importStatus: "IMPORTED",
      operationalStatus: "ACTIVE",
      latestJobId: "job-1",
    });
  });

  it("flags NEWER_SEASON_AVAILABLE when the availability cache reports a season we haven't imported", () => {
    const lsiRows = [
      {
        id: "lsi-1",
        external_league_id: "39",
        season: "2025",
        league_id: "league-1",
        import_status: "IMPORTED" as const,
        sync_status: "IDLE" as const,
        season_end_date: null,
        last_fixture_discovery_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
        fixture_count_imported: 5,
        upcoming_fixture_count: 0,
        provider_fixture_count: 5,
        pool_creation_enabled: true,
        is_active: true,
      },
    ];
    const rows = buildImportedCompetitionRows(
      lsiRows,
      new Map([["league-1", { id: "league-1", name: "Premier League", logo_url: null }]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map([["39", "2026"]]), // the cache says 2026 is now current, but we only have 2025
      new Map(),
    );
    expect(rows[0].needsAttentionReasons).toContain("NEWER_SEASON_AVAILABLE");
    expect(rows[0].operationalStatus).toBe("NEEDS_ATTENTION");
  });
});
