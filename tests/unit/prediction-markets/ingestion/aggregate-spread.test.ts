import { describe, expect, it, vi } from "vitest";
import { aggregateSpread, SPREAD_MAIN_LINE_BAND } from "@/lib/prediction-markets/ingestion/aggregate-spread";
import { aggregateMoneyline, aggregateTotal } from "@/lib/prediction-markets/ingestion/aggregate-nfl-odds";
import { normalizeBookmaker } from "@/lib/sports-data/api-sports-provider";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import type { RawBookmakerOdds } from "@/lib/sports-data/types";
import nflOdds from "../../../fixtures/provider/nfl-odds-sample.json";

vi.mock("server-only", () => ({}));

const hc = (home: Array<[number, number]>, away: Array<[number, number]>) => [
  ...home.map(([line, odd]) => ({ value: `Home ${line > 0 ? "+" : ""}${line}`, odd })),
  ...away.map(([line, odd]) => ({ value: `Away ${line > 0 ? "+" : ""}${line}`, odd })),
];
const book = (id: number, asianHandicap: RawBookmakerOdds["asianHandicap"]): RawBookmakerOdds => ({ bookmakerId: id, bookmakerName: `b${id}`, moneyline: [], asianHandicap, gameTotal: [] });

describe("aggregateSpread — the SPREAD template for every sport (puck line / run line / point spread)", () => {
  it("REAL NFL payload (6 bookmakers): finds the balanced main line, anchored to HOME, and cross-checks it against the moneyline", () => {
    const nfl = getSportConfig("american_football")!;
    const books = (nflOdds.item.bookmakers as Parameters<typeof normalizeBookmaker>[1][]).map((b) => normalizeBookmaker(nfl, b));
    const ml = aggregateMoneyline(books, 2)!;
    expect(ml.homeProbability).toBeGreaterThan(0.75); // Home is a heavy favourite in the captured game
    const spread = aggregateSpread(books, 2, ml.homeProbability)!;
    expect(spread).not.toBeNull();
    expect(spread.homeLine).toBe(-9.5); // Betfair 1.91/1.91, Marathon 1.87/1.91 — the only line quoted as a coin flip on both sides
    expect(spread.homeLine).toBeLessThan(0); // the favourite gives points
    expect(Math.abs(spread.homeCoverProbability - 0.5)).toBeLessThan(0.05);
    expect(spread.bookmakerCount).toBeGreaterThanOrEqual(2);
  });

  it("puck line: favourite -1.5 / underdog +1.5 — the line is the HOME handicap, whichever side the favourite is on", () => {
    const books = [book(1, hc([[-1.5, 2.2]], [[-1.5, 1.68]])), book(2, hc([[-1.5, 2.25]], [[-1.5, 1.66]]))];
    const home = aggregateSpread(books, 2, 0.62)!; // home is the favourite
    expect(home.homeLine).toBe(-1.5);
    const awayFav = [book(1, hc([[1.5, 1.7]], [[1.5, 2.15]])), book(2, hc([[1.5, 1.72]], [[1.5, 2.1]]))];
    expect(aggregateSpread(awayFav, 2, 0.38)!.homeLine).toBe(1.5); // away favourite: home takes +1.5
  });

  it("picks the most balanced of several alternate lines", () => {
    const books = [1, 2].map((id) => book(id, hc([[-1, 1.5], [-3.5, 1.91], [-6, 2.6]], [[-1, 2.6], [-3.5, 1.91], [-6, 1.5]])));
    expect(aggregateSpread(books, 2, 0.65)!.homeLine).toBe(-3.5);
  });

  it("REFUSES an inverted reading: a home favourite quoted as taking points can never be ingested", () => {
    const books = [book(1, hc([[2.5, 1.9]], [[2.5, 1.9]])), book(2, hc([[2.5, 1.9]], [[2.5, 1.9]]))];
    expect(aggregateSpread(books, 2, 0.8)).toBeNull(); // home 80% favourite but line says home +2.5
    expect(aggregateSpread(books, 2, 0.2)!.homeLine).toBe(2.5); // consistent with an away favourite
  });

  it("REFUSES when only alternate (lopsided) lines were quoted — no main line, no Market", () => {
    const books = [1, 2].map((id) => book(id, hc([[-9.5, 3.4]], [[-9.5, 1.28]])));
    expect(aggregateSpread(books, 2, 0.8)).toBeNull();
    expect(SPREAD_MAIN_LINE_BAND).toEqual([0.35, 0.65]);
  });

  it("REFUSES a lone one-sided entry (the earlier 'Home -1 priced like the moneyline' ambiguity) — a line needs both sides from the same bookmaker", () => {
    const books = [book(1, [{ value: "Home -1", odd: 1.18 }]), book(2, [{ value: "Away -1", odd: 4.36 }])];
    expect(aggregateSpread(books, 1, 0.8)).toBeNull();
  });

  it("needs the minimum bookmaker count on the SAME line, and a moneyline to verify orientation against", () => {
    const one = [book(1, hc([[-1.5, 1.9]], [[-1.5, 1.9]]))];
    expect(aggregateSpread(one, 2, 0.6)).toBeNull();
    expect(aggregateSpread(one, 1, null)).toBeNull(); // orientation unverifiable -> refused
    expect(aggregateSpread(one, 1, 0.6)!.homeLine).toBe(-1.5);
  });

  it("a pick'em line (0) is allowed with any moneyline", () => {
    const books = [book(1, hc([[0, 1.91]], [[0, 1.91]])), book(2, hc([[0, 1.9]], [[0, 1.92]]))];
    expect(aggregateSpread(books, 2, 0.7)!.homeLine).toBe(0);
  });

  it("ignores values it cannot parse", () => {
    const books = [book(1, [{ value: "garbage", odd: 1.9 }, { value: "Home -3", odd: 1.9 }, { value: "Away -3", odd: 1.9 }])];
    expect(aggregateSpread(books, 1, 0.6)!.homeLine).toBe(-3);
  });
});

// ---- REAL NHL payloads (2026 season, captured read-only the day the Hockey plan was upgraded) ---------------------------------------------
import nhlOdds from "../../../fixtures/provider/nhl-odds-2026-sample.json";

describe("aggregateSpread on real 2026 NHL odds (the puck line)", () => {
  const nhl = getSportConfig("hockey")!;
  const normalize = (item: (typeof nhlOdds)["gameA"]) => (item.bookmakers as Parameters<typeof normalizeBookmaker>[1][]).map((b) => normalizeBookmaker(nhl, b));
  const moneyline = (books: RawBookmakerOdds[]) => aggregateMoneyline(books, 2)!.homeProbability;

  it("the real handicap payload follows the verified convention: the number is the HOME handicap, 'Away' is the other side of the same line", () => {
    const books = normalize(nhlOdds.gameA);
    const betvictor = books.find((b) => b.bookmakerName === "BetVictor")!;
    // Home is the 1.57 moneyline favourite: Home -1.5 pays 2.38 (laying 1.5), the Away entry at the same number is the cheap side (1.53) = away +1.5.
    expect(betvictor.asianHandicap.find((v) => v.value === "Home -1.5")!.odd).toBe(2.38);
    expect(betvictor.asianHandicap.find((v) => v.value === "Away -1.5")!.odd).toBe(1.53);
  });

  it("game with two books quoting the puck line: finds home -1.5 even though its prices are lopsided (fair 0.30) — the NHL band accepts it, the floating-line default would not", () => {
    const books = normalize(nhlOdds.gameB);
    const home = moneyline(books);
    const spread = aggregateSpread(books, 2, home, nhl.spreadMainLineBand)!;
    expect(spread).not.toBeNull();
    expect(spread.homeLine).toBe(-1.5);
    expect(spread.homeCoverProbability).toBeGreaterThan(0.25);
    expect(spread.homeCoverProbability).toBeLessThan(0.35);
    expect(aggregateSpread(books, 2, home)).toBeNull(); // default band [0.35, 0.65] would have refused a real puck line
  });

  it("real availability: exactly two books (BetVictor, Betano) quote the puck line in both captured games — enough at the standard minimum of 2, never at 3 (correctness beats completeness)", () => {
    for (const game of [nhlOdds.gameA, nhlOdds.gameB]) {
      const books = normalize(game);
      expect(books.filter((b) => b.asianHandicap.length > 0).map((b) => b.bookmakerName).sort()).toEqual(["BetVictor", "Betano"]);
      expect(aggregateSpread(books, 2, moneyline(books), nhl.spreadMainLineBand)!.homeLine).toBe(-1.5);
      expect(aggregateSpread(books, 3, moneyline(books), nhl.spreadMainLineBand)).toBeNull();
    }
  });

  it("an alternate-only quote (-2.5 / -3.5) is still refused under the NHL band", () => {
    const alt: RawBookmakerOdds[] = [1, 2].map((id) => ({ bookmakerId: id, bookmakerName: `b${id}`, moneyline: [], gameTotal: [], asianHandicap: [{ value: "Home -3.5", odd: 6 }, { value: "Away -3.5", odd: 1.09 }] }));
    expect(aggregateSpread(alt, 2, 0.62, nhl.spreadMainLineBand)).toBeNull();
  });

  it("the Total on the same real game: line 5.5 is chosen (closest to a coin flip) when two books quote it", () => {
    const books = normalize(nhlOdds.gameB);
    const total = aggregateTotal(books, 2)!;
    expect(total.line).toBe(5.5);
  });
});

// ---- REAL NBA payloads (2026-27 season, captured read-only the day the Basketball plan was upgraded) -------------------------------------
import nbaOdds from "../../../fixtures/provider/nba-odds-2026-sample.json";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import { computeSportsMarketOutcome } from "@/lib/predictions/sports-resolution";

describe("NBA spread on real 2026-27 payloads — the proof that gates enabling SPREAD for the NBA", () => {
  const nba = getSportConfig("basketball")!;
  const games = Object.entries(nbaOdds.odds).map(([id, item]) => {
    const books = (item as { bookmakers: Parameters<typeof normalizeBookmaker>[1][] }).bookmakers.map((b) => normalizeBookmaker(nba, b));
    const ml = aggregateMoneyline(books, 2)!;
    const spread = aggregateSpread(books, 2, ml.homeProbability, nba.spreadMainLineBand);
    const names = (nbaOdds.games as Record<string, { home: string; away: string }>)[id];
    return { id, books, ml, spread, ...names };
  });

  it("every captured game (8–9 bookmakers each) yields a spread — none refused, none from fewer than 2 books", () => {
    expect(games).toHaveLength(6);
    for (const g of games) {
      expect(g.spread, g.id).not.toBeNull();
      expect(g.spread!.bookmakerCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("TEAM / SIDE ORIENTATION: the line is the HOME handicap — a home moneyline favourite lays points, a home underdog gets them (6 of 6 real games)", () => {
    for (const g of games) {
      if (g.ml.homeProbability > 0.55) expect(g.spread!.homeLine, `${g.home} (home favourite)`).toBeLessThan(0);
      if (g.ml.homeProbability < 0.45) expect(g.spread!.homeLine, `${g.home} (home underdog)`).toBeGreaterThan(0);
    }
    const byHome = Object.fromEntries(games.map((g) => [g.home, g.spread!.homeLine]));
    expect(byHome["Golden State Warriors"]).toBe(-7); // home favourite (moneyline 0.68)
    expect(byHome["Milwaukee Bucks"]).toBe(5.5); // home underdog (0.36) to the Timberwolves
    expect(byHome["Charlotte Hornets"]).toBe(-5); // home favourite (0.63)
  });

  it("SIGN ORIENTATION: the HOME side's fair cover probability is a coin flip at the chosen line, which is only true if the sign is the home handicap's (a flipped reading would put it far from 0.5)", () => {
    for (const g of games) expect(Math.abs(g.spread!.homeCoverProbability - 0.5)).toBeLessThan(0.05);
  });

  it("CANONICAL YES-SIDE MAPPING + PRESENTATION: YES = the home team at the signed line; the two buttons read in Away @ Home order with the opposite sign on the opponent", () => {
    for (const g of games) {
      const line = g.spread!.homeLine;
      const p = getChoicePresentation({ marketTemplate: "SPREAD", lineValue: line, yesSide: "HOME", homeTeamName: g.home, awayTeamName: g.away, sport: "basketball" });
      const yes = p.choices.find((c) => c.outcome === "YES")!;
      const no = p.choices.find((c) => c.outcome === "NO")!;
      const sign = (n: number) => (n === 0 ? "PK" : n > 0 ? `+${n}` : `-${Math.abs(n)}`);
      expect(yes.label).toBe(`${g.home} ${sign(line)}`);
      expect(no.label).toBe(`${g.away} ${sign(-line)}`);
      expect(p.choices.map((c) => c.outcome)).toEqual(["NO", "YES"]); // away first for the NBA
      expect(yes.accessibleName).toBe(`Pick ${g.home} ${line > 0 ? "plus" : "minus"} ${Math.abs(line)}`);
      expect(p.marketLabel).toBe("Spread");
    }
  });

  it("GRADING on the real lines: cover / non-cover / push, for the home side (YES) at each real line", () => {
    for (const g of games) {
      const line = g.spread!.homeLine;
      const def = { marketTemplate: "SPREAD" as const, lineValue: line, yesSide: "HOME" as const };
      const final = (home: number, away: number) => ({ id: "x", sport: "basketball", internalStatus: "COMPLETED", homeScore: home, awayScore: away });
      // the home side covers when (home + line) > away. (A basketball final can never be level, so the constructed scores avoid a tie.)
      const away = 110;
      const homeFor = (margin: number) => {
        const home = away - line + margin;
        return home === away ? home + Math.sign(margin) * 2 : home; // never a level final
      };
      expect(computeSportsMarketOutcome(def, final(homeFor(1), away)), `${g.home} covers`).toBe("YES");
      expect(computeSportsMarketOutcome(def, final(homeFor(-1), away)), `${g.home} does not cover`).toBe("NO");
      if (Number.isInteger(line) && away - line !== away) expect(computeSportsMarketOutcome(def, final(away - line, away)), `${g.home} push`).toBe("VOID");
    }
  });

  it("the Total on the same real games: a coin-flip line from 4–9 books, graded Over/Under with the sport's own unit ('points')", () => {
    for (const g of games) {
      const total = aggregateTotal(g.books, 2)!;
      expect(Math.abs(total.overProbability - 0.5)).toBeLessThan(0.05);
      const p = getChoicePresentation({ marketTemplate: "TOTAL", lineValue: total.line, yesSide: null, homeTeamName: g.home, awayTeamName: g.away, sport: "basketball" });
      expect(p.choices.find((c) => c.outcome === "YES")!.accessibleName).toBe(`Pick Over ${total.line} total points`);
    }
  });
});

// ---- REAL NFL payloads (week of 2026-10-08, 13 games, captured read-only) — the proof that gates enabling SPREAD for the NFL ---------------------
import nflWeek from "../../../fixtures/provider/nfl-odds-week-sample.json";

describe("NFL spread on 13 real games — the proof that gates enabling SPREAD for the NFL", () => {
  const nfl = getSportConfig("american_football")!;
  const games = Object.entries(nflWeek.odds).map(([id, item]) => {
    const books = (item as { bookmakers: Parameters<typeof normalizeBookmaker>[1][] }).bookmakers.map((b) => normalizeBookmaker(nfl, b));
    const ml = aggregateMoneyline(books, 2)!;
    const spread = aggregateSpread(books, 2, ml.homeProbability, nfl.spreadMainLineBand);
    const names = (nflWeek.games as Record<string, { home: string; away: string }>)[id];
    return { id, books, ml, spread, ...names };
  });

  it("every one of the 13 games yields a spread, each from at least 4 bookmakers (the NFL's coverage is deep, unlike a single-game sample suggested)", () => {
    expect(games).toHaveLength(13);
    for (const g of games) {
      expect(g.spread, g.id).not.toBeNull();
      expect(g.spread!.bookmakerCount).toBeGreaterThanOrEqual(4);
    }
  });

  it("TEAM / SIDE ORIENTATION (13 of 13): a home moneyline favourite lays points, a home underdog gets them", () => {
    for (const g of games) {
      if (g.ml.homeProbability > 0.55) expect(g.spread!.homeLine, `${g.home} (home favourite)`).toBeLessThan(0);
      if (g.ml.homeProbability < 0.45) expect(g.spread!.homeLine, `${g.home} (home underdog)`).toBeGreaterThan(0);
    }
    const byHome = Object.fromEntries(games.map((g) => [g.home, g.spread!.homeLine]));
    expect(byHome["Dallas Cowboys"]).toBe(-9.5); // home favourite, moneyline 0.79
    expect(byHome["Tennessee Titans"]).toBe(6.5); // home underdog to the Texans, 0.28
    expect(byHome["Miami Dolphins"]).toBe(8.5); // home underdog, 0.21
    expect(byHome["Arizona Cardinals"]).toBe(5.5);
  });

  it("SIGN ORIENTATION: at every chosen line the home side's fair cover probability is a coin flip (0.50 ± 0.02) — only true if the sign is the home handicap's", () => {
    for (const g of games) expect(Math.abs(g.spread!.homeCoverProbability - 0.5), g.id).toBeLessThan(0.02);
  });

  it("CANONICAL YES-SIDE MAPPING + PRESENTATION: YES = home at the signed line; buttons read Away @ Home with the opposite sign on the opponent", () => {
    for (const g of games) {
      const line = g.spread!.homeLine;
      const p = getChoicePresentation({ marketTemplate: "SPREAD", lineValue: line, yesSide: "HOME", homeTeamName: g.home, awayTeamName: g.away, sport: "american_football" });
      const sign = (n: number) => (n === 0 ? "PK" : n > 0 ? `+${n}` : `-${Math.abs(n)}`);
      expect(p.choices.find((c) => c.outcome === "YES")!.label).toBe(`${g.home} ${sign(line)}`);
      expect(p.choices.find((c) => c.outcome === "NO")!.label).toBe(`${g.away} ${sign(-line)}`);
      expect(p.choices.map((c) => c.outcome)).toEqual(["NO", "YES"]);
      expect(p.choices.find((c) => c.outcome === "YES")!.accessibleName).toBe(`Pick ${g.home} ${line > 0 ? "plus" : "minus"} ${Math.abs(line)}`);
    }
  });

  it("GRADING on the real lines: cover / non-cover / push (a push is VOID, never the opposite side)", () => {
    for (const g of games) {
      const line = g.spread!.homeLine;
      const def = { marketTemplate: "SPREAD" as const, lineValue: line, yesSide: "HOME" as const };
      const final = (home: number, away: number) => ({ id: "x", sport: "american_football", internalStatus: "COMPLETED", homeScore: home, awayScore: away });
      const away = 24;
      expect(computeSportsMarketOutcome(def, final(away - line + 1, away)), `${g.home} covers`).toBe("YES");
      expect(computeSportsMarketOutcome(def, final(away - line - 1, away)), `${g.home} does not cover`).toBe("NO");
      if (Number.isInteger(line)) expect(computeSportsMarketOutcome(def, final(away - line, away))).toBe("VOID");
    }
  });

  it("the Total on the same real games stays a coin-flip line from 3+ books, in 'points'", () => {
    for (const g of games) {
      const total = aggregateTotal(g.books, 2)!;
      expect(Math.abs(total.overProbability - 0.5)).toBeLessThan(0.02);
      expect(getChoicePresentation({ marketTemplate: "TOTAL", lineValue: total.line, yesSide: null, homeTeamName: g.home, awayTeamName: g.away, sport: "american_football" }).choices[0].accessibleName).toBe(`Pick Over ${total.line} total points`);
    }
  });
});
