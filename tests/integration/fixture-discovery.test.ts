/**
 * Integration tests for the date-first fixture discovery feature
 * (lib/fixtures/discovery.ts, lib/fixtures/cache.ts) plus a regression
 * lock on §7 of the spec ("date-based import must reuse the existing
 * per-fixture pipeline and must NOT create a Competition Workspace").
 * Real local Postgres; the provider is either a hand-built fake object
 * (for discovery/cache tests, since searchFixturesForDateWindow takes a
 * provider as an explicit parameter) or the module-level
 * apiFootballProvider singleton mocked (for the importFixturesAction
 * test, which reaches the singleton internally).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { NormalizedFixture, SportsDataProvider } from "@/lib/sports-data/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let FAKE_ADMIN_ID: string;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  requireAdminOrAbove: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
}));

let mockGetFixtureByIdResult: NormalizedFixture | null = null;

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    name: "api_football",
    isEnabled: () => true,
    getFixtureById: async () => mockGetFixtureByIdResult,
    getLeagueType: async () => "League",
  },
}));

const { enrichFixtures, searchFixturesForDateWindow } = await import("@/lib/fixtures/discovery");
const { getCachedFixtureSearch } = await import("@/lib/fixtures/cache");
const { resolveFixtureDateWindow, isDateWindowError } = await import("@/lib/fixtures/date-window");
const { importFixturesAction } = await import("@/lib/actions/fixtures");

const TEST_COMPETITION_ID = "555777"; // unused by any real league — safe to seed/sweep
const PRIORITY_TIER_A_COMPETITION_ID = "39"; // Premier League — real PRIORITY_LEAGUES entry

function normalizedFixture(overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    provider: "api_football",
    externalFixtureId: "700001",
    sport: "football",
    competitionExternalId: TEST_COMPETITION_ID,
    competitionName: "Discovery Test League",
    competitionCountry: "Testland",
    competitionLogoUrl: null,
    season: "2026",
    round: "Round 1",
    homeTeamExternalId: "8001",
    homeTeamName: "Home Test FC",
    homeTeamLogoUrl: null,
    awayTeamExternalId: "8002",
    awayTeamName: "Away Test FC",
    awayTeamLogoUrl: null,
    venueName: "Test Stadium",
    venueCity: null,
    venueTimezone: null,
    scheduledStartUtc: "2026-08-04T18:00:00.000Z",
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
    providerPayload: { fixture: { id: 700001 } },
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<SportsDataProvider> = {}): SportsDataProvider {
  const notImplemented = () => {
    throw new Error("not implemented in this fake");
  };
  return {
    name: "api_football",
    isEnabled: () => true,
    searchFixtures: notImplemented,
    getFixtureById: notImplemented,
    searchLeagues: notImplemented,
    getLeagueById: notImplemented,
    searchTeams: notImplemented,
    getLeagueType: notImplemented,
    getFixtureEvents: notImplemented,
    getTeamSquad: notImplemented,
    getFixtureOdds: notImplemented,
    getFixtureMarkets: notImplemented,
    getSeasonFixtures: notImplemented,
    searchFixturesByDateRange: async () => [],
    ...overrides,
  };
}

async function cleanupTestData() {
  await admin.from("fixture_date_search_cache").delete().eq("competition_external_id", TEST_COMPETITION_ID);
  await admin.from("fixture_date_search_cache").delete().eq("competition_external_id", "");
  await admin.from("fixtures").delete().eq("competition_external_id", TEST_COMPETITION_ID);
  await admin.from("league_season_imports").delete().eq("external_league_id", TEST_COMPETITION_ID);
  await admin.from("leagues").delete().eq("provider", "api_football").eq("external_id", TEST_COMPETITION_ID);
}

describe.skipIf(!SERVICE_ROLE_KEY)("date-first fixture discovery — enrichFixtures", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
    await cleanupTestData();
  });

  afterEach(cleanupTestData);
  afterAll(cleanupTestData);

  it("marks a fixture isImported when a matching (provider, external_fixture_id) row already exists", async () => {
    await admin.from("fixtures").insert({
      provider: "api_football",
      external_fixture_id: "700001",
      competition_external_id: TEST_COMPETITION_ID,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: "2026-08-04T18:00:00.000Z",
      internal_status: "NOT_STARTED",
    });

    const [imported, notImported] = await enrichFixtures(
      [normalizedFixture({ externalFixtureId: "700001" }), normalizedFixture({ externalFixtureId: "700002" })],
      "America/Costa_Rica",
    );

    expect(imported.isImported).toBe(true);
    expect(imported.importedFixtureId).not.toBeNull();
    expect(notImported.isImported).toBe(false);
    expect(notImported.importedFixtureId).toBeNull();
  });

  it("marks hasWorkspace true only when a league_season_imports row matches both competition AND season", async () => {
    const { data: league } = await admin
      .from("leagues")
      .insert({ provider: "api_football", external_id: TEST_COMPETITION_ID, name: "Discovery Test League" })
      .select("id")
      .single();
    await admin.from("league_season_imports").insert({
      provider: "api_football",
      external_league_id: TEST_COMPETITION_ID,
      season: "2026",
      league_id: league!.id,
      coverage_snapshot: { odds: true },
    });

    const [matchingSeason, differentSeason] = await enrichFixtures(
      [normalizedFixture({ externalFixtureId: "700003", season: "2026" }), normalizedFixture({ externalFixtureId: "700004", season: "2027" })],
      "America/Costa_Rica",
    );

    expect(matchingSeason.hasWorkspace).toBe(true);
    expect(matchingSeason.hasOdds).toBe(true); // derived from the matched workspace's coverage_snapshot, zero extra provider calls
    expect(differentSeason.hasWorkspace).toBe(false);
    expect(differentSeason.hasOdds).toBeNull(); // unknown — no matching workspace to read coverage from
  });

  it("leaves hasOdds null when a matching workspace exists but its coverage_snapshot has no odds field", async () => {
    const { data: league } = await admin
      .from("leagues")
      .insert({ provider: "api_football", external_id: TEST_COMPETITION_ID, name: "Discovery Test League" })
      .select("id")
      .single();
    await admin.from("league_season_imports").insert({
      provider: "api_football",
      external_league_id: TEST_COMPETITION_ID,
      season: "2026",
      league_id: league!.id,
      coverage_snapshot: { fixtures: { events: true } },
    });

    const [enriched] = await enrichFixtures([normalizedFixture({ externalFixtureId: "700005", season: "2026" })], "America/Costa_Rica");
    expect(enriched.hasWorkspace).toBe(true);
    expect(enriched.hasOdds).toBeNull();
  });

  it("assigns tier/isPriority from the real PRIORITY_LEAGUES registry, and null/false for an unlisted competition", async () => {
    const [priority, nonPriority] = await enrichFixtures(
      [
        normalizedFixture({ externalFixtureId: "700006", competitionExternalId: PRIORITY_TIER_A_COMPETITION_ID }),
        normalizedFixture({ externalFixtureId: "700007", competitionExternalId: TEST_COMPETITION_ID }),
      ],
      "America/Costa_Rica",
    );
    expect(priority.isPriority).toBe(true);
    expect(priority.tier).toBe("A");
    expect(nonPriority.isPriority).toBe(false);
    expect(nonPriority.tier).toBeNull();
  });

  it("derives localDateKey using the given timezone, not UTC", async () => {
    // 02:00 UTC on Aug 5 is still Aug 4 evening in Costa Rica (UTC-6).
    const [enriched] = await enrichFixtures(
      [normalizedFixture({ externalFixtureId: "700008", scheduledStartUtc: "2026-08-05T02:00:00.000Z" })],
      "America/Costa_Rica",
    );
    expect(enriched.localDateKey).toBe("2026-08-04");
  });
});

describe.skipIf(!SERVICE_ROLE_KEY)("date-first fixture discovery — cache + searchFixturesForDateWindow", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
  });

  afterEach(cleanupTestData);
  afterAll(cleanupTestData);

  it("misses the cache on first search, calls the provider, and writes a cache row", async () => {
    const window = resolveFixtureDateWindow("today", { timeZone: "America/Costa_Rica", now: new Date("2026-08-04T18:00:00.000Z") });
    if (isDateWindowError(window)) throw new Error("expected a window");

    let callCount = 0;
    const provider = fakeProvider({
      searchFixturesByDateRange: async () => {
        callCount++;
        return [normalizedFixture({ externalFixtureId: "700010", scheduledStartUtc: window.utcWindowStart })];
      },
    });

    const result = await searchFixturesForDateWindow(provider, window, { competitionExternalId: TEST_COMPETITION_ID });
    expect(result.error).toBeNull();
    expect(result.fromCache).toBe(false);
    expect(callCount).toBe(1);
    expect(result.fixtures).toHaveLength(1);

    const cached = await getCachedFixtureSearch({
      provider: "api_football",
      timeZone: window.timeZone,
      utcFrom: window.utcWindowStart,
      utcTo: window.utcWindowEnd,
      competitionExternalId: TEST_COMPETITION_ID,
    });
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
  });

  it("hits the cache on a repeat identical search and never calls the provider again", async () => {
    const window = resolveFixtureDateWindow("today", { timeZone: "America/Costa_Rica", now: new Date("2026-08-04T18:00:00.000Z") });
    if (isDateWindowError(window)) throw new Error("expected a window");

    let callCount = 0;
    const provider = fakeProvider({
      searchFixturesByDateRange: async () => {
        callCount++;
        return [normalizedFixture({ externalFixtureId: "700011", scheduledStartUtc: window.utcWindowStart })];
      },
    });

    await searchFixturesForDateWindow(provider, window, { competitionExternalId: TEST_COMPETITION_ID });
    expect(callCount).toBe(1);

    const second = await searchFixturesForDateWindow(provider, window, { competitionExternalId: TEST_COMPETITION_ID });
    expect(callCount).toBe(1); // no second provider call
    expect(second.fromCache).toBe(true);
  });

  it("forceRefresh bypasses a fresh cache entry and re-queries the provider", async () => {
    const window = resolveFixtureDateWindow("today", { timeZone: "America/Costa_Rica", now: new Date("2026-08-04T18:00:00.000Z") });
    if (isDateWindowError(window)) throw new Error("expected a window");

    let callCount = 0;
    const provider = fakeProvider({
      searchFixturesByDateRange: async () => {
        callCount++;
        return [normalizedFixture({ externalFixtureId: "700012", scheduledStartUtc: window.utcWindowStart })];
      },
    });

    await searchFixturesForDateWindow(provider, window, { competitionExternalId: TEST_COMPETITION_ID });
    expect(callCount).toBe(1);

    const forced = await searchFixturesForDateWindow(provider, window, { competitionExternalId: TEST_COMPETITION_ID, forceRefresh: true });
    expect(callCount).toBe(2);
    expect(forced.fromCache).toBe(false);
  });

  it("a provider failure returns an error and never caches a fake empty success", async () => {
    const window = resolveFixtureDateWindow("today", { timeZone: "America/Costa_Rica", now: new Date("2026-08-04T18:00:00.000Z") });
    if (isDateWindowError(window)) throw new Error("expected a window");

    const provider = fakeProvider({
      searchFixturesByDateRange: async () => {
        throw new Error("provider quota exceeded");
      },
    });

    const result = await searchFixturesForDateWindow(provider, window, { competitionExternalId: TEST_COMPETITION_ID });
    expect(result.error).toBe("provider quota exceeded");
    expect(result.fixtures).toEqual([]);

    const cached = await getCachedFixtureSearch({
      provider: "api_football",
      timeZone: window.timeZone,
      utcFrom: window.utcWindowStart,
      utcTo: window.utcWindowEnd,
      competitionExternalId: TEST_COMPETITION_ID,
    });
    expect(cached).toBeNull(); // never written as if it were a valid empty result
  });

  it("cache key differs by competitionExternalId — a filtered and unfiltered search never collide", async () => {
    const window = resolveFixtureDateWindow("today", { timeZone: "America/Costa_Rica", now: new Date("2026-08-04T18:00:00.000Z") });
    if (isDateWindowError(window)) throw new Error("expected a window");

    let callCount = 0;
    const provider = fakeProvider({
      searchFixturesByDateRange: async () => {
        callCount++;
        return [normalizedFixture({ externalFixtureId: "700013", scheduledStartUtc: window.utcWindowStart })];
      },
    });

    await searchFixturesForDateWindow(provider, window, { competitionExternalId: TEST_COMPETITION_ID });
    expect(callCount).toBe(1);

    await searchFixturesForDateWindow(provider, window, {}); // no competition filter — must be a fresh cache miss
    expect(callCount).toBe(2);

    // cleanup the unfiltered ("") row too, since cleanupTestData only sweeps TEST_COMPETITION_ID and ""
  });

  it("cache key differs by timezone — the same UTC window under two timezones never collide", async () => {
    const crWindow = resolveFixtureDateWindow("today", { timeZone: "America/Costa_Rica", now: new Date("2026-08-04T18:00:00.000Z") });
    if (isDateWindowError(crWindow)) throw new Error("expected a window");

    let callCount = 0;
    const provider = fakeProvider({
      searchFixturesByDateRange: async () => {
        callCount++;
        return [normalizedFixture({ externalFixtureId: "700014", scheduledStartUtc: crWindow.utcWindowStart })];
      },
    });

    await searchFixturesForDateWindow(provider, crWindow, { competitionExternalId: TEST_COMPETITION_ID });
    expect(callCount).toBe(1);

    const utcWindow = resolveFixtureDateWindow("today", { timeZone: "UTC", now: new Date("2026-08-04T18:00:00.000Z") });
    if (isDateWindowError(utcWindow)) throw new Error("expected a window");
    await searchFixturesForDateWindow(provider, utcWindow, { competitionExternalId: TEST_COMPETITION_ID });
    expect(callCount).toBe(2); // different timeZone -> different cache key -> real miss
  });
});

describe.skipIf(!SERVICE_ROLE_KEY)("date-based import never creates a Competition Workspace (spec §7)", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
  });

  afterEach(async () => {
    mockGetFixtureByIdResult = null;
    await cleanupTestData();
  });
  afterAll(cleanupTestData);

  it("imports a fixture via the existing per-fixture pipeline without inserting a league_season_imports row", async () => {
    mockGetFixtureByIdResult = normalizedFixture({ externalFixtureId: "700020" });

    const results = await importFixturesAction(["700020"]);
    expect(results[0].success).toBe(true);

    const { data: importedFixture } = await admin.from("fixtures").select("id").eq("external_fixture_id", "700020").maybeSingle();
    expect(importedFixture).not.toBeNull();

    const { data: workspaces } = await admin.from("league_season_imports").select("id").eq("external_league_id", TEST_COMPETITION_ID);
    expect(workspaces ?? []).toHaveLength(0);
  });

  it("prevents a duplicate import of the same (provider, external_fixture_id) via the existing unique constraint", async () => {
    mockGetFixtureByIdResult = normalizedFixture({ externalFixtureId: "700021" });
    const first = await importFixturesAction(["700021"]);
    expect(first[0].success).toBe(true);

    // Re-importing (e.g. the fixture reappears in a later date-range search) upserts the same row rather than erroring or duplicating.
    const second = await importFixturesAction(["700021"]);
    expect(second[0].success).toBe(true);

    const { data: rows } = await admin.from("fixtures").select("id").eq("external_fixture_id", "700021");
    expect(rows ?? []).toHaveLength(1);
  });
});
