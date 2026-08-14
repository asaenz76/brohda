/**
 * Integration tests for Phase 3 (provider-neutral routing + provider-
 * scoped health/quota): the raw-odds cache, quota reserve, NFL circuit-
 * breaker wiring, team_players' provider-scoped identity, Provider Status
 * zero-live-call guarantee, the manual connectivity test action, and
 * squad-fetch resilience. Real production Postgres; both provider
 * singletons are mocked (see the established pattern in
 * competition-crons.test.ts) — this file proves DB-level and call-count
 * behavior, not live HTTP.
 * Run with: pnpm test:integration
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { NormalizedFixture, NormalizedLeague } from "@/lib/sports-data/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let FAKE_ADMIN_ID: string;

vi.mock("@/lib/auth/session", () => ({
  requireAdminOrAbove: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
  requireSuperAdmin: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
}));

let mockFootballEnabled = true;
let mockNflEnabled = true;
let mockLeagueByIdByProvider: { football: NormalizedLeague | null; nfl: NormalizedLeague | null } = { football: null, nfl: null };
const getSeasonFixturesMock = vi.fn(async (): Promise<NormalizedFixture[]> => []);
const getLeagueByIdFootballMock = vi.fn(async () => mockLeagueByIdByProvider.football);
const getLeagueByIdNflMock = vi.fn(async () => mockLeagueByIdByProvider.nfl);
const getTeamSquadMock = vi.fn(async () => {
  throw new Error("simulated provider outage");
});

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    name: "api_football",
    isEnabled: () => mockFootballEnabled,
    getSeasonFixtures: () => getSeasonFixturesMock(),
    getLeagueById: () => getLeagueByIdFootballMock(),
    getTeamSquad: () => getTeamSquadMock(),
  },
}));

vi.mock("@/lib/sports-data/api-nfl-provider", () => ({
  apiNflProvider: {
    name: "api_nfl",
    isEnabled: () => mockNflEnabled,
    getSeasonFixtures: () => getSeasonFixturesMock(),
    getLeagueById: () => getLeagueByIdNflMock(),
  },
}));

const { getCachedRawOdds, setCachedRawOdds } = await import("@/lib/sports-data/odds-raw-cache");
const { getQuotaReserveStatus, shouldReserveQuota } = await import("@/lib/sports-data/quota-reserve");
const { getProviderStatus } = await import("@/lib/sports-data/provider-gateway");
const { testProviderConnectionAction } = await import("@/lib/actions/provider-health");
const { getTeamSquadAction } = await import("@/lib/actions/squads");
const { runCompetitionDiscoverySync } = await import("@/lib/competitions/discovery-sync");

const TEST_FIXTURE_ID = "777001";
const TEST_REQUEST_TYPE_PREFIX = "phase3-quota-test";
const TEST_TEAM_ID = "777100";

async function cleanup() {
  await admin.from("fixture_odds_raw_cache").delete().eq("external_fixture_id", TEST_FIXTURE_ID);
  await admin.from("provider_request_log").delete().like("request_type", `${TEST_REQUEST_TYPE_PREFIX}%`);
  await admin.from("team_players").delete().eq("team_external_id", TEST_TEAM_ID);
  delete process.env.API_FOOTBALL_DAILY_REQUEST_BUDGET;
  delete process.env.API_NFL_DAILY_REQUEST_BUDGET;
}

describe.skipIf(!SERVICE_ROLE_KEY)("Phase 3 provider infrastructure", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
    await cleanup();
  });

  afterEach(async () => {
    mockFootballEnabled = true;
    mockNflEnabled = true;
    mockLeagueByIdByProvider = { football: null, nfl: null };
    getSeasonFixturesMock.mockClear();
    getLeagueByIdFootballMock.mockClear();
    getLeagueByIdNflMock.mockClear();
    getTeamSquadMock.mockClear();
    await cleanup();
  });
  afterAll(cleanup);

  describe("fixture_odds_raw_cache — provider-aware raw odds cache (spec §14/§15)", () => {
    it("round-trips a set value within the TTL", async () => {
      await setCachedRawOdds("api_football", TEST_FIXTURE_ID, { bookmakers: [{ id: 1 }] });
      const cached = await getCachedRawOdds<{ bookmakers: { id: number }[] }>("api_football", TEST_FIXTURE_ID);
      expect(cached).toEqual({ bookmakers: [{ id: 1 }] });
    });

    it("never collides across providers, even with the identical external fixture id (spec §31 'same numeric external ID across providers')", async () => {
      await setCachedRawOdds("api_football", TEST_FIXTURE_ID, { source: "football" });
      const nflCached = await getCachedRawOdds("api_nfl", TEST_FIXTURE_ID);
      expect(nflCached).toBeNull();

      await setCachedRawOdds("api_nfl", TEST_FIXTURE_ID, { source: "nfl" });
      const footballCached = await getCachedRawOdds<{ source: string }>("api_football", TEST_FIXTURE_ID);
      const nflCachedAfter = await getCachedRawOdds<{ source: string }>("api_nfl", TEST_FIXTURE_ID);
      expect(footballCached?.source).toBe("football");
      expect(nflCachedAfter?.source).toBe("nfl");
    });

    it("treats a stale row (older than the TTL) as a miss", async () => {
      await admin.from("fixture_odds_raw_cache").upsert({
        provider: "api_football",
        external_fixture_id: TEST_FIXTURE_ID,
        raw_response: { stale: true },
        fetched_at: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago, past the 5 min TTL
      });
      const cached = await getCachedRawOdds("api_football", TEST_FIXTURE_ID);
      expect(cached).toBeNull();
    });
  });

  describe("quota reserve (spec §18)", () => {
    it("is inert (always OK, never reserves) when no budget is configured", async () => {
      delete process.env.API_FOOTBALL_DAILY_REQUEST_BUDGET;
      const status = await getQuotaReserveStatus("api_football");
      expect(status.enabled).toBe(false);
      expect(status.level).toBe("OK");
      expect(await shouldReserveQuota("api_football")).toBe(false);
    });

    it("reaches CRITICAL once request volume crosses the configured budget's critical threshold", async () => {
      // A small, self-consistent budget: insert enough of our OWN uniquely-
      // tagged rows that the count alone (real production traffic can only
      // ever ADD to this, never subtract) deterministically crosses the
      // critical threshold, regardless of what else is happening on this
      // provider concurrently.
      process.env.API_FOOTBALL_DAILY_REQUEST_BUDGET = "2";
      const rows = Array.from({ length: 3 }, (_, i) => ({
        provider: "api_football",
        request_type: `${TEST_REQUEST_TYPE_PREFIX}-${i}`,
        duration_ms: 10,
      }));
      await admin.from("provider_request_log").insert(rows);

      const status = await getQuotaReserveStatus("api_football");
      expect(status.enabled).toBe(true);
      expect(status.requestsLast24h).toBeGreaterThanOrEqual(3);
      expect(status.level).toBe("CRITICAL");
      expect(await shouldReserveQuota("api_football")).toBe(true);
    });

    it("a scheduled job stops before spending quota once the reserve is CRITICAL — zero provider calls", async () => {
      process.env.API_FOOTBALL_DAILY_REQUEST_BUDGET = "1";
      await admin.from("provider_request_log").insert([
        { provider: "api_football", request_type: `${TEST_REQUEST_TYPE_PREFIX}-reserve-a`, duration_ms: 10 },
        { provider: "api_football", request_type: `${TEST_REQUEST_TYPE_PREFIX}-reserve-b`, duration_ms: 10 },
      ]);

      await runCompetitionDiscoverySync();
      expect(getSeasonFixturesMock).not.toHaveBeenCalled();
    });
  });

  describe("Provider Status — local-first, zero live calls (spec §6/§23)", () => {
    it("getProviderStatus for both providers never calls either provider adapter", async () => {
      await getProviderStatus(mockFootballEnabled, "api_football");
      await getProviderStatus(mockNflEnabled, "api_nfl");
      expect(getSeasonFixturesMock).not.toHaveBeenCalled();
      expect(getLeagueByIdFootballMock).not.toHaveBeenCalled();
      expect(getLeagueByIdNflMock).not.toHaveBeenCalled();
    });
  });

  describe("manual provider connectivity test (spec §24)", () => {
    it("makes exactly one call, and only when explicitly invoked", async () => {
      mockLeagueByIdByProvider.football = {
        provider: "api_football",
        externalLeagueId: "39",
        name: "Premier League",
        countryName: "England",
        logoUrl: null,
        type: "League",
        seasons: [],
      };
      const result = await testProviderConnectionAction("api_football");
      expect(result.success).toBe(true);
      expect(getLeagueByIdFootballMock).toHaveBeenCalledTimes(1);
      expect(getLeagueByIdNflMock).not.toHaveBeenCalled();
    });

    it("reports failure cleanly (never throws) when the provider call fails", async () => {
      getLeagueByIdFootballMock.mockRejectedValueOnce(new Error("simulated failure"));
      const result = await testProviderConnectionAction("api_football");
      expect(result.success).toBe(false);
      expect(result.message).toContain("simulated failure");
    });

    it("rejects an unknown provider without calling anything", async () => {
      const result = await testProviderConnectionAction("api_basketball");
      expect(result.success).toBe(false);
      expect(getLeagueByIdFootballMock).not.toHaveBeenCalled();
      expect(getLeagueByIdNflMock).not.toHaveBeenCalled();
    });
  });

  describe("team_players — provider-scoped squad cache (spec §12/§26 gap closed)", () => {
    it("the same (team, player) pair can exist independently for two providers with no unique-constraint collision", async () => {
      const { error: footballError } = await admin.from("team_players").insert({
        provider: "api_football",
        team_external_id: TEST_TEAM_ID,
        external_player_id: "1",
        name: "Football Player",
      });
      const { error: nflError } = await admin.from("team_players").insert({
        provider: "api_nfl",
        team_external_id: TEST_TEAM_ID,
        external_player_id: "1",
        name: "NFL Player",
      });
      expect(footballError).toBeNull();
      expect(nflError).toBeNull();

      const { data: rows } = await admin
        .from("team_players")
        .select("provider, name")
        .eq("team_external_id", TEST_TEAM_ID)
        .order("provider");
      expect(rows).toHaveLength(2);
    });
  });

  describe("squad fetch never throws on a real provider failure (spec §11 fix)", () => {
    it("falls back to an empty list instead of leaving the caller's promise unresolved", async () => {
      // getTeamSquadMock is wired to throw — this used to propagate
      // uncaught out of getTeamSquadAction (the bug PlayerPicker hit).
      await expect(getTeamSquadAction(TEST_TEAM_ID, "api_football")).resolves.toEqual([]);
    });

    it("an unsupported provider (no squad_data capability) also resolves cleanly, never calls the provider", async () => {
      await expect(getTeamSquadAction(TEST_TEAM_ID, "api_nfl")).resolves.toEqual([]);
      expect(getTeamSquadMock).not.toHaveBeenCalled();
    });
  });
});
