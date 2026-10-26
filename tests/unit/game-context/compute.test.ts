import { describe, expect, it } from "vitest";
import { computeGameContext } from "@/lib/game-context/compute";
import { CONFIG, DISABLED_GAME_CONTEXT, game, meeting, season, shuffled, teamName, upcoming } from "../../support/game-context";

const ctx = (home: string, away: string, history: ReturnType<typeof season>, config = CONFIG) => computeGameContext(upcoming(home, away), history, config);

describe("win and loss streaks", () => {
  it("six straight wins after an earlier loss is a 6-game winning streak (and says so)", () => {
    const c = ctx("h", "a", season("h", "LWWWWWW"));
    expect(c?.primaryFact.type).toBe("WIN_STREAK");
    expect(c?.primaryFact.values.streak).toBe(6);
    expect(c?.text).toBe("Team H have won 6 straight. Team A are trying to stop the streak.");
  });

  it("six wins and NOTHING else this season is the team's whole season, said as a record, not as a streak that might be longer", () => {
    const c = ctx("h", "a", season("h", "WWWWWW"));
    expect(c?.primaryFact.type).toBe("SEASON_UNBEATEN");
    expect(c?.primaryFact.values.streak).toBe(6);
    expect(c?.text).toBe("Team H are 6–0 this season. Team A are trying to stop the streak.");
  });

  it("W W W L is not a winning streak: the loss ends it, and a 1-game losing run is below the bar → no context", () => {
    expect(ctx("h", "a", season("h", "WWWL"))).toBeNull();
  });

  it("a losing streak of 4 after a win is a 4-game losing streak", () => {
    const c = ctx("h", "a", season("h", "WLLLL"));
    expect(c?.primaryFact.type).toBe("LOSS_STREAK");
    expect(c?.primaryFact.values.streak).toBe(4);
    expect(c?.text).toBe("Team H have lost 4 straight.");
  });

  it("an all-losses season is stated as a record", () => {
    expect(ctx("h", "a", season("h", "LLLL"))?.text).toBe("Team H are 0–4 this season.");
  });

  it("a streak shorter than the configured minimum is not a fact", () => {
    expect(ctx("h", "a", season("h", "LWW"))).toBeNull();
    expect(ctx("h", "a", season("h", "LWWW"), { ...CONFIG, minWinStreak: 4 })).toBeNull();
    expect(ctx("h", "a", season("h", "LWWWW"), { ...CONFIG, minWinStreak: 4 })?.primaryFact.values.streak).toBe(4);
  });

  it("the order rows arrive in never matters: chronology comes from the start time", () => {
    const history = season("h", "LWWWWWW");
    const expected = ctx("h", "a", history)?.text;
    for (const seed of [1, 2, 3, 99]) expect(ctx("h", "a", shuffled(history, seed))?.text).toBe(expected);
  });

  it("the away team's streak is read the same way", () => {
    const c = ctx("h", "a", season("a", "WLLLL"));
    expect(c?.primaryFact.side).toBe("AWAY");
    expect(c?.text).toBe("Team A have lost 4 straight.");
  });

  it("a tie ends a streak and never counts as a win or a loss", () => {
    expect(ctx("h", "a", season("h", "WWWTW"))).toBeNull();
    expect(ctx("h", "a", season("h", "LWWWT"))).toBeNull();
    expect(ctx("h", "a", season("h", "TWWW"))?.primaryFact.values.streak).toBe(3);
  });
});

describe("last N", () => {
  const config = { ...CONFIG, lastN: 10, lastNMinDecisive: 8 };

  it("exactly ten Games: the W–L record of those ten", () => {
    const c = ctx("h", "a", season("h", "WWWLWWWWLW"), { ...config, minWinStreak: 5, minVenueStreak: 5 });
    expect(c?.primaryFact.type).toBe("LAST_N");
    expect(c?.primaryFact.values).toEqual({ wins: 8, losses: 2, sample: 10 });
    expect(c?.text).toBe("Team H are 8–2 in their last 10.");
  });

  it("eleven available: only the latest ten count", () => {
    const history = season("h", "LLWWWLWWWWW");
    const c = ctx("h", "a", history, { ...config, minWinStreak: 9, minVenueStreak: 9, lastNMinDecisive: 8 });
    // the latest ten are L W W W L W W W W W → 8–2; the oldest L is outside the window
    expect(c?.primaryFact.values).toEqual({ wins: 8, losses: 2, sample: 10 });
    expect(c?.primaryFact.supportingFixtureIds).toHaveLength(10);
  });

  it("six available: no last-ten claim", () => {
    expect(ctx("h", "a", season("h", "WWLWWW"), { ...config, minWinStreak: 9, minVenueStreak: 9 })).toBeNull();
  });

  it("a five-game window: with the bar at 4 of 5, 4–1 is notable and 3–2 is not", () => {
    const bar4 = { ...CONFIG, lastNMinDecisive: 4 };
    expect(ctx("h", "a", season("h", "WWLWW"), bar4)?.text).toBe("Team H are 4–1 in their last 5.");
    expect(ctx("h", "a", season("h", "WWWLW"), bar4)?.primaryFact.type).toBe("LAST_N");
    expect(ctx("h", "a", season("h", "WLWLW"), bar4)).toBeNull();
  });

  // Regression for a class of bad output found on real staging data: an ordinary small-window record (4–1 / 1–4 in the last 5, which is most of an NFL team's season so far) was shown for about a quarter of all
  // Games, once as the same sentence twice. With the shipped defaults only a window that is all one way qualifies — and that is the streak, which is already said — so none of these shows a record.
  it("with the DEFAULTS an ordinary 4–1 or 1–4 last-5 record is not shown, for either team, alone or as a pair", () => {
    for (const results of ["WWLWW", "WWWLW", "WWWWL", "LLWLL", "LLLWL", "LLLLW"]) expect(ctx("h", "a", season("h", results)), results).toBeNull();
    const both = computeGameContext(upcoming("h", "a"), [...season("h", "WWLWW"), ...season("a", "WWLWW")], CONFIG);
    expect(both).toBeNull();
    expect(CONFIG.lastNMinDecisive).toBe(5);
  });

  it("5–0 in the last 5 is the 5-game streak again, not said twice", () => {
    const c = ctx("h", "a", season("h", "LWWWWW"));
    expect(c?.primaryFact.type).toBe("WIN_STREAK");
    expect(c?.secondaryFact).toBeNull();
  });

  it("a tie inside the window means no record is claimed", () => {
    expect(ctx("h", "a", season("h", "WWTWW"))).toBeNull();
  });
});

describe("home and road form", () => {
  it("only home Games count toward a home streak, and the road Games between them do not break it", () => {
    // home: W W W W · road: L L L L (interleaved); the last Game is a road loss
    const history = season("h", "WLWLWLWL", "HAHAHAHA");
    const c = ctx("h", "a", history);
    expect(c?.primaryFact.type).toBe("HOME_WIN_STREAK");
    expect(c?.primaryFact.values.streak).toBe(4);
    expect(c?.text).toBe("Team H have won 4 straight at home. Team A are trying to stop the streak.");
  });

  it("the away team's road streak counts road Games only", () => {
    // a: home L, away W, home L, away W ... → road streak of 4 wins; the last Game was a road win; the overall streak is 1
    const history = season("a", "LWLWLWLW", "HAHAHAHA");
    const c = ctx("h", "a", history);
    expect(c?.primaryFact.type).toBe("AWAY_WIN_STREAK");
    expect(c?.text).toBe("Team A have won 4 straight on the road. Team H are trying to stop the streak.");
  });

  it("the upcoming Game's own venue never reclassifies history: the home team's ROAD wins are not home form", () => {
    const history = season("h", "WWWW", "AAAA");
    const c = ctx("h", "a", history);
    // four road wins in a row is the overall (whole-season) streak, but there is no HOME streak
    expect(c?.primaryFact.type).toBe("SEASON_UNBEATEN");
    expect(c?.primaryFact.values.streak).toBe(4);
  });

  it("a venue streak that adds nothing over the overall streak is not repeated", () => {
    const c = ctx("h", "a", season("h", "LWWWW", "AHHHH"));
    expect(c?.primaryFact.type).toBe("WIN_STREAK");
    expect(c?.secondaryFact).toBeNull();
  });
});

describe("season head-to-head", () => {
  const history = (h: ReturnType<typeof meeting>[]) => h;

  it("won both meetings", () => {
    const c = ctx("h", "a", history([meeting("h", "a", "h", 1), meeting("a", "h", "h", 5)]));
    expect(c?.primaryFact.type).toBe("SERIES_SWEEP");
    expect(c?.text).toBe("Team H have won both meetings this season.");
  });

  it("the other team's sweep names the other team", () => {
    expect(ctx("h", "a", history([meeting("h", "a", "a", 1), meeting("a", "h", "a", 5)]))?.text).toBe("Team A have won both meetings this season.");
  });

  it("1–1 split", () => {
    const c = ctx("h", "a", history([meeting("h", "a", "h", 1), meeting("a", "h", "a", 5)]));
    expect(c?.text).toBe("These teams split their first two meetings.");
  });

  it("one prior meeting: the score of that Game", () => {
    expect(ctx("h", "a", history([meeting("a", "h", "h", 3)]))?.text).toBe("Team H beat Team A 31–14 in their first meeting this season.");
  });

  it("the Game itself is never one of its own prior meetings", () => {
    const target = upcoming("h", "a");
    expect(computeGameContext(target, [{ ...target, internalStatus: "COMPLETED", homeScore: 30, awayScore: 10 }], CONFIG)).toBeNull();
  });

  it("a cancelled or postponed meeting is ignored", () => {
    const c = ctx("h", "a", history([meeting("h", "a", "h", 1), meeting("a", "h", null, 5, { internalStatus: "CANCELLED", homeScore: null, awayScore: null })]));
    expect(c?.text).toBe("Team H beat Team A 31–14 in their first meeting this season.");
  });

  it("a meeting that has not been played (but is scheduled before the Game) makes the series unprovable", () => {
    expect(ctx("h", "a", history([meeting("h", "a", "h", 1), meeting("a", "h", null, 5, { internalStatus: "NOT_STARTED", homeScore: null, awayScore: null })]))).toBeNull();
  });

  it("no prior meeting: nothing", () => {
    expect(ctx("h", "a", [])).toBeNull();
  });

  it("a series is not said when the feature is off", () => {
    expect(ctx("h", "a", history([meeting("h", "a", "h", 1), meeting("a", "h", "h", 5)]), { ...CONFIG, seriesEnabled: false })).toBeNull();
  });
});

describe("season boundaries and scope", () => {
  it("a previous season never extends or contaminates the current streak", () => {
    const old = season("h", "WWWWWWWW").map((g) => ({ ...g, season: "2025" }));
    const now = season("h", "LWW");
    expect(ctx("h", "a", [...old, ...now])).toBeNull(); // only 2 straight THIS season
    const now2 = season("h", "WWW");
    const c = ctx("h", "a", [...season("h", "LLLL").map((g) => ({ ...g, season: "2025" })), ...now2]);
    expect(c?.primaryFact.type).toBe("SEASON_UNBEATEN"); // 3–0 this season, not "won 3 straight" after 4 losses
    expect(c?.primaryFact.season).toBe("2026");
  });

  it("preseason and postseason Games are not regular-season form", () => {
    const pre = season("h", "WWWWW").map((g) => ({ ...g, round: "Pre Season - Week 1" }));
    expect(ctx("h", "a", pre)).toBeNull();
    const reg = season("h", "LWW", undefined, 10);
    expect(ctx("h", "a", [...pre, ...reg])).toBeNull();
  });

  it("another provider's Games with the same team id do not mix in", () => {
    const other = season("h", "WWWWW").map((g) => ({ ...g, provider: "api_nba" }));
    expect(ctx("h", "a", other)).toBeNull();
  });

  it("a Game scheduled AFTER the target is never history", () => {
    const later = season("h", "WWWWW", undefined, 50);
    expect(ctx("h", "a", later)).toBeNull();
  });
});

describe("terminal statuses", () => {
  it("postponed and cancelled Games are skipped: they are not results and do not break a streak", () => {
    const history = season("h", "LWWWW");
    const skipped = game({ week: 4.5, homeTeamExternalId: "h", awayTeamExternalId: "x", internalStatus: "POSTPONED", homeScore: null, awayScore: null });
    const cancelled = game({ week: 2.5, homeTeamExternalId: "x", awayTeamExternalId: "h", internalStatus: "CANCELLED", homeScore: null, awayScore: null });
    const c = ctx("h", "a", [...history, skipped, cancelled]);
    expect(c?.primaryFact.type).toBe("WIN_STREAK");
    expect(c?.primaryFact.values.streak).toBe(4);
    expect(c?.primaryFact.supportingFixtureIds).not.toContain(skipped.id);
  });

  it("LIVE, UNKNOWN, SUSPENDED, ABANDONED, AWARDED and still-NOT_STARTED Games before the target are unprovable, not guessed", () => {
    for (const status of ["LIVE", "UNKNOWN", "SUSPENDED", "ABANDONED", "AWARDED", "NOT_STARTED", "HALFTIME"]) {
      const history = season("h", "WWWWW");
      history[2] = { ...history[2], internalStatus: status, homeScore: null, awayScore: null };
      expect(ctx("h", "a", history), status).toBeNull();
    }
  });

  it("an unproven Game OLDER than the loss that ends the streak does not matter: the streak is already bounded", () => {
    const history = season("h", "XLWWW");
    history[0] = { ...history[0], internalStatus: "UNKNOWN", homeScore: null, awayScore: null };
    expect(ctx("h", "a", history)?.primaryFact.values.streak).toBe(3);
  });

  it("a finished Game with a missing score is unprovable", () => {
    const history = season("h", "WWWW");
    history[1] = { ...history[1], homeScore: null };
    expect(ctx("h", "a", history)).toBeNull();
  });

  it("the target must be a not-yet-started regular-season Game", () => {
    const history = season("h", "LWWWW");
    for (const internalStatus of ["COMPLETED", "LIVE", "POSTPONED", "CANCELLED"]) expect(computeGameContext(upcoming("h", "a", { internalStatus }), history, CONFIG), internalStatus).toBeNull();
    expect(computeGameContext(upcoming("h", "a", { round: "Pre Season - Week 3" }), history, CONFIG)).toBeNull();
    expect(computeGameContext(upcoming("h", "a", { round: "Wild Card" }), history, CONFIG)).toBeNull();
  });
});

describe("missing data fails closed", () => {
  const history = season("h", "LWWWW");
  it.each([
    ["no home team id", { homeTeamExternalId: null }],
    ["no away team id", { awayTeamExternalId: null }],
    ["same team on both sides", { awayTeamExternalId: "h" }],
    ["no season", { season: null }],
    ["no round", { round: null }],
    ["an unreadable start time", { scheduledStartUtc: "not a date" }],
  ])("%s → no context", (_name, o) => {
    expect(computeGameContext(upcoming("h", "a", o), history, CONFIG)).toBeNull();
  });

  it("a Game between teams Brohda cannot identify is attributed to no one; one with a known team still counts for that team", () => {
    const stranger = game({ week: 6, homeTeamExternalId: null, awayTeamExternalId: "z" });
    expect(ctx("h", "a", [...history, stranger])?.primaryFact.values.streak).toBe(4);
    const knownTeamUnknownOpponent = game({ week: 6, homeTeamExternalId: null, awayTeamExternalId: "h", homeScore: 10, awayScore: 3 }); // h lost it
    // the loss counts: it ends the overall 4-game streak, but a ROAD loss does not break the home-only streak, which is still true
    expect(ctx("h", "a", [...history, knownTeamUnknownOpponent])?.primaryFact.type).toBe("HOME_WIN_STREAK");
  });

  it("a sport whose stored data has no regular-season marker produces nothing, however perfect the history looks", () => {
    const nba = season("h", "WWWWWWWW").map((g) => ({ ...g, provider: "api_nba", sport: "basketball", round: null }));
    expect(computeGameContext(upcoming("h", "a", { provider: "api_nba", sport: "basketball", round: null }), nba, CONFIG)).toBeNull();
    const nhl = season("h", "WWWWWWWW").map((g) => ({ ...g, provider: "api_nhl", sport: "hockey", round: "Regular Season - Week 1" }));
    expect(computeGameContext(upcoming("h", "a", { provider: "api_nhl", sport: "hockey", round: "Regular Season - Week 40" }), nhl, CONFIG)).toBeNull();
  });

  it("unknown sports and a disabled policy produce nothing", () => {
    expect(computeGameContext(upcoming("h", "a", { sport: "football" }), history, CONFIG)).toBeNull();
    expect(computeGameContext(upcoming("h", "a"), history, DISABLED_GAME_CONTEXT)).toBeNull();
  });
});

describe("no context is a normal answer", () => {
  it("two unremarkable seasons produce null, not a placeholder", () => {
    const history = [...season("h", "WLWLWLW"), ...season("a", "LWLWLWL")];
    expect(ctx("h", "a", history)).toBeNull();
  });

  it("no history at all", () => {
    expect(ctx("h", "a", [])).toBeNull();
  });
});

describe("provenance and reproducibility", () => {
  it("every sentence is backed by the stored Games that prove it, most recent first", () => {
    const history = season("h", "LWWWWW");
    const c = ctx("h", "a", history)!;
    expect(c.supportingFixtureIds).toEqual([...history.slice(1)].reverse().map((g) => g.id));
    expect(c.supportingFixtureIds).toHaveLength(c.primaryFact.values.streak);
  });

  it("a pair's provenance is the union of both facts' Games, primary first, without duplicates", () => {
    const history = [...season("h", "LWWWWW"), ...season("a", "WLLLL")];
    const c = ctx("h", "a", history)!;
    expect(c.secondaryFact).not.toBeNull();
    expect(new Set(c.supportingFixtureIds).size).toBe(c.supportingFixtureIds.length);
    expect(c.supportingFixtureIds.slice(0, c.primaryFact.supportingFixtureIds.length)).toEqual([...c.primaryFact.supportingFixtureIds]);
  });

  it("same data + same settings = byte-identical output, however the rows are ordered, however many times it runs", () => {
    const history = [...season("h", "LWWWWW"), ...season("a", "WLLLL"), meeting("h", "a", "h", 3)];
    const first = JSON.stringify(ctx("h", "a", history));
    for (let i = 0; i < 25; i++) expect(JSON.stringify(ctx("h", "a", shuffled(history, i + 1)))).toBe(first);
  });

  it("the facts' names come from the stored Games, never from anywhere else", () => {
    const c = ctx("h", "a", season("h", "LWWWW"))!;
    expect(c.text).toContain(teamName("h"));
  });
});
