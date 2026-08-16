/**
 * Regression tests for a real incident: selecting an NFL fixture in the
 * pool-creation wizard could send its API-NFL numeric game ID to
 * API-Football's `/odds` endpoint, because the shared recommendation/
 * markets path (getFixtureQuestionContextAction -> getFixtureMarketsAction)
 * had no sport/provider check at all. The fix is provider-derived routing:
 * every odds/markets action now takes the fixture's own `provider` and
 * refuses (assertProvider, lib/actions/odds.ts) to run against a mismatch,
 * and fixture_odds_cache's identity now includes provider (migration
 * 20260101000116) so a shared numeric ID between the two providers can
 * never collide in the cache.
 * Real local Postgres; provider modules are mocked (spies) so no live
 * network call is ever made. Run with: pnpm test:integration (requires
 * `pnpm supabase:start`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import type { NormalizedFixtureMarkets, NormalizedNflFixtureOdds } from "@/lib/sports-data/types";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

let FAKE_ADMIN_ID: string;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  requireAdminOrAbove: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
}));

const getFixtureOddsMock = vi.fn();
const getFixtureMarketsMock = vi.fn();

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    name: "api_football",
    isEnabled: () => true,
    getFixtureOdds: (...args: unknown[]) => getFixtureOddsMock(...args),
    getFixtureMarkets: (...args: unknown[]) => getFixtureMarketsMock(...args),
  },
}));

const getFixtureRawOddsMock = vi.fn();

vi.mock("@/lib/sports-data/api-nfl-provider", () => ({
  apiNflProvider: {
    name: "api_nfl",
    isEnabled: () => true,
    getFixtureRawOdds: (...args: unknown[]) => getFixtureRawOddsMock(...args),
  },
}));

const { getFixtureGoalsLinesAction, getFixtureMarketsAction, getNflFixtureLinesAction } = await import(
  "@/lib/actions/odds"
);
const { getFixtureQuestionContextAction } = await import("@/lib/actions/pools");

const FOOTBALL_EXTERNAL_ID = "555001";
const NFL_EXTERNAL_ID = "555001"; // deliberately the SAME numeric id as the football fixture above

function footballMarkets(overrides: Partial<NormalizedFixtureMarkets> = {}): NormalizedFixtureMarkets {
  return {
    externalFixtureId: FOOTBALL_EXTERNAL_ID,
    providerUpdatedAt: null,
    matchWinner: [],
    markets: [],
    ...overrides,
  };
}

function nflOdds(overrides: Partial<NormalizedNflFixtureOdds> = {}): NormalizedNflFixtureOdds {
  return {
    externalFixtureId: NFL_EXTERNAL_ID,
    providerUpdatedAt: null,
    // estimateFavorite requires MIN_BOOKS_FOR_ESTIMATE (2) bookmakers with a
    // usable moneyline before it returns a consensus (see nfl-odds.ts) — a
    // single bookmaker here would make estimateNflFixtureLines legitimately
    // return favorite: null, not a bug in the code under test.
    bookmakers: [
      {
        bookmakerId: 1,
        bookmakerName: "TestBook",
        moneyline: [
          { value: "Home", odd: 1.5 },
          { value: "Away", odd: 2.6 },
        ],
        asianHandicap: [],
        gameTotal: [],
        homeTeamTotal: [],
        awayTeamTotal: [],
      },
      {
        bookmakerId: 2,
        bookmakerName: "TestBook2",
        moneyline: [
          { value: "Home", odd: 1.55 },
          { value: "Away", odd: 2.5 },
        ],
        asianHandicap: [],
        gameTotal: [],
        homeTeamTotal: [],
        awayTeamTotal: [],
      },
    ],
    ...overrides,
  };
}

async function cleanupCache() {
  await admin.from("fixture_odds_cache").delete().eq("external_fixture_id", FOOTBALL_EXTERNAL_ID);
  await admin.from("fixture_odds_cache").delete().eq("external_fixture_id", NFL_EXTERNAL_ID);
}

describe.skipIf(!SERVICE_ROLE_KEY)("odds provider routing", () => {
  beforeAll(async () => {
    const { data } = await admin
      .from("user_profiles")
      .select("id")
      .eq("role", "super_admin")
      .eq("is_active", true)
      .limit(1)
      .single();
    FAKE_ADMIN_ID = data!.id as string;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupCache();
  });

  afterAll(cleanupCache);

  it("getFixtureMarketsAction rejects a non-football provider and never calls the football provider", async () => {
    await expect(getFixtureMarketsAction(NFL_EXTERNAL_ID, "api_nfl")).rejects.toThrow(/only supports "api_football"/);
    expect(getFixtureMarketsMock).not.toHaveBeenCalled();
  });

  it("getFixtureGoalsLinesAction rejects a non-football provider and never calls the football provider", async () => {
    await expect(getFixtureGoalsLinesAction(NFL_EXTERNAL_ID, "api_nfl")).rejects.toThrow(/only supports "api_football"/);
    expect(getFixtureOddsMock).not.toHaveBeenCalled();
  });

  it("getNflFixtureLinesAction rejects a non-NFL provider and never calls the NFL provider — football fixture IDs never reach API-NFL", async () => {
    await expect(getNflFixtureLinesAction(FOOTBALL_EXTERNAL_ID, "api_football")).rejects.toThrow(/only supports "api_nfl"/);
    expect(getFixtureRawOddsMock).not.toHaveBeenCalled();
  });

  it("getFixtureQuestionContextAction skips the markets fetch entirely for a non-football fixture — the actual fixed incident", async () => {
    const context = await getFixtureQuestionContextAction("fixture-id-doesnt-matter", NFL_EXTERNAL_ID, "api_nfl", "american_football");
    expect(context).toBeTruthy();
    expect(getFixtureMarketsMock).not.toHaveBeenCalled();
    expect(getFixtureOddsMock).not.toHaveBeenCalled();
  });

  it("getFixtureQuestionContextAction still fetches markets normally for a football fixture", async () => {
    getFixtureMarketsMock.mockResolvedValueOnce(footballMarkets());
    await getFixtureQuestionContextAction("fixture-id-doesnt-matter", FOOTBALL_EXTERNAL_ID, "api_football", "football");
    expect(getFixtureMarketsMock).toHaveBeenCalledWith(FOOTBALL_EXTERNAL_ID);
  });

  it("NFL odds still work during pool creation — correct provider, correct method, real estimate returned", async () => {
    getFixtureRawOddsMock.mockResolvedValueOnce(nflOdds());
    const result = await getNflFixtureLinesAction(NFL_EXTERNAL_ID, "api_nfl");
    expect(getFixtureRawOddsMock).toHaveBeenCalledWith(NFL_EXTERNAL_ID);
    expect(getFixtureMarketsMock).not.toHaveBeenCalled();
    expect(getFixtureOddsMock).not.toHaveBeenCalled();
    expect(result?.favorite?.team).toBe("HOME");
  });

  it("football odds still work during pool creation — correct provider, correct method, cached on success", async () => {
    getFixtureMarketsMock.mockResolvedValueOnce(footballMarkets());
    const result = await getFixtureMarketsAction(FOOTBALL_EXTERNAL_ID, "api_football");
    expect(getFixtureMarketsMock).toHaveBeenCalledWith(FOOTBALL_EXTERNAL_ID);
    expect(getFixtureRawOddsMock).not.toHaveBeenCalled();
    expect(result).toEqual(footballMarkets());

    const { data: cached } = await admin
      .from("fixture_odds_cache")
      .select("provider, external_fixture_id")
      .eq("provider", "api_football")
      .eq("external_fixture_id", FOOTBALL_EXTERNAL_ID)
      .maybeSingle();
    expect(cached).toEqual({ provider: "api_football", external_fixture_id: FOOTBALL_EXTERNAL_ID });
  });

  it("same numeric external ID safely coexists for NFL and football, and cache entries stay isolated by provider", async () => {
    // Seed an NFL-provider cache row directly, same numeric id as the
    // football fixture under test — proves the composite (provider,
    // external_fixture_id) key, not just apiFootballProvider being called
    // with the right id, is what keeps them apart.
    await admin.from("fixture_odds_cache").insert({
      provider: "api_nfl",
      external_fixture_id: NFL_EXTERNAL_ID,
      normalized_markets: { fake: "nfl-shaped-payload-that-must-never-be-returned-for-football" },
    });

    getFixtureMarketsMock.mockResolvedValueOnce(footballMarkets());
    const result = await getFixtureMarketsAction(FOOTBALL_EXTERNAL_ID, "api_football");

    // A cache hit under the wrong provider would have skipped the fetch
    // entirely and returned the seeded NFL payload — neither happened.
    expect(getFixtureMarketsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(footballMarkets());

    const { data: rows } = await admin
      .from("fixture_odds_cache")
      .select("provider, external_fixture_id, normalized_markets")
      .eq("external_fixture_id", FOOTBALL_EXTERNAL_ID)
      .order("provider");
    expect(rows).toHaveLength(2);
    expect(rows?.find((r) => r.provider === "api_nfl")?.normalized_markets).toEqual({
      fake: "nfl-shaped-payload-that-must-never-be-returned-for-football",
    });
    expect(rows?.find((r) => r.provider === "api_football")?.normalized_markets).toEqual(footballMarkets());
  });
});
