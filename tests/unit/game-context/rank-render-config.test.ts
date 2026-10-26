import { describe, expect, it } from "vitest";
import { computeGameContext } from "@/lib/game-context/compute";
import { DISABLED_GAME_CONTEXT, GAME_CONTEXT_DEFAULTS, parseGameContextConfig } from "@/lib/game-context/config";
import { FACT_PRIORITY } from "@/lib/game-context/facts";
import { compareFacts, selectFacts } from "@/lib/game-context/rank";
import { FACT_TEMPLATES, assemble, renderFact } from "@/lib/game-context/render";
import type { FactType, GameContextFact } from "@/lib/game-context/types";
import { SPORT_CONFIGS } from "@/lib/sports-data/sport-registry";
import { CONFIG, season, shuffled, upcoming } from "../../support/game-context";

const ctx = (history: ReturnType<typeof season>, config = CONFIG) => computeGameContext(upcoming("h", "a"), history, config);

describe("ranking", () => {
  it("Case A — a 6-game streak beats an 8–2 last ten (the streak is the sharper fact)", () => {
    // oldest → newest: L W W L W W W W W W → 6-game streak, 8–2 over the last ten
    const c = ctx(season("h", "LWWLWWWWWW"), { ...CONFIG, lastN: 10, lastNMinDecisive: 8 });
    expect(c?.primaryFact.type).toBe("WIN_STREAK");
    expect(c?.primaryFact.values.streak).toBe(6);
    expect(c?.text).not.toContain("last 10");
  });

  it("a 7–3 last ten is too ordinary to say; a 7-game streak is not", () => {
    expect(ctx(season("h", "LLLWWLWWLW"), { ...CONFIG, lastN: 10, lastNMinDecisive: 7 })).toBeNull();
    expect(ctx(season("h", "LWWWWWWW"))?.primaryFact.values.streak).toBe(7);
  });

  it("Case B — a 6-game streak meeting a 5-game home streak is said together, with the connective", () => {
    // home team: five home wins, then a road loss (overall: a 1-game losing run; HOME streak: 5). away team: a loss, then six wins.
    const history = [...season("h", "WWWWWL", "HHHHHA"), ...season("a", "LWWWWWW")];
    const c = computeGameContext(upcoming("h", "a"), history, CONFIG)!;
    expect(c.primaryFact.type).toBe("WIN_STREAK");
    expect(c.secondaryFact?.type).toBe("HOME_WIN_STREAK");
    expect(c.text).toBe("Team A have won 6 straight. Team H have won 5 straight at home. Something has to give.");
    expect(c.metadata.shape).toBe("pair+connective");
    expect(c.rank).toBe(60 + 50 + 5);
  });

  it("a winning streak against a losing streak is said together with no connective", () => {
    const c = computeGameContext(upcoming("h", "a"), [...season("h", "LWWWWWWW"), ...season("a", "WLLLLL")], CONFIG)!;
    expect(c.text).toBe("Team H have won 7 straight. Team A have lost 5 straight.");
    expect(c.rank).toBe(70 + 50 + 10);
  });

  it("Case C — a 4–1 last five (32) outranks a 3-game streak (30); both qualify, so they are paired", () => {
    const history = [...season("h", "WWLWW"), ...season("a", "LWWW")];
    const c = computeGameContext(upcoming("h", "a"), history, { ...CONFIG, lastNMinDecisive: 4 })!;
    expect(c.primaryFact.type).toBe("LAST_N");
    expect(c.secondaryFact?.type).toBe("WIN_STREAK");
  });

  it("a tiny 2-game streak never outranks (or joins) a strong fact", () => {
    const c = computeGameContext(upcoming("h", "a"), [...season("h", "LWWWWW"), ...season("a", "LLWW")], CONFIG)!;
    expect(c.secondaryFact).toBeNull();
    expect(c.text).toBe("Team H have won 5 straight. Team A are trying to stop the streak.");
  });

  it("Case D — equal scores resolve the same way every run: priority, then side (home first)", () => {
    const history = [...season("h", "LWWWW"), ...season("a", "LWWWW")];
    const first = computeGameContext(upcoming("h", "a"), history, CONFIG)!;
    expect(first.primaryFact.side).toBe("HOME");
    expect(first.secondaryFact?.side).toBe("AWAY");
    for (let i = 0; i < 25; i++) expect(computeGameContext(upcoming("h", "a"), shuffled(history, i + 3), CONFIG)?.text).toBe(first.text);
  });

  it("the comparator is a total order: score, then priority, then side, then supporting id", () => {
    const base = { side: "HOME", subjectTeamName: "A", opponentTeamName: "B", values: { streak: 3 }, season: "2026", scope: "REGULAR_SEASON", supportingFixtureIds: ["x"] } as const;
    const f = (type: FactType, score: number, side: "HOME" | "AWAY" | "BOTH" = "HOME", id = "x"): GameContextFact => ({ ...base, type, score, side, supportingFixtureIds: [id] });
    const sorted = [f("LAST_N", 32), f("WIN_STREAK", 30), f("LOSS_STREAK", 30), f("WIN_STREAK", 30, "AWAY"), f("WIN_STREAK", 30, "HOME", "a")].sort(compareFacts);
    expect(sorted.map((x) => `${x.type}/${x.side}/${x.supportingFixtureIds[0]}/${x.score}`)).toEqual(["LAST_N/HOME/x/32", "WIN_STREAK/HOME/a/30", "WIN_STREAK/HOME/x/30", "WIN_STREAK/AWAY/x/30", "LOSS_STREAK/HOME/x/30"]);
    expect([...FACT_PRIORITY].sort()).toEqual([...new Set(FACT_PRIORITY)].sort()); // no fact type listed twice
  });

  it("nothing below the configured bar is ever selected", () => {
    const f: GameContextFact = { type: "WIN_STREAK", side: "HOME", subjectTeamName: "A", opponentTeamName: "B", values: { streak: 3 }, season: "2026", scope: "REGULAR_SEASON", supportingFixtureIds: ["x"], score: 30 };
    expect(selectFacts([f], CONFIG)?.primary).toBe(f);
    expect(selectFacts([f], { ...CONFIG, minScore: 31 })).toBeNull();
  });

  it("pairs can be turned off", () => {
    const history = [...season("h", "LWWWWWWW"), ...season("a", "WLLLLL")];
    expect(computeGameContext(upcoming("h", "a"), history, { ...CONFIG, pairsEnabled: false })?.text).toBe("Team H have won 7 straight. Team A are trying to stop the streak.");
  });
});

describe("rendering", () => {
  const history = [...season("h", "LWWWWWWW"), ...season("a", "WLLLLL")];

  it("never cuts a sentence: the longer wording is dropped for the shorter one that fits", () => {
    const pair = "Team H have won 7 straight. Team A have lost 5 straight.";
    expect(computeGameContext(upcoming("h", "a"), history, { ...CONFIG, maxChars: pair.length })?.text).toBe(pair);
    expect(computeGameContext(upcoming("h", "a"), history, { ...CONFIG, maxChars: pair.length - 1 })?.text).toBe("Team H have won 7 straight."); // the pair does not fit, and the connective wording is longer still
    expect(computeGameContext(upcoming("h", "a"), history, { ...CONFIG, maxChars: 28 })?.text).toBe("Team H have won 7 straight.");
  });

  it("when not even the single fact fits, there is no line", () => {
    expect(computeGameContext(upcoming("h", "a"), history, { ...CONFIG, maxChars: 20 })).toBeNull();
  });

  it("a fallback to the single fact reports the single fact's own rank and no secondary", () => {
    const c = computeGameContext(upcoming("h", "a"), history, { ...CONFIG, maxChars: 28 })!;
    expect(c.secondaryFact).toBeNull();
    expect(c.rank).toBe(70);
    expect(c.metadata.shape).toBe("single");
  });

  it("the connective can be turned off", () => {
    expect(ctx(season("h", "LWWWW"), { ...CONFIG, connectiveEnabled: false })?.text).toBe("Team H have won 4 straight.");
  });

  it("uses the en dash for records, as the rest of the app does", () => {
    expect(ctx(season("h", "WWWWW"))?.text).toContain("5–0");
  });

  it("never prints undefined, null, NaN or an empty sentence, for any template", () => {
    for (const type of Object.keys(FACT_TEMPLATES) as FactType[]) {
      const text = renderFact({ type, side: "HOME", subjectTeamName: "Boston Celtics", opponentTeamName: "Miami Heat", values: { streak: 7, wins: 8, losses: 2, sample: 10, meetings: 2, winnerScore: 31, loserScore: 14 }, season: "2026", scope: "REGULAR_SEASON", supportingFixtureIds: ["x"], score: 70 });
      expect(text, type).not.toMatch(/undefined|null|NaN|\{|\}|\s{2}/);
      expect(text.trim().endsWith("."), type).toBe(true);
      expect(text[0], type).toMatch(/[A-Z]/);
    }
  });

  it("a sweep of more than two meetings says how many", () => {
    expect(FACT_TEMPLATES.SERIES_SWEEP({ type: "SERIES_SWEEP", side: "BOTH", subjectTeamName: "Boston Celtics", opponentTeamName: "Miami Heat", values: { meetings: 3 }, season: "2026", scope: "REGULAR_SEASON", supportingFixtureIds: ["x"], score: 50 })).toBe("Boston Celtics have won all 3 meetings this season.");
  });
});

describe("product language is fixed by the templates, not policed after the fact", () => {
  // Every word Game Context can ever print comes from FACT_TEMPLATES and the two connectives. None of them can be a betting term, a recommendation, a forecast or a motive.
  const FORBIDDEN = /\b(spread|total|odds|line|lines|moneyline|favou?rites?|underdogs?|implied|probabilit\w*|price\w*|bets?|betting|wager\w*|picks?|should|edge|safe\w*|lock\w*|take|expect\w*|guarantee\w*|predict\w*|will|desperate|unstoppable|revenge|must|sure)\b/i;
  const sample = (type: FactType): GameContextFact => ({ type, side: "HOME", subjectTeamName: "Kansas City Chiefs", opponentTeamName: "Buffalo Bills", values: { streak: 6, wins: 4, losses: 1, sample: 5, meetings: 2, winnerScore: 27, loserScore: 24 }, season: "2026", scope: "REGULAR_SEASON", supportingFixtureIds: ["x"], score: 60 });

  it("no template can produce betting or recommendation language", () => {
    for (const type of Object.keys(FACT_TEMPLATES) as FactType[]) expect(renderFact(sample(type)), type).not.toMatch(FORBIDDEN);
  });

  it("neither connective can", () => {
    const winning = sample("WIN_STREAK");
    const both = assemble(winning, sample("AWAY_WIN_STREAK"), { maxChars: 200, connectiveEnabled: true })!;
    const single = assemble(winning, null, { maxChars: 200, connectiveEnabled: true })!;
    expect(both.text).toContain("Something has to give.");
    expect(single.text).toContain("are trying to stop the streak.");
    expect(both.text).not.toMatch(FORBIDDEN);
    expect(single.text).not.toMatch(FORBIDDEN);
  });

  it("the full end-to-end line for a real pairing carries none either", () => {
    const text = computeGameContext(upcoming("h", "a"), [...season("h", "LWWWWWW"), ...season("a", "LWWWWW")], CONFIG)!.text;
    expect(text).not.toMatch(FORBIDDEN);
  });
});

describe("the policy parser fails closed", () => {
  it("is off unless the flag is exactly true", () => {
    for (const row of [null, undefined, {}, { game_context_enabled: false }, { game_context_enabled: "true" }, { game_context_enabled: 1 }]) expect(parseGameContextConfig(row)).toEqual(DISABLED_GAME_CONTEXT);
    expect(DISABLED_GAME_CONTEXT.enabled).toBe(false);
  });

  it("enabled with no config uses the defaults", () => {
    expect(parseGameContextConfig({ game_context_enabled: true, game_context_config: null })).toEqual({ enabled: true, ...GAME_CONTEXT_DEFAULTS });
    expect(parseGameContextConfig({ game_context_enabled: true, game_context_config: {} })).toEqual({ enabled: true, ...GAME_CONTEXT_DEFAULTS });
  });

  it("applies valid overrides and ignores unknown keys", () => {
    const c = parseGameContextConfig({ game_context_enabled: true, game_context_config: { min_win_streak: 4, pairs_enabled: false, max_chars: 100, future_thing: 9 } });
    expect(c).toMatchObject({ enabled: true, minWinStreak: 4, pairsEnabled: false, maxChars: 100, minLossStreak: 3 });
  });

  it.each([
    ["a string where a number belongs", { min_win_streak: "4" }],
    ["a float", { min_win_streak: 3.5 }],
    ["below the range", { min_win_streak: 1 }],
    ["above the range", { max_chars: 500 }],
    ["a number where a boolean belongs", { pairs_enabled: 1 }],
    ["a decisive count above the window", { last_n: 5, last_n_min_decisive: 6 }],
    ["a decisive count that is not a majority", { last_n: 10, last_n_min_decisive: 5 }],
  ])("one invalid value turns the whole feature off: %s", (_name, config) => {
    expect(parseGameContextConfig({ game_context_enabled: true, game_context_config: config })).toEqual(DISABLED_GAME_CONTEXT);
  });

  it.each([["an array", []], ["a string", "x"], ["a number", 4]])("a config that is %s turns it off", (_name, config) => {
    expect(parseGameContextConfig({ game_context_enabled: true, game_context_config: config })).toEqual(DISABLED_GAME_CONTEXT);
  });
});

describe("sport rules live in the registry", () => {
  it("only the NFL carries a stored regular-season marker today; every other sport is silent until one is added by review", () => {
    const byKey = Object.fromEntries(SPORT_CONFIGS.map((c) => [c.sport, c.regularSeason]));
    expect(byKey.american_football).toEqual({ roundPrefix: "Regular Season" });
    expect(byKey.basketball).toBeNull();
    expect(byKey.hockey).toBeNull();
    expect(byKey.baseball).toBeNull();
  });
});
