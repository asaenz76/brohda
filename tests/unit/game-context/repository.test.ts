import { beforeEach, describe, expect, it, vi } from "vitest";
import { GAME_CONTEXT_DEFAULTS } from "@/lib/game-context/config";

// The loader's failure behaviour and paging, against a scripted stand-in for the database client. (The real database is exercised in tests/integration/game-context.test.ts.)

type Result = { data: unknown; error: unknown };
const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
let script: (table: string, method: string, args: unknown[], history: number) => Result | "throw";
let historyReads = 0;

function chain(table: string) {
  const state: Array<{ method: string; args: unknown[] }> = [];
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) => {
          const isHistory = state.some((s) => s.method === "range");
          if (isHistory) historyReads++;
          const out = script(table, state.map((s) => s.method).join("."), state.flatMap((s) => s.args), historyReads);
          return out === "throw" ? reject(new Error("database unavailable")) : resolve(out);
        };
      }
      return (...args: unknown[]) => {
        state.push({ method: prop, args });
        calls.push({ table, method: prop, args });
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (table: string) => chain(table) }) }));
const { getGameContexts, loadGameContexts } = await import("@/lib/game-context/repository");

const ENABLED_SETTINGS = { data: { game_context_enabled: true, game_context_config: null }, error: null };
const target = (id: string, home = "h", away = "a") => ({
  id, provider: "api_nfl", sport: "american_football", season: "2026", round: "Regular Season - Week 9", home_team_external_id: home, away_team_external_id: away, home_team_name: "Home Team", away_team_name: "Away Team",
  scheduled_start_utc: "2026-11-01T18:00:00Z", internal_status: "NOT_STARTED", home_score: null, away_score: null,
});
const played = (i: number, home = "h", won = true) => ({
  id: `played-${String(i).padStart(5, "0")}`, provider: "api_nfl", sport: "american_football", season: "2026", round: `Regular Season - Week ${i}`, home_team_external_id: home, away_team_external_id: `opp-${i}`,
  home_team_name: "Home Team", away_team_name: `Opp ${i}`, scheduled_start_utc: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(), internal_status: "COMPLETED", home_score: won ? 24 : 10, away_score: won ? 10 : 24,
});

beforeEach(() => {
  calls.length = 0;
  historyReads = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("getGameContexts never lets a failure out", () => {
  it("settings unreadable → no context, and the failure is logged, not thrown", async () => {
    script = () => "throw";
    await expect(getGameContexts(["x"])).resolves.toEqual(new Map());
    expect(console.error).toHaveBeenCalled();
  });

  it("settings returning an error → the feature is off", async () => {
    script = () => ({ data: null, error: { message: "boom" } });
    await expect(getGameContexts(["x"])).resolves.toEqual(new Map());
    expect(calls.every((c) => c.table === "platform_settings")).toBe(true); // nothing else was even read
  });

  it("a history query failing mid-way → no context for the page, not an error", async () => {
    script = (table, method) => {
      if (table === "platform_settings") return ENABLED_SETTINGS;
      if (method.includes("range")) return { data: null, error: { message: "timeout" } };
      return { data: [target("t1")], error: null };
    };
    await expect(getGameContexts(["t1"])).resolves.toEqual(new Map());
    expect(console.error).toHaveBeenCalled();
  });

  it("while off it reads the policy and nothing else", async () => {
    script = (table) => (table === "platform_settings" ? { data: { game_context_enabled: false, game_context_config: null }, error: null } : "throw");
    await expect(getGameContexts(["t1"])).resolves.toEqual(new Map());
    expect(calls.map((c) => c.table)).toEqual(expect.arrayContaining(["platform_settings"]));
    expect(calls.some((c) => c.table === "fixtures")).toBe(false);
  });
});

describe("loadGameContexts reads in bounded, complete pages", () => {
  const config = { enabled: true, ...GAME_CONTEXT_DEFAULTS };

  it("a full page triggers the next page, so a history longer than the response ceiling is never silently cut", async () => {
    const page1 = Array.from({ length: 900 }, (_, i) => played(i + 1));
    const page2 = Array.from({ length: 3 }, (_, i) => played(901 + i));
    script = (_table, method, _args, n) => (method.includes("range") ? { data: n === 1 ? page1 : page2, error: null } : { data: [target("t1")], error: null });
    const { stats } = await loadGameContexts(["t1"], config);
    const ranges = calls.filter((c) => c.method === "range").map((c) => c.args);
    expect(ranges).toEqual([[0, 899], [900, 1799]]);
    expect(stats.rows).toBe(1 + 900 + 3);
    expect(stats.queries).toBe(3);
  });

  it("a short page is the end: one read for a normal history", async () => {
    script = (_table, method) => (method.includes("range") ? { data: [played(1), played(2), played(3), played(4)], error: null } : { data: [target("t1")], error: null });
    const { contexts, stats } = await loadGameContexts(["t1"], config);
    expect(calls.filter((c) => c.method === "range")).toHaveLength(1);
    expect(stats.queries).toBe(2);
    expect(contexts.get("t1")?.text).toBe("Home Team are 4–0 this season. Away Team are trying to stop the streak.");
  });

  it("asks only for what it proves from: this provider, sport, season, regular-season rounds, before the latest Game, for these teams", async () => {
    script = (_table, method) => (method.includes("range") ? { data: [], error: null } : { data: [target("t1", "h1", "a1"), target("t2", "h2", "a2")], error: null });
    await loadGameContexts(["t1", "t2"], config);
    const by = (m: string) => calls.filter((c) => c.method === m).map((c) => c.args);
    expect(by("eq")).toEqual(expect.arrayContaining([["provider", "api_nfl"], ["sport", "american_football"], ["season", "2026"]]));
    expect(by("like")).toEqual([["round", "Regular Season%"]]);
    expect(by("lt")).toEqual([["scheduled_start_utc", "2026-11-01T18:00:00.000Z"]]);
    expect(by("or")).toEqual([["home_team_external_id.in.(a1,a2,h1,h2),away_team_external_id.in.(a1,a2,h1,h2)"]]);
  });

  it("only Games Game Context can speak about cost a history read", async () => {
    script = (_table, method) => (method.includes("range") ? "throw" : { data: [{ ...target("t1"), sport: "basketball", provider: "api_nba", round: null }, { ...target("t2"), internal_status: "LIVE" }], error: null });
    const { stats } = await loadGameContexts(["t1", "t2"], config);
    expect(stats.targets).toBe(0);
    expect(calls.some((c) => c.method === "range")).toBe(false);
  });
});
