/**
 * Integration tests for Phase 2 (local-first football browsing):
 * lib/fixtures/local-browse.ts, lib/fixtures/local-competition-options.ts,
 * lib/actions/fixture-browse.ts, and the spec §8 supported-competition
 * import gate in lib/actions/fixtures.ts. Real production Postgres; the
 * provider is mocked. local-browse.ts has no import of
 * apiFootballProvider at all — the "zero provider calls" assertions below
 * verify that structural guarantee actually holds at runtime, not just at
 * the type level.
 * Run with: pnpm test:integration
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { NormalizedFixture } from "@/lib/sports-data/types";

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

const getFixtureByIdMock = vi.fn<() => Promise<NormalizedFixture | null>>(async () => null);
const getLeagueTypeMock = vi.fn(async () => null);
const searchFixturesByDateRangeMock = vi.fn(async () => []);
const searchFixturesMock = vi.fn(async () => []);
const getSeasonFixturesMock = vi.fn(async () => []);
const getLeagueByIdMock = vi.fn(async () => null);

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    name: "api_football",
    isEnabled: () => true,
    getFixtureById: () => getFixtureByIdMock(),
    getLeagueType: () => getLeagueTypeMock(),
    searchFixturesByDateRange: () => searchFixturesByDateRangeMock(),
    searchFixtures: () => searchFixturesMock(),
    getSeasonFixtures: () => getSeasonFixturesMock(),
    getLeagueById: () => getLeagueByIdMock(),
  },
}));

const { browseFixturesByDateAction, browseFixturesByCompetitionSeasonAction } = await import("@/lib/actions/fixture-browse");
const { importFixturesAction } = await import("@/lib/actions/fixtures");
const { getLocalCompetitionOptions } = await import("@/lib/fixtures/local-competition-options");
const { fetchAllRows } = await import("@/lib/fixtures/local-browse");

// A real, currently-enabled SUPPORTED_COMPETITIONS entry (Premier
// League) — used so `isSupported`/eligibility scoping exercises the real
// config, not a fabricated one. TEST_SEASON is never a real season value,
// which isolates every test fixture from real production Premier League
// data sharing the same competition id.
const SUPPORTED_ID = "39";
const UNSUPPORTED_ID = "555900"; // never in SUPPORTED_COMPETITIONS
const TEST_SEASON = "9999";

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fixtureRow(externalId: string, scheduledStartUtc: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "api_football",
    external_fixture_id: externalId,
    sport: "football",
    competition_external_id: SUPPORTED_ID,
    competition_name: "Premier League",
    competition_country: "England",
    competition_type: "LEAGUE",
    season: TEST_SEASON,
    round: "Round 1",
    home_team_name: "Local Home FC",
    away_team_name: "Local Away FC",
    scheduled_start_utc: scheduledStartUtc,
    internal_status: "NOT_STARTED",
    hidden_from_pool_creation: false,
    ...overrides,
  };
}

function normalizedFixture(overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    provider: "api_football",
    externalFixtureId: "tlfb-800001",
    sport: "football",
    competitionExternalId: UNSUPPORTED_ID,
    competitionName: "Unsupported Test League",
    competitionCountry: "Testland",
    competitionLogoUrl: null,
    season: TEST_SEASON,
    round: "Round 1",
    homeTeamExternalId: "9001",
    homeTeamName: "Gate Home FC",
    homeTeamLogoUrl: null,
    awayTeamExternalId: "9002",
    awayTeamName: "Gate Away FC",
    awayTeamLogoUrl: null,
    venueName: null,
    venueCity: null,
    venueTimezone: null,
    scheduledStartUtc: iso(86_400_000),
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

async function cleanupTestData() {
  // Matched by the "tlfb-" prefix (guaranteed never to collide with a real
  // numeric provider id) rather than by season alone — a real production
  // fixture already existed at bare numeric ids this suite originally used
  // (e.g. "900007", a real 2022-season fixture under an unrelated
  // competition), which silently broke a batch insert containing it. The
  // prefix makes collision structurally impossible; matching cleanup on it
  // also correctly sweeps the one row here that deliberately uses a
  // non-TEST_SEASON season override.
  const { data: fixtureRows } = await admin
    .from("fixtures")
    .select("id")
    .or(`season.eq.${TEST_SEASON},external_fixture_id.like.tlfb-%`);
  const fixtureIds = (fixtureRows ?? []).map((f) => f.id as string);
  if (fixtureIds.length > 0) {
    await admin.from("pools").delete().in("fixture_id", fixtureIds);
  }
  await admin.from("fixtures").delete().eq("season", TEST_SEASON);
  await admin.from("fixtures").delete().like("external_fixture_id", "tlfb-%");
  await admin.from("league_season_imports").delete().eq("season", TEST_SEASON);
  await admin.from("leagues").delete().eq("external_id", UNSUPPORTED_ID);
}

describe.skipIf(!SERVICE_ROLE_KEY)("Phase 2 local-first fixture browsing", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
    await cleanupTestData();
  });

  afterEach(async () => {
    getFixtureByIdMock.mockClear();
    getLeagueTypeMock.mockClear();
    searchFixturesByDateRangeMock.mockClear();
    searchFixturesMock.mockClear();
    getSeasonFixturesMock.mockClear();
    getLeagueByIdMock.mockClear();
    await cleanupTestData();
  });
  afterAll(cleanupTestData);

  describe("fetchAllRows pagination", () => {
    it("follows multiple pages until a short page signals the end — spec §12, no assumption under 1000 rows", async () => {
      const allRows = Array.from({ length: 12 }, (_, i) => i);
      const pages: number[][] = [];
      const rows = await fetchAllRows<number>(
        (from, to) => {
          const page = allRows.slice(from, to + 1);
          pages.push(page);
          return Promise.resolve({ data: page, error: null });
        },
        5, // small page size to force multiple pages over only 12 rows
      );
      expect(rows).toEqual(allRows);
      expect(pages.length).toBe(3); // 5 + 5 + 2
    });

    it("stops immediately on an empty first page", async () => {
      const rows = await fetchAllRows<number>(() => Promise.resolve({ data: [], error: null }), 5);
      expect(rows).toEqual([]);
    });

    it("throws on a page error rather than silently truncating", async () => {
      await expect(fetchAllRows<number>(() => Promise.resolve({ data: null, error: { message: "boom" } }), 5)).rejects.toThrow("boom");
    });
  });

  describe("browseFixturesByDateAction — By date (spec §2/§3/§9)", () => {
    it("Today: returns only fixtures on today's Costa Rica calendar date, correctly converted to UTC boundaries", async () => {
      const now = new Date();
      const crToday = new Date(now.toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
      const inWindow = new Date(crToday);
      inWindow.setHours(12, 0, 0, 0);
      const beforeWindow = new Date(inWindow.getTime() - 25 * 60 * 60 * 1000); // safely a different CR calendar day

      await admin.from("fixtures").insert([
        fixtureRow("tlfb-900001", inWindow.toISOString()),
        fixtureRow("tlfb-900002", beforeWindow.toISOString()),
      ]);

      const result = await browseFixturesByDateAction({ preset: "today" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ids = result.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).toContain("tlfb-900001");
      expect(ids).not.toContain("tlfb-900002");
    });

    it("Tomorrow and Today+Tomorrow presets scope correctly relative to each other", async () => {
      const todayNoonCR = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
      todayNoonCR.setHours(12, 0, 0, 0);
      const tomorrowNoonCR = new Date(todayNoonCR.getTime() + 24 * 60 * 60 * 1000);

      await admin.from("fixtures").insert([
        fixtureRow("tlfb-900003", todayNoonCR.toISOString()),
        fixtureRow("tlfb-900004", tomorrowNoonCR.toISOString()),
      ]);

      const tomorrowOnly = await browseFixturesByDateAction({ preset: "tomorrow" });
      expect(tomorrowOnly.success).toBe(true);
      if (tomorrowOnly.success) {
        const ids = tomorrowOnly.result.fixtures.map((f) => f.externalFixtureId);
        expect(ids).toContain("tlfb-900004");
        expect(ids).not.toContain("tlfb-900003");
      }

      const both = await browseFixturesByDateAction({ preset: "today_tomorrow" });
      expect(both.success).toBe(true);
      if (both.success) {
        const ids = both.result.fixtures.map((f) => f.externalFixtureId);
        expect(ids).toContain("tlfb-900003");
        expect(ids).toContain("tlfb-900004");
      }
    });

    it("custom range: an inclusive from/to window in Costa Rica time", async () => {
      const base = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
      const from = new Date(base.getTime() + 5 * 24 * 60 * 60 * 1000);
      const to = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
      const inside = new Date(from.getTime() + 24 * 60 * 60 * 1000);
      inside.setHours(12, 0, 0, 0);
      const outside = new Date(to.getTime() + 3 * 24 * 60 * 60 * 1000);
      outside.setHours(12, 0, 0, 0);

      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      await admin.from("fixtures").insert([fixtureRow("tlfb-900005", inside.toISOString()), fixtureRow("tlfb-900006", outside.toISOString())]);

      const result = await browseFixturesByDateAction({ preset: "custom", customFromDate: fmt(from), customToDate: fmt(to) });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ids = result.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).toContain("tlfb-900005");
      expect(ids).not.toContain("tlfb-900006");
    });

    it("excludes unsupported-competition fixtures by default, includes them with includeUnsupported: true (spec §3/§16)", async () => {
      const soon = iso(3600_000);
      await admin.from("fixtures").insert([
        fixtureRow("tlfb-900007", soon, { competition_external_id: SUPPORTED_ID }),
        fixtureRow("tlfb-900008", soon, { competition_external_id: UNSUPPORTED_ID, competition_name: "Unsupported League" }),
      ]);

      const preset = "today_tomorrow" as const;
      const scopedResult = await browseFixturesByDateAction({ preset });
      // Window may not cover "soon" depending on time-of-day at test run —
      // use next_7_days for a wide, deterministic window instead.
      void scopedResult;

      const defaultResult = await browseFixturesByDateAction({ preset: "next_7_days" });
      expect(defaultResult.success).toBe(true);
      if (defaultResult.success) {
        const ids = defaultResult.result.fixtures.map((f) => f.externalFixtureId);
        expect(ids).toContain("tlfb-900007");
        expect(ids).not.toContain("tlfb-900008");
      }

      const withUnsupported = await browseFixturesByDateAction({ preset: "next_7_days", includeUnsupported: true });
      expect(withUnsupported.success).toBe(true);
      if (withUnsupported.success) {
        const ids = withUnsupported.result.fixtures.map((f) => f.externalFixtureId);
        expect(ids).toContain("tlfb-900007");
        expect(ids).toContain("tlfb-900008");
        const unsupportedFixture = withUnsupported.result.fixtures.find((f) => f.externalFixtureId === "tlfb-900008");
        expect(unsupportedFixture?.isSupported).toBe(false);
      }
    });

    it("a completed fixture stays visible through a wide range but is never presented as pool-eligible (spec §15)", async () => {
      await admin.from("fixtures").insert(
        fixtureRow("tlfb-900009", iso(3600_000), { internal_status: "COMPLETED", home_score: 2, away_score: 1 }),
      );
      const result = await browseFixturesByDateAction({ preset: "next_7_days" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const fixture = result.result.fixtures.find((f) => f.externalFixtureId === "tlfb-900009");
      expect(fixture).toBeDefined();
      expect(fixture?.statusBucket).toBe("COMPLETED");
      expect(fixture?.eligibility).toBe("COMPLETED");
    });

    it("zero provider calls happen for a normal By-date browse, no matter the preset or filter", async () => {
      await browseFixturesByDateAction({ preset: "today" });
      await browseFixturesByDateAction({ preset: "next_7_days", includeUnsupported: true });
      await browseFixturesByDateAction({ preset: "custom", customFromDate: "2026-01-01", customToDate: "2026-01-02" });
      expect(searchFixturesByDateRangeMock).not.toHaveBeenCalled();
      expect(searchFixturesMock).not.toHaveBeenCalled();
      expect(getFixtureByIdMock).not.toHaveBeenCalled();
      expect(getSeasonFixturesMock).not.toHaveBeenCalled();
      expect(getLeagueByIdMock).not.toHaveBeenCalled();
    });
  });

  describe("browseFixturesByCompetitionSeasonAction — By competition (spec §6/§7)", () => {
    it("returns only the requested competition+season's local fixtures", async () => {
      await admin.from("fixtures").insert([
        fixtureRow("tlfb-900010", iso(3600_000)),
        fixtureRow("tlfb-900011", iso(7200_000), { season: "8888" }), // different season, must not appear
      ]);

      const result = await browseFixturesByCompetitionSeasonAction(SUPPORTED_ID, TEST_SEASON);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ids = result.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).toContain("tlfb-900010");
      expect(ids).not.toContain("tlfb-900011");
    });

    it("rejects an unsupported competition id — no silent bypass", async () => {
      const result = await browseFixturesByCompetitionSeasonAction(UNSUPPORTED_ID, TEST_SEASON);
      expect(result.success).toBe(false);
    });

    it("zero provider calls for a By-competition browse", async () => {
      await browseFixturesByCompetitionSeasonAction(SUPPORTED_ID, TEST_SEASON);
      expect(searchFixturesByDateRangeMock).not.toHaveBeenCalled();
      expect(searchFixturesMock).not.toHaveBeenCalled();
      expect(getSeasonFixturesMock).not.toHaveBeenCalled();
      expect(getLeagueByIdMock).not.toHaveBeenCalled();
    });
  });

  describe("getLocalCompetitionOptions — the By-competition selector (spec §7)", () => {
    it("lists a supported competition as 'not imported' (zero seasons) when it has no IMPORTED league_season_imports row", async () => {
      const options = await getLocalCompetitionOptions();
      const premierLeague = options.find((c) => c.externalLeagueId === SUPPORTED_ID);
      expect(premierLeague).toBeDefined();
      expect(premierLeague?.seasons.every((s) => s.season !== TEST_SEASON)).toBe(true);
    });

    it("lists a season once a matching IMPORTED, non-archived league_season_imports row exists", async () => {
      const { data: league } = await admin
        .from("leagues")
        .insert({ provider: "api_football", external_id: SUPPORTED_ID, name: "Premier League" }, )
        .select("id")
        .maybeSingle();
      const leagueId = league?.id ?? (await admin.from("leagues").select("id").eq("external_id", SUPPORTED_ID).single()).data?.id;
      await admin.from("league_season_imports").insert({
        provider: "api_football",
        external_league_id: SUPPORTED_ID,
        season: TEST_SEASON,
        league_id: leagueId,
        import_status: "IMPORTED",
        fixture_count_imported: 5,
        upcoming_fixture_count: 5,
      });

      const options = await getLocalCompetitionOptions();
      const premierLeague = options.find((c) => c.externalLeagueId === SUPPORTED_ID);
      const season = premierLeague?.seasons.find((s) => s.season === TEST_SEASON);
      expect(season).toBeDefined();
      expect(season?.fixtureCountImported).toBe(5);
    });

    it("never lists an unsupported competition, even with an IMPORTED league_season_imports row", async () => {
      const { data: league } = await admin
        .from("leagues")
        .insert({ provider: "api_football", external_id: UNSUPPORTED_ID, name: "Unsupported League" })
        .select("id")
        .single();
      await admin.from("league_season_imports").insert({
        provider: "api_football",
        external_league_id: UNSUPPORTED_ID,
        season: TEST_SEASON,
        league_id: league!.id,
        import_status: "IMPORTED",
      });

      const options = await getLocalCompetitionOptions();
      expect(options.find((c) => c.externalLeagueId === UNSUPPORTED_ID)).toBeUndefined();
    });
  });

  describe("existing pool indicator and eligibility (spec §14/§15)", () => {
    it("counts pools on a fixture and reflects it in poolCount and the eligible-for-pool-creation view", async () => {
      const { data: league } = await admin
        .from("leagues")
        .insert({ provider: "api_football", external_id: SUPPORTED_ID, name: "Premier League" })
        .select("id")
        .maybeSingle();
      const leagueId = league?.id ?? (await admin.from("leagues").select("id").eq("external_id", SUPPORTED_ID).single()).data?.id;
      await admin.from("league_season_imports").insert({
        provider: "api_football",
        external_league_id: SUPPORTED_ID,
        season: TEST_SEASON,
        league_id: leagueId,
        import_status: "IMPORTED",
        pool_creation_enabled: true,
      });

      const { data: fixture } = await admin
        .from("fixtures")
        .insert(fixtureRow("tlfb-900012", iso(3_600_000)))
        .select("id")
        .single();

      const beforePool = await browseFixturesByCompetitionSeasonAction(SUPPORTED_ID, TEST_SEASON);
      expect(beforePool.success).toBe(true);
      if (beforePool.success) {
        const f = beforePool.result.fixtures.find((x) => x.externalFixtureId === "tlfb-900012");
        expect(f?.poolCount).toBe(0);
        expect(f?.eligibility).toBe("ELIGIBLE");
      }

      await admin.from("pools").insert({
        fixture_id: fixture!.id,
        created_by: FAKE_ADMIN_ID,
        pool_type: "REGULATION_RESULT",
        question: "Local browse test question",
        entry_fee: 100,
        house_fee_bps: 500,
        min_total_entries: 2,
        open_at: new Date().toISOString(),
        locks_at: iso(3_600_000),
        status: "OPEN",
      });

      const afterPool = await browseFixturesByCompetitionSeasonAction(SUPPORTED_ID, TEST_SEASON);
      expect(afterPool.success).toBe(true);
      if (afterPool.success) {
        const f = afterPool.result.fixtures.find((x) => x.externalFixtureId === "tlfb-900012");
        expect(f?.poolCount).toBe(1);
        expect(f?.eligibility).toBe("ELIGIBLE"); // an OPEN pool still leaves it eligible for another
      }
    });

    it("a hidden fixture (hidden_from_pool_creation) shows as LOCKED, not ELIGIBLE or COMPLETED", async () => {
      await admin.from("fixtures").insert(fixtureRow("tlfb-900013", iso(3_600_000), { hidden_from_pool_creation: true }));
      const result = await browseFixturesByDateAction({ preset: "next_7_days" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const f = result.result.fixtures.find((x) => x.externalFixtureId === "tlfb-900013");
      expect(f?.eligibility).toBe("LOCKED");
    });
  });

  describe("supported-competition gate on direct fixture-ID import (spec §8)", () => {
    it("imports a supported-competition fixture normally, with no warning and pool creation not hidden", async () => {
      getFixtureByIdMock.mockResolvedValueOnce(
        normalizedFixture({ externalFixtureId: "tlfb-800001", competitionExternalId: SUPPORTED_ID, competitionName: "Premier League" }),
      );
      const [result] = await importFixturesAction(["tlfb-800001"]);
      expect(result.success).toBe(true);
      expect(result.warning).toBeNull();

      const { data: row } = await admin.from("fixtures").select("hidden_from_pool_creation").eq("external_fixture_id", "tlfb-800001").single();
      expect(row?.hidden_from_pool_creation).toBe(false);
    });

    it("imports an unsupported-competition fixture for inspection, but forces hidden_from_pool_creation and returns a warning — no silent bypass", async () => {
      getFixtureByIdMock.mockResolvedValueOnce(
        normalizedFixture({ externalFixtureId: "tlfb-800002", competitionExternalId: UNSUPPORTED_ID, competitionName: "Unsupported League" }),
      );
      const [result] = await importFixturesAction(["tlfb-800002"]);
      expect(result.success).toBe(true);
      expect(result.warning).not.toBeNull();
      expect(result.warning).toContain("not a supported competition");

      const { data: row } = await admin.from("fixtures").select("hidden_from_pool_creation").eq("external_fixture_id", "tlfb-800002").single();
      expect(row?.hidden_from_pool_creation).toBe(true);
    });
  });
});
