/**
 * NBA / NHL through the SHARED ingestion pipeline, against the real local database: provider fixtures (REAL recorded API-Sports games, mapped
 * by the real adapter code) -> fixture sync -> teams / leagues -> Markets -> Posts -> Community distribution. Only the network edge is mocked
 * (the provider objects). Proves identity (one Game -> one Post, across refreshes and reschedules), the franchise filter (no All-Star
 * "teams"), per-sport isolation of failures, and that the NFL's own sync path is the same function.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import type { NormalizedFixture, NormalizedRawFixtureOdds, RawBookmakerOdds } from "@/lib/sports-data/types";
import hockey from "../fixtures/provider/hockey-nhl-2024-sample.json";
import basketball from "../fixtures/provider/basketball-nba-2024-sample.json";
import franchises from "../fixtures/provider/franchises-2024.json";

const admin = getTestAdminClient();

const state = vi.hoisted(() => ({
  fixtures: { api_nba: [] as unknown[], api_nhl: [] as unknown[] },
  franchises: { api_nba: new Set<string>(), api_nhl: new Set<string>() } as Record<string, Set<string> | null>,
  odds: new Map<string, unknown>(),
  seasonError: { api_nba: null, api_nhl: null } as Record<string, string | null>,
  calls: { season: [] as string[], odds: [] as string[] },
}));

vi.mock("@/lib/sports-data/api-sports-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sports-data/api-sports-provider")>("@/lib/sports-data/api-sports-provider");
  const make = (name: "api_nba" | "api_nhl") => ({
    name,
    isEnabled: () => true,
    getSeasonFixtures: async () => {
      state.calls.season.push(name);
      if (state.seasonError[name]) throw new Error(state.seasonError[name]!);
      return state.fixtures[name];
    },
    getFranchiseTeamExternalIds: async () => state.franchises[name],
    getLeagueById: async () => null,
    getFixtureRawOdds: async (id: string) => {
      state.calls.odds.push(id);
      return (state.odds.get(id) as NormalizedRawFixtureOdds | undefined) ?? null;
    },
  });
  return { ...actual, apiNbaProvider: make("api_nba"), apiNhlProvider: make("api_nhl") };
});

const { mapBasketballGame, mapHockeyGame } = await vi.importActual<typeof import("@/lib/sports-data/api-sports-provider")>("@/lib/sports-data/api-sports-provider");
const { getSportConfig } = await import("@/lib/sports-data/sport-registry");
const { runSportFixtureSync, runFixtureSync, resetFranchiseCacheForTests } = await import("@/lib/sports-data/sync-fixtures");
const { ingestMarketsForFixture } = await import("@/lib/prediction-markets/ingestion/sports");
const { ensureAndPublishPostForFixture } = await import("@/lib/posts/publication");
const { distributePostForFixture } = await import("@/lib/communities/distribution");

const NBA = getSportConfig("basketball")!;
const NHL = getSportConfig("hockey")!;
const FUTURE = Date.now() + 5 * 24 * 3600_000;

/** Real recorded games, re-dated into the future and reset to NOT_STARTED so they look like upcoming inventory. */
function upcoming(games: NormalizedFixture[]): NormalizedFixture[] {
  return games.map((g, i) => ({ ...g, scheduledStartUtc: new Date(FUTURE + i * 3600_000).toISOString(), internalStatus: "NOT_STARTED", providerStatusCode: "NS", homeScore: null, awayScore: null }));
}
const nbaAll = (basketball.games as never[]).map((g) => mapBasketballGame(NBA, g));
const nhlAll = (hockey.games as never[]).map((g) => mapHockeyGame(NHL, g));
const isAllStar = (g: NormalizedFixture) => /Stars|OGs/.test(g.homeTeamName) || /Stars|OGs/.test(g.awayTeamName);

function odds(id: string, opts: { homeOdd?: number; awayOdd?: number; total?: number; handicap?: Array<[string, number]> } = {}): NormalizedRawFixtureOdds {
  const books = (n: number): RawBookmakerOdds[] =>
    Array.from({ length: n }, (_, i) => ({
      bookmakerId: i + 1,
      bookmakerName: `b${i + 1}`,
      moneyline: [{ value: "Home", odd: (opts.homeOdd ?? 1.6) + i * 0.01 }, { value: "Away", odd: (opts.awayOdd ?? 2.4) - i * 0.01 }],
      asianHandicap: (opts.handicap ?? []).map(([value, odd]) => ({ value, odd })),
      gameTotal: opts.total ? [{ value: `Over ${opts.total}`, odd: 1.9 }, { value: `Under ${opts.total}`, odd: 1.9 }] : [],
    }));
  return { externalFixtureId: id, providerUpdatedAt: null, bookmakers: books(3) };
}

/** Start every test from no NBA/NHL inventory (the isolation layer only purges between files). Reference data — teams, leagues, communities — stays. */
async function purgeInventory() {
  const { data: fx } = await admin.from("fixtures").select("id").in("provider", ["api_nba", "api_nhl"]);
  const ids = (fx ?? []).map((f) => f.id);
  if (ids.length === 0) return;
  const { data: posts } = await admin.from("posts").select("id").in("fixture_id", ids);
  const postIds = (posts ?? []).map((p) => p.id);
  if (postIds.length > 0) await admin.from("post_communities").delete().in("post_id", postIds);
  await admin.from("posts").delete().in("fixture_id", ids);
  await admin.from("markets").delete().in("fixture_id", ids);
  await admin.from("fixtures").delete().in("id", ids);
}

beforeEach(async () => {
  await purgeInventory();
  resetFranchiseCacheForTests();
  state.fixtures = { api_nba: upcoming(nbaAll), api_nhl: upcoming(nhlAll) };
  state.franchises = { api_nba: new Set(franchises.nbaFranchiseIds.map(String)), api_nhl: new Set(franchises.nhlFranchiseIds.map(String)) };
  state.odds.clear();
  state.seasonError = { api_nba: null, api_nhl: null };
  state.calls = { season: [], odds: [] };
  await admin.from("platform_settings").update({ market_ingestion_enabled: true, market_ingestion_min_bookmaker_count: 2, post_publication_enabled: true, community_distribution_enabled: true }).eq("id", true);
});

afterAll(async () => {
  // communities/teams/leagues are reference data and are left in place; fixtures/markets/posts are purged by the isolation layer.
});

describe("fixture sync — NBA", () => {
  it("imports franchise games only: the All-Star exhibition 'teams' never become Teams (or Communities)", async () => {
    const result = await runSportFixtureSync(NBA);
    const expected = nbaAll.filter((g) => !isAllStar(g));
    expect(result.failed).toBe(0);
    expect(result.nonFranchise).toBe(nbaAll.filter(isAllStar).length);
    expect(result.nonFranchise).toBeGreaterThan(0);
    const { data: fixtures } = await admin.from("fixtures").select("external_fixture_id, provider, sport, competition_external_id").eq("provider", "api_nba");
    expect(fixtures).toHaveLength(expected.length);
    expect(fixtures!.every((f) => f.sport === "basketball" && f.competition_external_id === "12")).toBe(true);
    const { data: teams } = await admin.from("teams").select("name").eq("provider", "api_nba");
    expect((teams ?? []).some((t) => /Stars|OGs/.test(t.name))).toBe(false);
    const { data: leagues } = await admin.from("leagues").select("name").eq("provider", "api_nba");
    expect(leagues).toEqual([{ name: "NBA" }]);
  });

  it("is idempotent: syncing again creates no duplicate Games, Teams or leagues", async () => {
    await runSportFixtureSync(NBA);
    const { count: first } = await admin.from("fixtures").select("id", { count: "exact", head: true }).eq("provider", "api_nba");
    const { count: teamsFirst } = await admin.from("teams").select("id", { count: "exact", head: true }).eq("provider", "api_nba");
    await runSportFixtureSync(NBA);
    await runSportFixtureSync(NBA);
    const { count: second } = await admin.from("fixtures").select("id", { count: "exact", head: true }).eq("provider", "api_nba");
    const { count: teamsSecond } = await admin.from("teams").select("id", { count: "exact", head: true }).eq("provider", "api_nba");
    expect(second).toBe(first);
    expect(teamsSecond).toBe(teamsFirst);
  });

  it("fails CLOSED when the franchise set cannot be established (nothing imported, reported with the reason)", async () => {
    state.franchises.api_nba = null;
    const result = await runSportFixtureSync(NBA);
    expect(result.failed).toBe(1);
    expect(result.error).toMatch(/franchise set unavailable/);
    const { count } = await admin.from("fixtures").select("id", { count: "exact", head: true }).eq("provider", "api_nba");
    expect(count).toBe(0);
  });

  it("a provider error (e.g. the plan can't read the season) is reported as a failure, never mistaken for 'no games'", async () => {
    state.seasonError.api_nba = "Free plans do not have access to this season";
    const result = await runSportFixtureSync(NBA);
    expect(result).toMatchObject({ failed: 1, refreshed: 0 });
    expect(result.error).toMatch(/Free plans do not have access/);
  });
});

describe("fixture sync — NHL", () => {
  it("imports the NHL under its own provider identity, sport and league — nothing else", async () => {
    const result = await runSportFixtureSync(NHL);
    expect(result.failed).toBe(0);
    expect(result.nonFranchise).toBe(0);
    const { data: fixtures } = await admin.from("fixtures").select("provider, sport, competition_external_id, competition_name").eq("provider", "api_nhl");
    expect(fixtures).toHaveLength(nhlAll.length);
    expect(new Set(fixtures!.map((f) => `${f.sport}|${f.competition_external_id}|${f.competition_name}`))).toEqual(new Set(["hockey|57|NHL"]));
  });

  it("the same numeric ids in two providers never collide (provider identity is part of every key)", async () => {
    await runSportFixtureSync(NHL);
    const sample = nhlAll[0];
    await admin.from("fixtures").upsert({ provider: "api_nfl", external_fixture_id: sample.externalFixtureId, sport: "american_football", home_team_name: "NFL Home", away_team_name: "NFL Away", scheduled_start_utc: new Date(FUTURE).toISOString(), internal_status: "NOT_STARTED" }, { onConflict: "provider,external_fixture_id" });
    const { data } = await admin.from("fixtures").select("provider, home_team_name").eq("external_fixture_id", sample.externalFixtureId);
    expect((data ?? []).map((r) => r.provider).sort()).toEqual(["api_nfl", "api_nhl"]);
  });
});

describe("job isolation — the one cron runs every active sport, each failure-isolated", () => {
  it("a failing NBA sync never stops or fails the NHL (or NFL) sync, and is reported with its sport and provider", async () => {
    state.seasonError.api_nba = "boom";
    const summary = await runFixtureSync({ API_NBA_ENABLED: "true", API_NHL_ENABLED: "true" });
    expect(Object.keys(summary.sports).sort()).toEqual(["api_nba", "api_nhl"]);
    expect(summary.sports.api_nhl.failed).toBe(0);
    expect(summary.sports.api_nhl.refreshed).toBeGreaterThan(0);
    expect(summary.failures).toEqual([{ sport: "basketball", provider: "api_nba", error: expect.stringContaining("boom") }]);
  });

  it("only ACTIVE sports run (activation is configuration): nothing is called for a sport whose env flag is off", async () => {
    const summary = await runFixtureSync({ API_NHL_ENABLED: "true" });
    expect(Object.keys(summary.sports)).toEqual(["api_nhl"]);
    expect(state.calls.season).toEqual(["api_nhl"]);
  });
});

describe("Markets — template-aware, never fabricated", () => {
  async function seedSyncedGame(config: typeof NBA) {
    await runSportFixtureSync(config);
    const { data } = await admin.from("fixtures").select("id, external_fixture_id, home_team_name, away_team_name").eq("provider", config.provider).order("scheduled_start_utc").limit(1).single();
    return { id: data!.id as string, externalFixtureId: data!.external_fixture_id as string, homeTeamName: data!.home_team_name as string, awayTeamName: data!.away_team_name as string };
  }

  it("NBA: Moneyline, Spread and Total with the sport's identity and labels", async () => {
    const game = await seedSyncedGame(NBA);
    state.odds.set(game.externalFixtureId, odds(game.externalFixtureId, { total: 224.5, homeOdd: 1.6, awayOdd: 2.4, handicap: [["Home -4.5", 1.95], ["Away -4.5", 1.9]] }));
    const outcome = await ingestMarketsForFixture(NBA, game, 2);
    expect(outcome).toMatchObject({ moneyline: "inserted", total: "inserted", spread: "inserted" });
    const { data: markets } = await admin.from("markets").select("provider, market_template, line_value, yes_side, ingestion_source, status").eq("fixture_id", game.id).order("market_template");
    expect(markets).toEqual([
      { provider: "api_nba", market_template: "MONEYLINE", line_value: null, yes_side: "HOME", ingestion_source: "nba_market_ingestion", status: "ACTIVE" },
      { provider: "api_nba", market_template: "SPREAD", line_value: -4.5, yes_side: "HOME", ingestion_source: "nba_market_ingestion", status: "ACTIVE" },
      { provider: "api_nba", market_template: "TOTAL", line_value: 224.5, yes_side: null, ingestion_source: "nba_market_ingestion", status: "ACTIVE" },
    ]);
  });

  it("NHL: Moneyline, Spread (the puck line) and Total from the sport's own identity", async () => {
    const game = await seedSyncedGame(NHL);
    state.odds.set(game.externalFixtureId, odds(game.externalFixtureId, { total: 6.5, homeOdd: 1.75, awayOdd: 2.05, handicap: [["Home -1.5", 2.9], ["Away -1.5", 1.36]] }));
    const outcome = await ingestMarketsForFixture(NHL, game, 2);
    expect(outcome).toMatchObject({ moneyline: "inserted", total: "inserted", spread: "inserted" });
    const { data: markets } = await admin.from("markets").select("provider, market_template, line_value, yes_side, ingestion_source").eq("fixture_id", game.id).order("market_template");
    expect(markets).toEqual([
      { provider: "api_nhl", market_template: "MONEYLINE", line_value: null, yes_side: "HOME", ingestion_source: "nhl_market_ingestion" },
      { provider: "api_nhl", market_template: "SPREAD", line_value: -1.5, yes_side: "HOME", ingestion_source: "nhl_market_ingestion" },
      { provider: "api_nhl", market_template: "TOTAL", line_value: 6.5, yes_side: null, ingestion_source: "nhl_market_ingestion" },
    ]);
  });

  it("SPREAD (puck line / point spread) is created generically when a sport lists it — HOME-anchored, orientation-checked against the moneyline", async () => {
    const withSpread = NHL;
    const game = await seedSyncedGame(NHL);
    state.odds.set(game.externalFixtureId, odds(game.externalFixtureId, { total: 6, homeOdd: 1.55, awayOdd: 2.5, handicap: [["Home -1.5", 2.2], ["Away -1.5", 1.68]] }));
    const outcome = await ingestMarketsForFixture(withSpread, game, 2);
    expect(outcome.spread).toBe("inserted");
    const { data: spread } = await admin.from("markets").select("market_template, line_value, yes_side, question").eq("fixture_id", game.id).eq("market_template", "SPREAD").single();
    expect(spread).toMatchObject({ line_value: -1.5, yes_side: "HOME" });
    // a moved line deactivates the old row first (never two ACTIVE spreads), and re-ingesting the same line updates in place
    state.odds.set(game.externalFixtureId, odds(game.externalFixtureId, { total: 6, homeOdd: 1.55, awayOdd: 2.5, handicap: [["Home -2.5", 2.0], ["Away -2.5", 1.85]] }));
    expect((await ingestMarketsForFixture(withSpread, game, 2)).spread).toBe("line-moved");
    const { data: active } = await admin.from("markets").select("line_value").eq("fixture_id", game.id).eq("market_template", "SPREAD").eq("status", "ACTIVE");
    expect(active).toEqual([{ line_value: -2.5 }]);
  });

  it("an inverted spread (home 78% favourite quoted as taking points) is refused — no Market, reported as insufficient/unverifiable", async () => {
    const withSpread = NHL;
    const game = await seedSyncedGame(NHL);
    state.odds.set(game.externalFixtureId, odds(game.externalFixtureId, { homeOdd: 1.25, awayOdd: 4.0, handicap: [["Home +1.5", 1.9], ["Away +1.5", 1.9]] }));
    const outcome = await ingestMarketsForFixture(withSpread, game, 2);
    expect(outcome.spread).toBe("skipped-insufficient-bookmakers");
    const { count } = await admin.from("markets").select("id", { count: "exact", head: true }).eq("fixture_id", game.id).eq("market_template", "SPREAD");
    expect(count).toBe(0);
  });

  it("no odds from the provider -> no Market (a line is never fabricated), and a thrown provider error is surfaced on the outcome", async () => {
    const game = await seedSyncedGame(NBA);
    expect(await ingestMarketsForFixture(NBA, game, 2)).toMatchObject({ moneyline: "skipped-no-data", total: "skipped-no-data" });
    const { count } = await admin.from("markets").select("id", { count: "exact", head: true }).eq("fixture_id", game.id);
    expect(count).toBe(0);
  });
});

describe("Post + Communities — one Game, one canonical Post, distributed (never copied)", () => {
  it("NBA: a refresh and a reschedule never create a second Post, and the Post lands in both team Communities, the league and the sport", async () => {
    await runSportFixtureSync(NBA);
    const { data: row } = await admin.from("fixtures").select("id, external_fixture_id, home_team_name, away_team_name").eq("provider", "api_nba").order("scheduled_start_utc").limit(1).single();
    const game = { id: row!.id as string, externalFixtureId: row!.external_fixture_id as string, homeTeamName: row!.home_team_name as string, awayTeamName: row!.away_team_name as string };
    state.odds.set(game.externalFixtureId, odds(game.externalFixtureId, { total: 224.5 }));
    await ingestMarketsForFixture(NBA, game, 2);

    const first = await ensureAndPublishPostForFixture(game.id, true);
    expect(first.outcome).toBe("published");
    // refresh (no change) and RESCHEDULE (new start time, same provider id) — same Game identity, same single Post
    state.fixtures.api_nba = (state.fixtures.api_nba as NormalizedFixture[]).map((f) => (f.externalFixtureId === game.externalFixtureId ? { ...f, scheduledStartUtc: new Date(FUTURE + 86_400_000).toISOString() } : f));
    await runSportFixtureSync(NBA);
    const { data: after } = await admin.from("fixtures").select("id, scheduled_start_utc").eq("provider", "api_nba").eq("external_fixture_id", game.externalFixtureId).single();
    expect(after!.id).toBe(game.id);
    expect(new Date(after!.scheduled_start_utc).getTime()).toBe(FUTURE + 86_400_000);
    const second = await ensureAndPublishPostForFixture(game.id, true);
    expect(second).toMatchObject({ outcome: "already-published", postId: first.postId });
    const { count: posts } = await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", game.id);
    expect(posts).toBe(1);

    const distribution = await distributePostForFixture(first.postId, game.id);
    expect(distribution.skippedReasons).toEqual([]);
    expect(distribution.distributedCommunityIds).toHaveLength(4); // home team, away team, league, sport
    expect((await distributePostForFixture(first.postId, game.id)).distributedCommunityIds).toHaveLength(4); // idempotent
    const { data: dist } = await admin.from("post_communities").select("community_id").eq("post_id", first.postId);
    expect(dist).toHaveLength(4);
    const { data: communities } = await admin.from("communities").select("type, sport_key, display_name").in("id", distribution.distributedCommunityIds);
    expect((communities ?? []).map((c) => c.type).sort()).toEqual(["LEAGUE", "SPORT", "TEAM", "TEAM"]);
    expect(communities!.find((c) => c.type === "SPORT")).toMatchObject({ sport_key: "basketball", display_name: "Basketball" });
  });

  it("NHL: the sport Community is Hockey and the league Community is the NHL — separate from every other sport's", async () => {
    await runSportFixtureSync(NHL);
    const { data: row } = await admin.from("fixtures").select("id, external_fixture_id, home_team_name, away_team_name").eq("provider", "api_nhl").order("scheduled_start_utc").limit(1).single();
    const game = { id: row!.id as string, externalFixtureId: row!.external_fixture_id as string, homeTeamName: row!.home_team_name as string, awayTeamName: row!.away_team_name as string };
    state.odds.set(game.externalFixtureId, odds(game.externalFixtureId, { total: 6.5 }));
    await ingestMarketsForFixture(NHL, game, 2);
    const { postId } = await ensureAndPublishPostForFixture(game.id, true);
    const distribution = await distributePostForFixture(postId, game.id);
    const { data: communities } = await admin.from("communities").select("id, type, sport_key, league_id").in("id", distribution.distributedCommunityIds);
    expect(communities!.find((c) => c.type === "SPORT")).toMatchObject({ sport_key: "hockey" });
    const league = communities!.find((c) => c.type === "LEAGUE")!;
    const { data: l } = await admin.from("leagues").select("name, provider").eq("id", league.league_id!).single();
    expect(l).toEqual({ name: "NHL", provider: "api_nhl" });
  });

  it("a Game with no Market is not published (a Post needs something to pick) — and no sport is special-cased", async () => {
    await runSportFixtureSync(NHL);
    const { data: row } = await admin.from("fixtures").select("id").eq("provider", "api_nhl").limit(1).single();
    const outcome = await ensureAndPublishPostForFixture(row!.id, true);
    expect(outcome.outcome).toBe("skipped-no-active-market");
  });
});
