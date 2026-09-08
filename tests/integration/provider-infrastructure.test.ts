/**
 * Integration tests for provider-neutral routing + provider-scoped health/
 * quota: the raw-odds cache, quota reserve, NFL circuit-breaker wiring,
 * Provider Status zero-live-call guarantee, and the manual connectivity
 * test action. Real production Postgres; the NFL provider singleton is
 * mocked — this file proves DB-level and call-count behavior, not live
 * HTTP.
 * Run with: pnpm test:integration
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import type { NormalizedFixture, NormalizedLeague } from "@/lib/sports-data/types";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

let FAKE_ADMIN_ID: string;

vi.mock("@/lib/auth/session", () => ({
  requireAdminOrAbove: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
  requireSuperAdmin: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
}));

let mockNflEnabled = true;
let mockNflLeague: NormalizedLeague | null = null;
const getSeasonFixturesMock = vi.fn(async (): Promise<NormalizedFixture[]> => []);
const getLeagueByIdNflMock = vi.fn(async () => mockNflLeague);

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
const { runNflFixtureSync } = await import("@/lib/sports-data/sync-nfl");

const TEST_FIXTURE_ID = "777001";
const TEST_REQUEST_TYPE_PREFIX = "phase3-quota-test";
// provider_request_log is a real, continuously-growing production table
// (millions of rows from real cron traffic, per the original Phase 3
// audit) — deleting by `request_type LIKE '...'` alone has no index to use
// and forces a full scan, which timed out under load once the table grew
// large enough. Bounding by `provider` + `created_at` (the composite index
// added for this) narrows this to a tiny, recent slice before the LIKE
// filter ever runs. Captured once, generously wide (this whole test file
// never runs anywhere near an hour), not re-evaluated per call.
const CLEANUP_SINCE = new Date(Date.now() - 3600_000).toISOString();

async function cleanup() {
  // Every delete's error is checked and thrown — a silently-failed delete
  // here (e.g. a missing service_role grant) doesn't just fail this
  // cleanup, it silently pollutes every later test in this file with stale
  // rows, which is a much more confusing failure to debug than a loud one
  // right here.
  const results = await Promise.all([
    admin.from("fixture_odds_raw_cache").delete().eq("external_fixture_id", TEST_FIXTURE_ID),
    admin
      .from("provider_request_log")
      .delete()
      .eq("provider", "api_nfl")
      .gte("created_at", CLEANUP_SINCE)
      .like("request_type", `${TEST_REQUEST_TYPE_PREFIX}%`),
  ]);
  for (const { error } of results) {
    if (error) throw new Error(`cleanup() failed: ${error.message}`);
  }
  delete process.env.API_NFL_DAILY_REQUEST_BUDGET;
}

describe.skipIf(!SERVICE_ROLE_KEY)("provider infrastructure", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
    await cleanup();
  });

  afterEach(async () => {
    mockNflEnabled = true;
    mockNflLeague = null;
    getSeasonFixturesMock.mockClear();
    getLeagueByIdNflMock.mockClear();
    await cleanup();
  });
  afterAll(cleanup);

  describe("fixture_odds_raw_cache — provider-aware raw odds cache", () => {
    it("round-trips a set value within the TTL", async () => {
      await setCachedRawOdds("api_nfl", TEST_FIXTURE_ID, { bookmakers: [{ id: 1 }] });
      const cached = await getCachedRawOdds<{ bookmakers: { id: number }[] }>("api_nfl", TEST_FIXTURE_ID);
      expect(cached).toEqual({ bookmakers: [{ id: 1 }] });
    });

    it("never collides across providers, even with the identical external fixture id ('same numeric external ID across providers')", async () => {
      // fixture_odds_raw_cache is keyed by (provider, external_fixture_id)
      // — this proves the key genuinely includes provider, not just a
      // second synthetic provider string standing in for a real second
      // adapter (only api_nfl is a real, registered provider today).
      await setCachedRawOdds("api_nfl", TEST_FIXTURE_ID, { source: "nfl" });
      const otherCached = await getCachedRawOdds("some_other_provider", TEST_FIXTURE_ID);
      expect(otherCached).toBeNull();

      await setCachedRawOdds("some_other_provider", TEST_FIXTURE_ID, { source: "other" });
      const nflCached = await getCachedRawOdds<{ source: string }>("api_nfl", TEST_FIXTURE_ID);
      const otherCachedAfter = await getCachedRawOdds<{ source: string }>("some_other_provider", TEST_FIXTURE_ID);
      expect(nflCached?.source).toBe("nfl");
      expect(otherCachedAfter?.source).toBe("other");

      await admin.from("fixture_odds_raw_cache").delete().eq("provider", "some_other_provider").eq("external_fixture_id", TEST_FIXTURE_ID);
    });

    it("treats a stale row (older than the TTL) as a miss", async () => {
      await admin.from("fixture_odds_raw_cache").upsert({
        provider: "api_nfl",
        external_fixture_id: TEST_FIXTURE_ID,
        raw_response: { stale: true },
        fetched_at: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago, past the 5 min TTL
      });
      const cached = await getCachedRawOdds("api_nfl", TEST_FIXTURE_ID);
      expect(cached).toBeNull();
    });
  });

  describe("quota reserve", () => {
    it("is inert (always OK, never reserves) when no budget is configured", async () => {
      delete process.env.API_NFL_DAILY_REQUEST_BUDGET;
      const status = await getQuotaReserveStatus("api_nfl");
      expect(status.enabled).toBe(false);
      expect(status.level).toBe("OK");
      expect(await shouldReserveQuota("api_nfl")).toBe(false);
    });

    it("reaches CRITICAL once request volume crosses the configured budget's critical threshold", async () => {
      // A small, self-consistent budget: insert enough of our OWN uniquely-
      // tagged rows that the count alone (real production traffic can only
      // ever ADD to this, never subtract) deterministically crosses the
      // critical threshold, regardless of what else is happening on this
      // provider concurrently.
      process.env.API_NFL_DAILY_REQUEST_BUDGET = "2";
      const rows = Array.from({ length: 3 }, (_, i) => ({
        provider: "api_nfl",
        request_type: `${TEST_REQUEST_TYPE_PREFIX}-${i}`,
        duration_ms: 10,
      }));
      await admin.from("provider_request_log").insert(rows);

      const status = await getQuotaReserveStatus("api_nfl");
      expect(status.enabled).toBe(true);
      expect(status.requestsLast24h).toBeGreaterThanOrEqual(3);
      expect(status.level).toBe("CRITICAL");
      expect(await shouldReserveQuota("api_nfl")).toBe(true);
    });

    it("a scheduled job stops before spending quota once the reserve is CRITICAL — zero provider calls", async () => {
      process.env.API_NFL_DAILY_REQUEST_BUDGET = "1";
      await admin.from("provider_request_log").insert([
        { provider: "api_nfl", request_type: `${TEST_REQUEST_TYPE_PREFIX}-reserve-a`, duration_ms: 10 },
        { provider: "api_nfl", request_type: `${TEST_REQUEST_TYPE_PREFIX}-reserve-b`, duration_ms: 10 },
      ]);

      await runNflFixtureSync();
      expect(getSeasonFixturesMock).not.toHaveBeenCalled();
    });
  });

  describe("Provider Status — local-first, zero live calls", () => {
    it("getProviderStatus never calls the provider adapter", async () => {
      await getProviderStatus(mockNflEnabled, "api_nfl");
      expect(getSeasonFixturesMock).not.toHaveBeenCalled();
      expect(getLeagueByIdNflMock).not.toHaveBeenCalled();
    });
  });

  describe("manual provider connectivity test", () => {
    it("makes exactly one call, and only when explicitly invoked", async () => {
      mockNflLeague = {
        provider: "api_nfl",
        externalLeagueId: "1",
        name: "NFL",
        countryName: "USA",
        logoUrl: null,
        type: "League",
        seasons: [],
      };
      const result = await testProviderConnectionAction("api_nfl");
      expect(result.success).toBe(true);
      expect(getLeagueByIdNflMock).toHaveBeenCalledTimes(1);
    });

    it("reports failure cleanly (never throws) when the provider call fails", async () => {
      getLeagueByIdNflMock.mockRejectedValueOnce(new Error("simulated failure"));
      const result = await testProviderConnectionAction("api_nfl");
      expect(result.success).toBe(false);
      expect(result.message).toContain("simulated failure");
    });

    it("rejects an unknown provider without calling anything", async () => {
      const result = await testProviderConnectionAction("api_basketball");
      expect(result.success).toBe(false);
      expect(getLeagueByIdNflMock).not.toHaveBeenCalled();
    });
  });
});
