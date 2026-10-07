import { describe, expect, it, vi } from "vitest";
import { aggregateSpread, SPREAD_MAIN_LINE_BAND } from "@/lib/prediction-markets/ingestion/aggregate-spread";
import { aggregateMoneyline } from "@/lib/prediction-markets/ingestion/aggregate-nfl-odds";
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
