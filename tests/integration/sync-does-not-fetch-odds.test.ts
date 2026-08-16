/**
 * Regression guard for Part A3 of the provider-routing fix: normal
 * scheduled fixture synchronization (both football's runFixtureSync and
 * NFL's runNflFixtureSync) must never fetch odds/markets — that stays an
 * on-demand, pool-creation-time-only operation (lib/actions/odds.ts).
 * Runs each sync function for real against a real local Postgres, with
 * only the two provider singletons mocked (spies, no live network call),
 * and asserts the odds-fetching methods on BOTH providers were never
 * invoked by either sync run.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import type { NormalizedFixture } from "@/lib/sports-data/types";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

const getFixtureOddsMock = vi.fn();
const getFixtureMarketsMock = vi.fn();
const getFixtureByIdMock = vi.fn();

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    name: "api_football",
    isEnabled: () => true,
    getFixtureById: (...args: unknown[]) => getFixtureByIdMock(...args),
    getFixtureOdds: (...args: unknown[]) => getFixtureOddsMock(...args),
    getFixtureMarkets: (...args: unknown[]) => getFixtureMarketsMock(...args),
  },
}));

const getFixtureRawOddsMock = vi.fn();
const getSeasonFixturesMock = vi.fn();
const getLeagueByIdMock = vi.fn();

vi.mock("@/lib/sports-data/api-nfl-provider", () => ({
  apiNflProvider: {
    name: "api_nfl",
    isEnabled: () => true,
    getFixtureRawOdds: (...args: unknown[]) => getFixtureRawOddsMock(...args),
    getSeasonFixtures: (...args: unknown[]) => getSeasonFixturesMock(...args),
    getLeagueById: (...args: unknown[]) => getLeagueByIdMock(...args),
  },
}));

const { runFixtureSync } = await import("@/lib/sports-data/sync");
const { runNflFixtureSync } = await import("@/lib/sports-data/sync-nfl");

const FOOTBALL_TEST_ID = "sync-odds-test-football-1";
const NFL_TEST_ID = "sync-odds-test-nfl-1";

function normalizedFootballFixture(overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    provider: "api_football",
    externalFixtureId: FOOTBALL_TEST_ID,
    sport: "football",
    competitionExternalId: "999999",
    competitionName: "Sync Odds Test League",
    competitionCountry: "Testland",
    competitionLogoUrl: null,
    season: "2026",
    round: "Round 1",
    homeTeamExternalId: "9001",
    homeTeamName: "Home Sync Test FC",
    homeTeamLogoUrl: null,
    awayTeamExternalId: "9002",
    awayTeamName: "Away Sync Test FC",
    awayTeamLogoUrl: null,
    venueName: null,
    venueCity: null,
    venueTimezone: null,
    scheduledStartUtc: new Date(Date.now() + 3600_000).toISOString(),
    providerTimezone: "UTC",
    providerStatusCode: "NS",
    providerStatusDescription: "Not Started",
    internalStatus: "NOT_STARTED",
    elapsedMinutes: null,
    homeScore: null,
    awayScore: null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
    regulationHomeScore: null,
    regulationAwayScore: null,
    extraTimeHomeScore: null,
    extraTimeAwayScore: null,
    penaltyHomeScore: null,
    penaltyAwayScore: null,
    providerPayload: {},
    ...overrides,
  };
}

async function cleanup() {
  await admin.from("fixtures").delete().eq("external_fixture_id", FOOTBALL_TEST_ID).eq("provider", "api_football");
  await admin.from("fixtures").delete().eq("external_fixture_id", NFL_TEST_ID).eq("provider", "api_nfl");
}

describe.skipIf(!SERVICE_ROLE_KEY)("scheduled fixture sync never fetches odds", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    vi.clearAllMocks();
    await cleanup();
  });

  it("runFixtureSync (football) refreshes fixtures without ever calling an odds/markets method", async () => {
    await admin.from("fixtures").insert({
      provider: "api_football",
      external_fixture_id: FOOTBALL_TEST_ID,
      competition_external_id: "999999",
      home_team_name: "Home Sync Test FC",
      away_team_name: "Away Sync Test FC",
      scheduled_start_utc: new Date(Date.now() + 3600_000).toISOString(),
      internal_status: "NOT_STARTED",
      last_synced_at: new Date(Date.now() - 3600_000).toISOString(), // stale enough to be due
    });
    getFixtureByIdMock.mockResolvedValueOnce(normalizedFootballFixture());

    const result = await runFixtureSync();

    expect(result.refreshed).toBeGreaterThanOrEqual(1);
    expect(getFixtureByIdMock).toHaveBeenCalled();
    expect(getFixtureOddsMock).not.toHaveBeenCalled();
    expect(getFixtureMarketsMock).not.toHaveBeenCalled();
    expect(getFixtureRawOddsMock).not.toHaveBeenCalled();
  });

  it("runNflFixtureSync refreshes fixtures without ever calling an odds method (on either provider)", async () => {
    getSeasonFixturesMock.mockResolvedValueOnce([
      {
        provider: "api_nfl",
        externalFixtureId: NFL_TEST_ID,
        sport: "american_football",
        competitionExternalId: "1",
        competitionName: "NFL",
        competitionCountry: "USA",
        competitionLogoUrl: null,
        season: "2026",
        round: "Regular Season - Week 1",
        homeTeamExternalId: "9101",
        homeTeamName: "Home Sync Test NFL",
        homeTeamLogoUrl: null,
        awayTeamExternalId: "9102",
        awayTeamName: "Away Sync Test NFL",
        awayTeamLogoUrl: null,
        venueName: null,
        venueCity: null,
        venueTimezone: null,
        scheduledStartUtc: new Date(Date.now() + 3600_000).toISOString(),
        providerTimezone: "UTC",
        providerStatusCode: "NS",
        providerStatusDescription: "Not Started",
        internalStatus: "NOT_STARTED",
        elapsedMinutes: null,
        homeScore: null,
        awayScore: null,
        halftimeHomeScore: null,
        halftimeAwayScore: null,
        regulationHomeScore: null,
        regulationAwayScore: null,
        extraTimeHomeScore: null,
        extraTimeAwayScore: null,
        penaltyHomeScore: null,
        penaltyAwayScore: null,
        providerPayload: {},
      } satisfies NormalizedFixture,
    ]);

    getLeagueByIdMock.mockResolvedValue(null);

    const result = await runNflFixtureSync();

    expect(result.refreshed).toBe(1);
    expect(getSeasonFixturesMock).toHaveBeenCalled();
    // Whether getLeagueById fires depends on whether an api_nfl `leagues`
    // row already exists (it's only called to refresh season metadata for
    // an existing row — see sync-nfl.ts) — a pre-existing row can leak in
    // from another integration test file sharing this same local DB, so
    // this isn't asserted either way. What matters for this test is that
    // it's never an odds/markets call, on either provider.
    expect(getFixtureRawOddsMock).not.toHaveBeenCalled();
    expect(getFixtureOddsMock).not.toHaveBeenCalled();
    expect(getFixtureMarketsMock).not.toHaveBeenCalled();
  });
});
