import { describe, expect, it, vi } from "vitest";
import { activeSportConfigs, canEndLevel, getScoreUnit, getSportConfig, getSportConfigByProvider, getStartTerm, isAwayFirstSport, isSportActive, isSupportedLeague, liveSportConfigs, SPORT_CONFIGS } from "@/lib/sports-data/sport-registry";
import { getOddsProvider, getSportsProvider, isKnownProvider } from "@/lib/sports-data/provider-registry";
import { formatMatchup, formatMatchupSpoken, getMatchupSeparator } from "@/lib/sports-data/team-display-order";

vi.mock("server-only", () => ({}));

const at = (iso: string) => new Date(iso);

describe("the shared sport registry", () => {
  it("one provider identity per sport, all unique, and every identity round-trips", () => {
    expect(new Set(SPORT_CONFIGS.map((c) => c.provider)).size).toBe(SPORT_CONFIGS.length);
    expect(new Set(SPORT_CONFIGS.map((c) => c.sport)).size).toBe(SPORT_CONFIGS.length);
    for (const c of SPORT_CONFIGS) {
      expect(getSportConfig(c.sport)).toBe(c);
      expect(getSportConfigByProvider(c.provider)).toBe(c);
    }
  });

  it("`live` sports are exactly the ones with a registered adapter; MLB is declared but cannot be launched", () => {
    for (const c of SPORT_CONFIGS) {
      expect(isKnownProvider(c.provider), c.provider).toBe(c.status === "live");
      expect(getSportsProvider(c.provider) !== null).toBe(c.status === "live");
      expect(getOddsProvider(c.provider) !== null).toBe(c.status === "live");
    }
    expect(liveSportConfigs().map((c) => c.sport)).toEqual(["american_football", "basketball", "hockey"]);
    expect(getSportConfig("baseball")!.status).toBe("declared");
    // Even with the env flag set, MLB is never active: no adapter, no launch.
    expect(activeSportConfigs({ API_MLB_ENABLED: "true" })).toEqual([]);
  });

  it("activation is configuration: a sport is active only when its own env flag is 'true'", () => {
    const nba = getSportConfig("basketball")!;
    expect(isSportActive(nba, {})).toBe(false);
    expect(isSportActive(nba, { API_NBA_ENABLED: "true" })).toBe(true);
    expect(isSportActive(nba, { API_NBA_ENABLED: "1" })).toBe(false);
    expect(activeSportConfigs({ API_NFL_ENABLED: "true", API_NHL_ENABLED: "true" }).map((c) => c.sport)).toEqual(["american_football", "hockey"]);
  });

  it("league allowlists are per sport (league id '1' is the NFL's AND MLB's, so support is always judged against the sport)", () => {
    const nfl = getSportConfig("american_football")!;
    const mlb = getSportConfig("baseball")!;
    expect(isSupportedLeague(nfl, "1")).toBe(true);
    expect(isSupportedLeague(getSportConfig("basketball")!, "12")).toBe(true);
    expect(isSupportedLeague(getSportConfig("basketball")!, "20")).toBe(false); // G League
    expect(isSupportedLeague(getSportConfig("basketball")!, "422")).toBe(false); // NBA Cup
    expect(isSupportedLeague(getSportConfig("hockey")!, "57")).toBe(true);
    expect(isSupportedLeague(getSportConfig("hockey")!, "271")).toBe(false); // 4 Nations
    expect(isSupportedLeague(mlb, "71")).toBe(false); // spring training
    expect(isSupportedLeague(nfl, null)).toBe(false);
  });

  it("season naming is the provider's convention for each sport", () => {
    const nfl = getSportConfig("american_football")!;
    const nba = getSportConfig("basketball")!;
    const nhl = getSportConfig("hockey")!;
    // NFL: the year the season STARTS in (Aug-Feb) — January/February are still last autumn's season. (The old plain-UTC-year rule asked the
    // provider for season "2027" from 2027-01-01, silently dropping the final regular-season weeks and the playoffs.)
    expect(nfl.seasonFor(at("2026-08-07T12:00:00Z"))).toBe("2026"); // hall of fame game
    expect(nfl.seasonFor(at("2026-10-06T12:00:00Z"))).toBe("2026");
    expect(nfl.seasonFor(at("2026-12-31T23:00:00Z"))).toBe("2026");
    expect(nfl.seasonFor(at("2027-01-01T00:00:00Z"))).toBe("2026"); // the boundary that used to break
    expect(nfl.seasonFor(at("2027-01-10T20:00:00Z"))).toBe("2026"); // week 18
    expect(nfl.seasonFor(at("2027-02-14T12:00:00Z"))).toBe("2026"); // super bowl
    expect(nfl.seasonFor(at("2027-07-15T12:00:00Z"))).toBe("2027");
    // NBA: "YYYY-YYYY+1", rolls over in July.
    expect(nba.seasonFor(at("2026-10-06T12:00:00Z"))).toBe("2026-2027");
    expect(nba.seasonFor(at("2027-04-30T12:00:00Z"))).toBe("2026-2027");
    expect(nba.seasonFor(at("2027-06-20T12:00:00Z"))).toBe("2026-2027"); // finals still the old season
    expect(nba.seasonFor(at("2027-07-02T12:00:00Z"))).toBe("2027-2028");
    // NHL: the start year, rolls over in July.
    expect(nhl.seasonFor(at("2026-10-06T12:00:00Z"))).toBe("2026");
    expect(nhl.seasonFor(at("2027-01-15T12:00:00Z"))).toBe("2026");
    expect(nhl.seasonFor(at("2027-06-10T12:00:00Z"))).toBe("2026");
    expect(nhl.seasonFor(at("2027-07-01T12:00:00Z"))).toBe("2027");
  });

  it("matchup order, vocabulary and ties come from one place — and no sport's name is special-cased by callers", () => {
    for (const sport of ["american_football", "basketball", "hockey", "baseball"]) expect(isAwayFirstSport(sport)).toBe(true);
    expect(isAwayFirstSport("football")).toBe(false); // retired soccer history keeps "Home vs Away"
    expect(isAwayFirstSport("")).toBe(false);
    expect(getStartTerm("american_football")).toBe("kickoff");
    expect(getStartTerm("basketball")).toBe("tipoff");
    expect(getStartTerm("hockey")).toBe("puck drop");
    expect(getStartTerm("unknown")).toBe("start");
    expect(getScoreUnit("basketball").plural).toBe("points");
    expect(getScoreUnit("hockey").plural).toBe("goals");
    expect(getScoreUnit("baseball").plural).toBe("runs");
    expect(getScoreUnit(undefined).plural).toBe("points");
    expect(canEndLevel("american_football")).toBe(true);
    for (const sport of ["basketball", "hockey", "baseball"]) expect(canEndLevel(sport)).toBe(false);
    expect(canEndLevel("football")).toBe(true); // unknown/retired: permissive
  });

  it("the shared matchup helper renders NFL, NBA and NHL the same way (Away @ Home / 'at' when spoken)", () => {
    for (const sport of ["american_football", "basketball", "hockey"]) {
      expect(formatMatchup(sport, "Celtics", "Lakers")).toBe("Lakers @ Celtics");
      expect(formatMatchupSpoken(sport, "Celtics", "Lakers")).toBe("Lakers at Celtics");
      expect(getMatchupSeparator(sport)).toBe("@");
    }
    expect(formatMatchup("football", "Arsenal", "Chelsea")).toBe("Arsenal vs Chelsea");
  });

  it("templates are the three canonical ones only, and the NFL's inventory is exactly what is live today", () => {
    for (const c of SPORT_CONFIGS) for (const t of c.marketTemplates) expect(["MONEYLINE", "SPREAD", "TOTAL"]).toContain(t);
    expect(getSportConfig("american_football")!.marketTemplates).toEqual(["MONEYLINE", "TOTAL"]);
    expect(getSportConfig("hockey")!.marketTemplates).toEqual(["MONEYLINE", "SPREAD", "TOTAL"]); // puck line verified on real 2026 NHL payloads
    expect(getSportConfig("basketball")!.marketTemplates).toEqual(["MONEYLINE", "SPREAD", "TOTAL"]); // NBA spread verified on real 2026-27 payloads
    expect(getSportConfig("hockey")!.spreadMainLineBand).toEqual([0.25, 0.75]);
    expect(getSportConfig("american_football")!.ingestionSource).toBe("nfl_market_ingestion");
    expect(getSportConfig("american_football")!.oddsWindow).toEqual({ kind: "sportsbook-week" });
  });

  it("NBA / NHL odds are bounded so a daily request budget can never be exhausted (the NFL incident class)", () => {
    for (const sport of ["basketball", "hockey"]) {
      const c = getSportConfig(sport)!;
      expect(c.oddsWindow.kind).toBe("hours");
      expect(c.oddsMinRefreshMinutes).toBeGreaterThan(0);
      expect(c.franchiseSource).toBe("standings");
    }
  });
});
