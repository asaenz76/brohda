/**
 * Integration tests for Phase 4 (Unified Events Admin Experience):
 * lib/fixtures/local-browse.ts's queryLocalEventsByDateWindow and
 * lib/actions/events.ts's browseEventsAction. Real production Postgres;
 * both providers are mocked. Mirrors the structure and discipline of
 * tests/integration/local-fixture-browse.test.ts (Phase 2) — this is a
 * sibling suite for the multi-sport query, not a replacement.
 * Run with: pnpm test:integration
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

let FAKE_ADMIN_ID: string;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  requireAdminOrAbove: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
}));

const searchFixturesMock = vi.fn(async () => []);
const getSeasonFixturesMock = vi.fn(async () => []);
const getLeagueByIdMock = vi.fn(async () => null);
const searchFixturesByDateRangeMock = vi.fn(async () => []);
const getFixtureByIdMock = vi.fn(async () => null);

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    name: "api_football",
    isEnabled: () => true,
    searchFixtures: () => searchFixturesMock(),
    getSeasonFixtures: () => getSeasonFixturesMock(),
    getLeagueById: () => getLeagueByIdMock(),
    searchFixturesByDateRange: () => searchFixturesByDateRangeMock(),
    getFixtureById: () => getFixtureByIdMock(),
  },
}));

const nflGetSeasonFixturesMock = vi.fn(async () => []);
const nflGetLeagueByIdMock = vi.fn(async () => null);
const nflGetFixtureByIdMock = vi.fn(async () => null);

vi.mock("@/lib/sports-data/api-nfl-provider", () => ({
  apiNflProvider: {
    name: "api_nfl",
    isEnabled: () => true,
    getSeasonFixtures: () => nflGetSeasonFixturesMock(),
    getLeagueById: () => nflGetLeagueByIdMock(),
    getFixtureById: () => nflGetFixtureByIdMock(),
  },
}));

const { browseEventsAction } = await import("@/lib/actions/events");

// Real, currently-enabled entries from each sport's own supported-config —
// exercises the real config, not a fabricated one, same convention as
// local-fixture-browse.test.ts.
const SUPPORTED_FOOTBALL_ID = "39"; // Premier League
const UNSUPPORTED_FOOTBALL_ID = "555901"; // never in SUPPORTED_COMPETITIONS
const SUPPORTED_NFL_ID = "1"; // NFL
const TEST_SEASON = "9999";

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function footballFixtureRow(externalId: string, scheduledStartUtc: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "api_football",
    external_fixture_id: externalId,
    sport: "football",
    competition_external_id: SUPPORTED_FOOTBALL_ID,
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

function nflFixtureRow(externalId: string, scheduledStartUtc: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "api_nfl",
    external_fixture_id: externalId,
    sport: "american_football",
    competition_external_id: SUPPORTED_NFL_ID,
    competition_name: "NFL",
    competition_country: null,
    competition_type: null,
    season: TEST_SEASON,
    round: "Regular Season - Week 1",
    home_team_name: "Local Home Team",
    away_team_name: "Local Away Team",
    scheduled_start_utc: scheduledStartUtc,
    internal_status: "NOT_STARTED",
    hidden_from_pool_creation: false,
    ...overrides,
  };
}

async function cleanupTestData() {
  const { data: fixtureRows } = await admin.from("fixtures").select("id").or(`season.eq.${TEST_SEASON},external_fixture_id.like.tlev-%`);
  const fixtureIds = (fixtureRows ?? []).map((f) => f.id as string);
  if (fixtureIds.length > 0) await admin.from("pools").delete().in("fixture_id", fixtureIds);
  await admin.from("fixtures").delete().eq("season", TEST_SEASON);
  await admin.from("fixtures").delete().like("external_fixture_id", "tlev-%");
  await admin.from("league_season_imports").delete().eq("season", TEST_SEASON);
}

describe.skipIf(!SERVICE_ROLE_KEY)("Phase 4 Events browsing (browseEventsAction)", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
    await cleanupTestData();
  });

  afterEach(async () => {
    searchFixturesMock.mockClear();
    getSeasonFixturesMock.mockClear();
    getLeagueByIdMock.mockClear();
    searchFixturesByDateRangeMock.mockClear();
    getFixtureByIdMock.mockClear();
    nflGetSeasonFixturesMock.mockClear();
    nflGetLeagueByIdMock.mockClear();
    nflGetFixtureByIdMock.mockClear();
    await cleanupTestData();
  });
  afterAll(cleanupTestData);

  it("football and NFL fixtures coexist in the same date-window result (spec §6/§35)", async () => {
    const soon = iso(3_600_000);
    await admin.from("fixtures").insert([footballFixtureRow("tlev-100001", soon), nflFixtureRow("tlev-100002", soon)]);

    const result = await browseEventsAction({ preset: "next_7_days" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const ids = result.result.fixtures.map((f) => f.externalFixtureId);
    expect(ids).toContain("tlev-100001");
    expect(ids).toContain("tlev-100002");
    const nflFixture = result.result.fixtures.find((f) => f.externalFixtureId === "tlev-100002");
    expect(nflFixture?.sport).toBe("american_football");
  });

  it("NFL is never excluded by football's supported-competition boundary — its own config is checked (regression for sport-aware isRowSupported)", async () => {
    await admin.from("fixtures").insert(nflFixtureRow("tlev-100003", iso(3_600_000)));
    const result = await browseEventsAction({ preset: "next_7_days" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const fixture = result.result.fixtures.find((f) => f.externalFixtureId === "tlev-100003");
    expect(fixture).toBeDefined();
    expect(fixture?.isSupported).toBe(true);
  });

  it("excludes an unsupported football competition by default, includes it with includeUnsupported: true — while a real NFL fixture in the same window is unaffected either way", async () => {
    const soon = iso(3_600_000);
    await admin.from("fixtures").insert([
      footballFixtureRow("tlev-100004", soon, { competition_external_id: UNSUPPORTED_FOOTBALL_ID, competition_name: "Unsupported League" }),
      nflFixtureRow("tlev-100005", soon),
    ]);

    const defaultResult = await browseEventsAction({ preset: "next_7_days" });
    expect(defaultResult.success).toBe(true);
    if (defaultResult.success) {
      const ids = defaultResult.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).not.toContain("tlev-100004");
      expect(ids).toContain("tlev-100005");
    }

    const withUnsupported = await browseEventsAction({ preset: "next_7_days", includeUnsupported: true });
    expect(withUnsupported.success).toBe(true);
    if (withUnsupported.success) {
      const ids = withUnsupported.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).toContain("tlev-100004");
      expect(ids).toContain("tlev-100005");
    }
  });

  it("sports option scopes the query to only the requested sport(s)", async () => {
    const soon = iso(3_600_000);
    await admin.from("fixtures").insert([footballFixtureRow("tlev-100006", soon), nflFixtureRow("tlev-100007", soon)]);

    const footballOnly = await browseEventsAction({ preset: "next_7_days", sports: ["football"] });
    expect(footballOnly.success).toBe(true);
    if (footballOnly.success) {
      const ids = footballOnly.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).toContain("tlev-100006");
      expect(ids).not.toContain("tlev-100007");
    }

    const nflOnly = await browseEventsAction({ preset: "next_7_days", sports: ["american_football"] });
    expect(nflOnly.success).toBe(true);
    if (nflOnly.success) {
      const ids = nflOnly.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).not.toContain("tlev-100006");
      expect(ids).toContain("tlev-100007");
    }
  });

  it("Today/Tomorrow/Today+Tomorrow presets scope correctly, same Costa Rica boundary math as fixture-browse", async () => {
    const todayNoonCR = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Costa_Rica" }));
    todayNoonCR.setHours(12, 0, 0, 0);
    const tomorrowNoonCR = new Date(todayNoonCR.getTime() + 24 * 60 * 60 * 1000);

    await admin.from("fixtures").insert([footballFixtureRow("tlev-100008", todayNoonCR.toISOString()), nflFixtureRow("tlev-100009", tomorrowNoonCR.toISOString())]);

    const tomorrowOnly = await browseEventsAction({ preset: "tomorrow" });
    expect(tomorrowOnly.success).toBe(true);
    if (tomorrowOnly.success) {
      const ids = tomorrowOnly.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).toContain("tlev-100009");
      expect(ids).not.toContain("tlev-100008");
    }

    const both = await browseEventsAction({ preset: "today_tomorrow" });
    expect(both.success).toBe(true);
    if (both.success) {
      const ids = both.result.fixtures.map((f) => f.externalFixtureId);
      expect(ids).toContain("tlev-100008");
      expect(ids).toContain("tlev-100009");
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
    await admin.from("fixtures").insert([nflFixtureRow("tlev-100010", inside.toISOString()), nflFixtureRow("tlev-100011", outside.toISOString())]);

    const result = await browseEventsAction({ preset: "custom", customFromDate: fmt(from), customToDate: fmt(to) });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const ids = result.result.fixtures.map((f) => f.externalFixtureId);
    expect(ids).toContain("tlev-100010");
    expect(ids).not.toContain("tlev-100011");
  });

  it("a completed event stays visible through a wide range but is never pool-eligible (spec §30)", async () => {
    await admin.from("fixtures").insert(nflFixtureRow("tlev-100012", iso(3_600_000), { internal_status: "COMPLETED" }));
    const result = await browseEventsAction({ preset: "next_7_days" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const fixture = result.result.fixtures.find((f) => f.externalFixtureId === "tlev-100012");
    expect(fixture?.statusBucket).toBe("COMPLETED");
    expect(fixture?.eligibility).toBe("COMPLETED");
  });

  it("counts pools on an event and reflects it in poolCount", async () => {
    const { data: fixture } = await admin.from("fixtures").insert(nflFixtureRow("tlev-100013", iso(3_600_000))).select("id").single();

    const before = await browseEventsAction({ preset: "next_7_days" });
    expect(before.success).toBe(true);
    if (before.success) {
      const f = before.result.fixtures.find((x) => x.externalFixtureId === "tlev-100013");
      expect(f?.poolCount).toBe(0);
    }

    await admin.from("pools").insert({
      fixture_id: fixture!.id,
      created_by: FAKE_ADMIN_ID,
      pool_type: "REGULATION_RESULT",
      question: "Events test question",
      entry_fee: 100,
      house_fee_bps: 500,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: iso(3_600_000),
      status: "OPEN",
    });

    const after = await browseEventsAction({ preset: "next_7_days" });
    expect(after.success).toBe(true);
    if (after.success) {
      const f = after.result.fixtures.find((x) => x.externalFixtureId === "tlev-100013");
      expect(f?.poolCount).toBe(1);
    }
  });

  it("zero provider calls happen for ordinary Events browsing, for either provider, no matter the preset/sport/filter (spec §6)", async () => {
    await browseEventsAction({ preset: "today" });
    await browseEventsAction({ preset: "next_7_days", includeUnsupported: true });
    await browseEventsAction({ preset: "custom", customFromDate: "2026-01-01", customToDate: "2026-01-02" });
    await browseEventsAction({ preset: "next_7_days", sports: ["american_football"] });
    expect(searchFixturesMock).not.toHaveBeenCalled();
    expect(getSeasonFixturesMock).not.toHaveBeenCalled();
    expect(getLeagueByIdMock).not.toHaveBeenCalled();
    expect(searchFixturesByDateRangeMock).not.toHaveBeenCalled();
    expect(getFixtureByIdMock).not.toHaveBeenCalled();
    expect(nflGetSeasonFixturesMock).not.toHaveBeenCalled();
    expect(nflGetLeagueByIdMock).not.toHaveBeenCalled();
    expect(nflGetFixtureByIdMock).not.toHaveBeenCalled();
  });
});
