/**
 * Brohda 2.1 M3 — deterministic Game Context (migration 217) against the real local Supabase.
 *   - the policy: OFF by default, private to the server, editable only by a Super Admin through ONE audited, idempotent, validated function;
 *   - the loader: three-read batching, season/provider scoping, fail-closed history, no writes anywhere;
 *   - the feed: the line appears only when the policy is on and a fact is proven, and the Game card's Pick controls are byte-identical with it on and off;
 *   - performance on a realistic 30-Game feed.
 * No AI provider, no network: nothing in this file can reach one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedUser, setFixture } from "./helpers/game-seed";
import { getGameContextConfig, getGameContexts, getGameContextPolicyForAdmin, loadGameContexts } from "@/lib/game-context/repository";
import { DISABLED_GAME_CONTEXT, GAME_CONTEXT_DEFAULTS } from "@/lib/game-context/config";
import { getSocialFeed } from "@/lib/communities/feed";
import { ensureAndPublishPostForFixture } from "@/lib/posts/publication";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ENABLED = { enabled: true, ...GAME_CONTEXT_DEFAULTS };

const resetPolicy = async () => {
  const { error } = await admin.from("platform_settings").update({ game_context_enabled: false, game_context_config: null }).eq("id", true);
  if (error) throw error;
};
beforeEach(resetPolicy);
afterEach(resetPolicy);

let staffId: string | null = null;
async function superAdmin() {
  if (!staffId) {
    staffId = await seedUser("gc-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
}
const setPolicy = (adminId: string | null, p_enabled: boolean | null, p_config: unknown = null) => admin.rpc("admin_set_game_context_policy", { p_admin_id: adminId, p_enabled, p_config });

const NFL = { provider: "api_nfl", sport: "american_football", season: "2026" };
// Week n is n weeks after 120 days ago, so history (weeks 1-10) is always in the past and the Game under test (tomorrow, or week 40+) always after it, whatever day the suite runs.
const BASE = Date.now() - 120 * 86_400_000;
let seq = 0;
interface SeedGame { home: string; away: string; week: number; status?: string; round?: string; season?: string; provider?: string; sport?: string; scores?: [number | null, number | null]; names?: [string, string] }
/** Inserts stored Games directly (`fixtures`), exactly as the provider sync leaves them. */
async function seedGames(games: SeedGame[]): Promise<string[]> {
  const rows = games.map((g) => ({
    provider: g.provider ?? NFL.provider,
    external_fixture_id: `gc-${randomUUID()}-${++seq}`,
    sport: g.sport ?? NFL.sport,
    season: g.season ?? NFL.season,
    round: g.round ?? `Regular Season - Week ${g.week}`,
    home_team_external_id: g.home,
    away_team_external_id: g.away,
    home_team_name: g.names?.[0] ?? `Team ${g.home}`,
    away_team_name: g.names?.[1] ?? `Team ${g.away}`,
    scheduled_start_utc: new Date(BASE + g.week * 7 * 86_400_000).toISOString(),
    internal_status: g.status ?? "COMPLETED",
    home_score: g.scores ? g.scores[0] : (g.status ?? "COMPLETED") === "COMPLETED" ? 24 : null,
    away_score: g.scores ? g.scores[1] : (g.status ?? "COMPLETED") === "COMPLETED" ? 17 : null,
  }));
  const { data, error } = await admin.from("fixtures").insert(rows).select("id");
  if (error) throw error;
  return (data as Row[]).map((r) => r.id);
}
/** A team's season as results, home every time: W = it wins 24–17, L = it loses 17–24. Fresh opponents. */
const form = (team: string, results: string, startWeek = 1, names?: string): SeedGame[] =>
  [...results].map((r, i) => ({ home: team, away: `${team}-o${startWeek + i}`, week: startWeek + i, scores: (r === "W" ? [24, 17] : [17, 24]) as [number, number], names: names ? [names, `Opp ${team}-o${startWeek + i}`] : undefined }));
const upcomingGame = (home: string, away: string, names?: [string, string]): SeedGame => ({ home, away, week: 40, status: "NOT_STARTED", names });

async function snapshot() {
  const [fixtures, markets, posts, predictions] = await Promise.all(
    ["fixtures", "markets", "posts", "predictions"].map(async (t) => (await admin.from(t).select("*")).data as Row[]),
  );
  return JSON.stringify({ fixtures: fixtures.map((r) => [r.id, r.updated_at]).sort(), markets: markets.map((r) => [r.id, r.updated_at]).sort(), posts: posts.map((r) => [r.id, r.updated_at]).sort(), predictions: predictions.length });
}

describe("the policy", () => {
  it("is OFF by default, with no thresholds stored", async () => {
    const { data } = await admin.from("platform_settings").select("game_context_enabled, game_context_config").eq("id", true).single();
    expect(data).toEqual({ game_context_enabled: false, game_context_config: null });
    expect(await getGameContextConfig()).toEqual(DISABLED_GAME_CONTEXT);
  });

  it("is private to the server: client roles can neither read the columns nor call the function", async () => {
    const anon = getTestAnonClient();
    const read = await anon.from("platform_settings").select("game_context_enabled");
    expect(read.data ?? []).toEqual([]);
    const fn = await anon.rpc("admin_set_game_context_policy", { p_admin_id: randomUUID(), p_enabled: true, p_config: null });
    expect(fn.error).not.toBeNull();
    const pub = await anon.from("public_platform_settings").select("*");
    expect(Object.keys((pub.data as Row[])[0] ?? {})).toEqual(["registration_enabled"]);
  });

  it("only a Super Admin can change it", async () => {
    const player = await seedUser("gc-player");
    const ordinaryAdmin = await seedUser("gc-plain-admin");
    await admin.from("user_profiles").update({ role: "admin" }).eq("id", ordinaryAdmin);
    for (const who of [null, randomUUID(), player, ordinaryAdmin]) {
      const r = await setPolicy(who, true);
      expect(r.error?.message, String(who)).toContain("not_authorized");
    }
    expect((await getGameContextConfig()).enabled).toBe(false);
  });

  it("a Super Admin turns it on and off; every change is audited with before and after; a repeat writes nothing", async () => {
    const id = await superAdmin();
    const before = (await admin.from("audit_logs").select("id").eq("action", "settings.game_context_policy_updated")).data?.length ?? 0;
    expect((await setPolicy(id, true)).error).toBeNull();
    expect((await getGameContextConfig()).enabled).toBe(true);
    expect((await setPolicy(id, true)).error).toBeNull(); // idempotent
    expect((await setPolicy(id, false)).error).toBeNull();
    expect((await getGameContextConfig()).enabled).toBe(false);
    const { data: logs } = await admin.from("audit_logs").select("before, after, actor_id").eq("action", "settings.game_context_policy_updated").order("created_at");
    expect((logs?.length ?? 0) - before).toBe(2);
    const [on, off] = (logs as Row[]).slice(-2);
    expect(on.after.game_context_enabled).toBe(true);
    expect(on.before.game_context_enabled).toBe(false);
    expect(off.after.game_context_enabled).toBe(false);
    expect(on.actor_id).toBe(id);
  });

  it("thresholds: valid values apply, {} resets to the defaults, and the switch keeps its value when only thresholds change", async () => {
    const id = await superAdmin();
    await setPolicy(id, true, { min_win_streak: 4, pairs_enabled: false });
    expect(await getGameContextConfig()).toMatchObject({ enabled: true, minWinStreak: 4, pairsEnabled: false, minLossStreak: 3 });
    await setPolicy(id, null, { max_chars: 100 });
    expect(await getGameContextConfig()).toMatchObject({ enabled: true, maxChars: 100, minWinStreak: 3, pairsEnabled: true }); // replaced, not merged
    await setPolicy(id, null, {});
    expect(await getGameContextConfig()).toEqual({ enabled: true, ...GAME_CONTEXT_DEFAULTS });
  });

  it("the card sees the stored thresholds even while the feature is off", async () => {
    const id = await superAdmin();
    await setPolicy(id, false, { min_win_streak: 5 });
    expect(await getGameContextConfig()).toEqual(DISABLED_GAME_CONTEXT);
    expect(await getGameContextPolicyForAdmin()).toMatchObject({ enabled: false, minWinStreak: 5 });
  });

  it.each([
    ["an unknown key", { surprise: 1 }],
    ["a string number", { min_win_streak: "4" }],
    ["a float", { min_win_streak: 3.5 }],
    ["below range", { min_win_streak: 1 }],
    ["above range", { max_chars: 201 }],
    ["a wrong type for a switch", { pairs_enabled: "yes" }],
    ["a decisive count above the window", { last_n: 5, last_n_min_decisive: 6 }],
    ["a decisive count that is not a majority", { last_n: 10, last_n_min_decisive: 5 }],
    ["an array", [1, 2]],
    ["a bare number", 3],
  ])("the database refuses %s and changes nothing", async (_name, config) => {
    const id = await superAdmin();
    await setPolicy(id, true, { min_win_streak: 4 });
    const r = await setPolicy(id, false, config);
    expect(r.error?.message).toContain("invalid_config");
    expect(await getGameContextConfig()).toMatchObject({ enabled: true, minWinStreak: 4 });
  });

  it("a config the database would refuse but someone wrote directly still turns the feature OFF (the application parses fail-closed)", async () => {
    await admin.from("platform_settings").update({ game_context_enabled: true, game_context_config: { min_win_streak: "x" } }).eq("id", true);
    expect(await getGameContextConfig()).toEqual(DISABLED_GAME_CONTEXT);
  });
});

/** Fresh team ids per test: stored Games persist for the whole file, so a test must never share a team with another. */
const tid = () => `t${randomUUID().slice(0, 8)}`;

describe("the loader", () => {
  it("proves a fact from stored Games and cites them", async () => {
    const [A, B] = [tid(), tid()];
    const games = await seedGames([...form(A, "LWWWWW", 1, "Alpha Aces"), ...form(B, "WLLLL", 1, "Bravo Bears"), upcomingGame(A, B, ["Alpha Aces", "Bravo Bears"])]);
    const target = games[games.length - 1];
    const { contexts, stats } = await loadGameContexts([target], ENABLED);
    const c = contexts.get(target)!;
    expect(c.text).toBe("Alpha Aces have won 5 straight. Bravo Bears have lost 4 straight.");
    expect(c.supportingFixtureIds).toHaveLength(9);
    // every cited Game is a real stored Game
    const { data } = await admin.from("fixtures").select("id").in("id", [...c.supportingFixtureIds]);
    expect((data ?? []).length).toBe(9);
    expect(stats.queries).toBeLessThanOrEqual(3);
  });

  it("does nothing at all while the policy is off: no query, no line", async () => {
    const [A, Z] = [tid(), tid()];
    const games = await seedGames([...form(A, "LWWWWW"), upcomingGame(A, Z)]);
    const { contexts, stats } = await loadGameContexts([games[games.length - 1]], DISABLED_GAME_CONTEXT);
    expect(contexts.size).toBe(0);
    expect(stats).toEqual({ queries: 0, rows: 0, targets: 0, withContext: 0 });
    expect((await getGameContexts([games[games.length - 1]])).size).toBe(0);
  });

  it("goes through the stored policy when called the way the feed calls it", async () => {
    const [A, Z] = [tid(), tid()];
    const games = await seedGames([...form(A, "LWWWW", 1, "Alpha Aces"), upcomingGame(A, Z, ["Alpha Aces", "Zed Zebras"])]);
    const target = games[games.length - 1];
    expect((await getGameContexts([target])).size).toBe(0);
    await setPolicy(await superAdmin(), true);
    expect((await getGameContexts([target])).get(target)?.text).toBe("Alpha Aces have won 4 straight. Zed Zebras are trying to stop the streak.");
  });

  it("never mixes seasons, providers, or preseason: only the current regular season counts", async () => {
    const [A, Z] = [tid(), tid()];
    const games = await seedGames([
      ...form(A, "WWWWWWWW", 1).map((g) => ({ ...g, season: "2025" })),
      ...form(A, "WWWWWWWW", 1).map((g) => ({ ...g, provider: "api_nba" })),
      ...form(A, "WWWWWWWW", 1).map((g) => ({ ...g, round: `Pre Season - Week ${g.week}` })),
      ...form(A, "LWW", 20),
      upcomingGame(A, Z),
    ]);
    expect((await loadGameContexts([games[games.length - 1]], ENABLED)).contexts.size).toBe(0);
  });

  it("a Game whose result is not known before the target makes the fact unprovable; a cancelled one does not", async () => {
    const [A, Z, Q] = [tid(), tid(), tid()];
    const stale = await seedGames([...form(A, "LWWWW"), { home: A, away: Q, week: 3.5, status: "NOT_STARTED" }, upcomingGame(A, Z)]);
    expect((await loadGameContexts([stale[stale.length - 1]], ENABLED)).contexts.size).toBe(0);
    const [A2, Z2, Q2] = [tid(), tid(), tid()];
    const ok = await seedGames([...form(A2, "LWWWW", 1, "Alpha Aces"), { home: A2, away: Q2, week: 3.5, status: "CANCELLED" }, upcomingGame(A2, Z2, ["Alpha Aces", "Zed Zebras"])]);
    expect((await loadGameContexts([ok[ok.length - 1]], ENABLED)).contexts.get(ok[ok.length - 1])?.primaryFact.values.streak).toBe(4);
  });

  it("a Game that has started, a Game of a sport with no stored regular-season marker, and an unknown Game id all yield nothing", async () => {
    const [A, B, C, D] = [tid(), tid(), tid(), tid()];
    const [started] = await seedGames([{ home: A, away: B, week: 40, status: "LIVE" }]);
    const [basketball] = await seedGames([{ home: C, away: D, week: 40, status: "NOT_STARTED", provider: "api_nba", sport: "basketball" }]);
    const { contexts } = await loadGameContexts([started, basketball, randomUUID()], ENABLED);
    expect(contexts.size).toBe(0);
  });

  it("is read-only: it changes no Game, Market, Post or Pick", async () => {
    const [A, Z] = [tid(), tid()];
    await seedGame({ homeName: "Seed Home", awayName: "Seed Away" });
    const games = await seedGames([...form(A, "LWWWW"), upcomingGame(A, Z)]);
    const before = await snapshot();
    await loadGameContexts([games[games.length - 1]], ENABLED);
    expect(await snapshot()).toBe(before);
  });

  it("rejects a team id that is not a plain provider id instead of building a filter from it", async () => {
    const A = tid();
    const games = await seedGames([...form(A, "LWWWW"), upcomingGame(A, "t),or(id.neq.0")]);
    const { contexts } = await loadGameContexts([games[games.length - 1]], ENABLED);
    const c = contexts.get(games[games.length - 1]);
    expect(c?.primaryFact.values.streak).toBe(4); // A's own line is unaffected...
    expect(c?.secondaryFact).toBeNull(); // ...and the unsafe id contributed nothing
  });
});

describe("the feed", () => {
  async function publishedGame(history: SeedGame[], home: string, away: string, names: [string, string]) {
    const { fixtureId } = await seedGame({ homeName: names[0], awayName: names[1] });
    await setFixture(fixtureId, { season: "2026", round: "Regular Season - Week 40", home_team_external_id: home, away_team_external_id: away });
    await seedGames(history);
    await ensureAndPublishPostForFixture(fixtureId, true);
    return fixtureId;
  }
  const itemFor = async (fixtureId: string) => (await getSocialFeed(null)).find((i) => i.post.fixtureId === fixtureId);

  it("shows the line when on, shows nothing when off, and leaves every Pick control exactly as it was", async () => {
    const [A, Z] = [tid(), tid()];
    const fixtureId = await publishedGame(form(A, "LWWWW", 1, "Alpha Aces"), A, Z, ["Alpha Aces", "Zed Zebras"]);
    const off = await itemFor(fixtureId);
    expect(off?.gameContext ?? null).toBeNull();
    await setPolicy(await superAdmin(), true);
    const on = await itemFor(fixtureId);
    expect(on?.gameContext?.text).toBe("Alpha Aces have won 4 straight. Zed Zebras are trying to stop the streak.");
    // the Game, its primary Market and everything a Member can do are untouched by the line
    const { gameContext: _a, ...offRest } = off!;
    const { gameContext: _b, ...onRest } = on!;
    void _a;
    void _b;
    expect(JSON.stringify(onRest)).toBe(JSON.stringify(offRest));
    expect(on?.primaryMarket).not.toBeNull();
  });

  it("a Game with no provable fact has no line and an otherwise normal card", async () => {
    const [A, Z] = [tid(), tid()];
    const fixtureId = await publishedGame(form(A, "WLWLW", 1, "Alpha Aces"), A, Z, ["Alpha Aces", "Zed Zebras"]);
    await setPolicy(await superAdmin(), true);
    const item = await itemFor(fixtureId);
    expect(item).toBeDefined();
    expect(item?.gameContext ?? null).toBeNull();
    expect(item?.primaryMarket).not.toBeNull();
  });

  it("an invalid stored policy means no lines and a working feed", async () => {
    const [A, Z] = [tid(), tid()];
    const fixtureId = await publishedGame(form(A, "LWWWW", 1, "Alpha Aces"), A, Z, ["Alpha Aces", "Zed Zebras"]);
    await admin.from("platform_settings").update({ game_context_enabled: true, game_context_config: { max_chars: 5 } }).eq("id", true);
    const item = await itemFor(fixtureId);
    expect(item).toBeDefined();
    expect(item?.gameContext ?? null).toBeNull();
  });
});

describe("performance: a realistic 30-Game feed", () => {
  it("is a bounded number of reads however many Games, and fast", async () => {
    // 32 teams, 10 finished Games each (320 Games), then 30 upcoming Games across two weeks (team ids repeat, as they do in a real feed).
    const teams = Array.from({ length: 32 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);
    const history: SeedGame[] = [];
    for (let w = 1; w <= 10; w++) for (let i = 0; i < 16; i++) history.push({ home: teams[(2 * i + w) % 32], away: teams[(2 * i + 1 + w) % 32], week: w, scores: (i + w) % 3 === 0 ? [17, 24] : [24, 17] });
    const upcoming: SeedGame[] = [];
    for (let i = 0; i < 30; i++) upcoming.push({ home: teams[i % 32], away: teams[(i + 7) % 32], week: 40 + (i < 15 ? 0 : 1), status: "NOT_STARTED", round: `Regular Season - Week ${40 + (i < 15 ? 0 : 1)}` });
    for (let i = 0; i < history.length; i += 200) await seedGames(history.slice(i, i + 200));
    const targetIds = await seedGames(upcoming);

    await loadGameContexts(targetIds, ENABLED); // warm the connection
    const runs: number[] = [];
    let last: Awaited<ReturnType<typeof loadGameContexts>> | undefined;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      last = await loadGameContexts(targetIds, ENABLED);
      runs.push(performance.now() - t);
    }
    const { stats } = last!;
    const median = [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    const report = `[game-context perf] loader, 30 Games: ${stats.queries} queries, ${stats.rows} rows, ${stats.withContext} lines, median ${median.toFixed(0)} ms (runs: ${runs.map((r) => r.toFixed(0)).join(", ")})`;
    console.info(report);
    if (process.env.GAME_CONTEXT_PERF_OUT) appendFileSync(process.env.GAME_CONTEXT_PERF_OUT, `${report}\n`);
    expect(stats.targets).toBe(30);
    expect(stats.queries).toBeLessThanOrEqual(3); // targets (1) + history (1; one league-season) — never one per card
    expect(stats.rows).toBeLessThanOrEqual(30 + 320);
    expect(median).toBeLessThan(1500);
  }, 120_000);

  it("the whole feed with Game Context on costs little more than with it off", async () => {
    const teams = Array.from({ length: 32 }, () => tid());
    const history: SeedGame[] = [];
    for (let w = 1; w <= 8; w++) for (let i = 0; i < 16; i++) history.push({ home: teams[(2 * i + w) % 32], away: teams[(2 * i + 1 + w) % 32], week: w, scores: (i + w) % 3 === 0 ? [17, 24] : [24, 17] });
    for (let i = 0; i < history.length; i += 200) await seedGames(history.slice(i, i + 200));
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const { fixtureId } = await seedGame({ homeName: `Home ${i}`, awayName: `Away ${i}`, startsInMinutes: 24 * 60 + i });
      await setFixture(fixtureId, { season: "2026", round: "Regular Season - Week 40", home_team_external_id: teams[i % 32], away_team_external_id: teams[(i + 7) % 32] });
      await ensureAndPublishPostForFixture(fixtureId, true);
      ids.push(fixtureId);
    }
    const timeFeed = async () => {
      const runs: number[] = [];
      let items = 0;
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const feed = await getSocialFeed(null);
        runs.push(performance.now() - t);
        items = feed.length;
      }
      return { median: [...runs].sort((a, b) => a - b)[2], items, lines: 0 };
    };
    await getSocialFeed(null); // warm
    const off = await timeFeed();
    await setPolicy(await superAdmin(), true);
    const on = await timeFeed();
    const withLines = (await getSocialFeed(null)).filter((i) => i.gameContext).length;
    const report = `[game-context perf] feed of ${on.items} Games: off median ${off.median.toFixed(0)} ms, on median ${on.median.toFixed(0)} ms (delta ${(on.median - off.median).toFixed(0)} ms), ${withLines} Games with a line`;
    console.info(report);
    if (process.env.GAME_CONTEXT_PERF_OUT) appendFileSync(process.env.GAME_CONTEXT_PERF_OUT, `${report}\n`);
    expect(on.items).toBeGreaterThanOrEqual(30);
    expect(on.median - off.median).toBeLessThan(750);
  }, 240_000);
});
