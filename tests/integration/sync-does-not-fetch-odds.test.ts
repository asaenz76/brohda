/**
 * Regression guard for the provider-routing fix: normal scheduled fixture
 * synchronization (runNflFixtureSync) must never fetch odds — that stays an
 * on-demand, pool-creation-time-only operation (lib/actions/odds.ts). Runs
 * the sync function for real against a real local Postgres, with only the
 * NFL provider singleton mocked (spies, no live network call), and asserts
 * the odds-fetching method was never invoked by the sync run.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import type { NormalizedFixture } from "@/lib/sports-data/types";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

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

const { runNflFixtureSync } = await import("@/lib/sports-data/sync-nfl");

const NFL_TEST_ID = "sync-odds-test-nfl-1";

async function cleanup() {
  await admin.from("fixtures").delete().eq("external_fixture_id", NFL_TEST_ID).eq("provider", "api_nfl");
}

describe.skipIf(!SERVICE_ROLE_KEY)("scheduled fixture sync never fetches odds", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    vi.clearAllMocks();
    await cleanup();
  });

  it("runNflFixtureSync refreshes fixtures without ever calling an odds method", async () => {
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
    // it's never an odds call.
    expect(getFixtureRawOddsMock).not.toHaveBeenCalled();
  });
});
