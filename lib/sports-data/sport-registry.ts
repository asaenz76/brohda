// THE shared sports registry — one row per supported sport, read by every layer that used to carry its own NFL assumption (provider routing,
// fixture sync, market ingestion, post publication, discovery, matchup order, terminology). The canonical product domain is identical for all
// of them — Game -> Post -> Market -> Pick -> Call BS -> optional Position -> grading — so this table holds ONLY what genuinely differs:
//
//   - who supplies the data (provider identity, API host, league, season naming, bet-catalog ids);
//   - how the sport is spoken (matchup order, start/score vocabulary);
//   - which canonical Market templates are offered and how far ahead odds are worth refreshing.
//
// It deliberately holds no grading rules: MONEYLINE / SPREAD / TOTAL are graded from a Game's final score by ONE function
// (lib/predictions/sports-resolution.ts) for every sport. Sport-specific result semantics (overtime, shootouts, extra innings) are resolved
// where the score is NORMALISED (each provider adapter's mapGame), so by the time a Game is COMPLETED its home/away score is already the
// official final score the Markets are graded on.
//
// Activation is configuration, not code: a sport is live only when its provider is enabled by environment (`API_<X>_ENABLED=true` + a key)
// — see isSportActive(). Nothing in the UI branches on a sport key; everything asks this registry.
import type { MarketTemplate } from "@/lib/prediction-markets/types";

export type SportKey = "american_football" | "basketball" | "hockey" | "baseball";

/** Provider identities stored in fixtures.provider / teams.provider / leagues.provider / provider_request_log.provider. One per upstream API: ids are only unique within one. */
export type ProviderName = "api_nfl" | "api_nba" | "api_nhl" | "api_mlb";

export interface SportLeagueConfig {
  /** The provider's own league id. A deliberate allowlist: a provider returns many leagues (summer leagues, G League, exhibitions) and only these are Brohda inventory. */
  externalLeagueId: string;
  name: string;
}

export interface SportConfig {
  sport: SportKey;
  provider: ProviderName;
  /** `live` = a provider adapter is registered and the sport can be activated; `declared` = architecturally supported but NOT launchable (no adapter) — MLB today. A unit test pins this against provider-registry.ts. */
  status: "live" | "declared";
  /** The league / sport as members know it ("NBA", "NHL"). */
  label: string;
  /** Sport-level community / navigation name ("Basketball"). */
  sportLabel: string;
  /** "Away @ Home" (true) vs "Home vs Away" (false) — the sport's own broadcast convention. */
  awayFirst: boolean;
  /** The word for the moment play starts, in copy: kickoff / tipoff / puck drop / first pitch. */
  startTerm: string;
  /** What a score is counted in, for accessible names ("points", "goals", "runs"). */
  scoreUnit: { singular: string; plural: string };
  /** Environment variable prefix: `${prefix}_ENABLED`, `${prefix}_KEY`, `${prefix}_BASE_URL`, `${prefix}_DAILY_REQUEST_BUDGET`. */
  envPrefix: string;
  defaultBaseUrl: string;
  leagues: SportLeagueConfig[];
  /** Provider "season" parameter for a given instant (providers disagree: 2026 vs "2026-2027"). Pure. */
  seasonFor(now: Date): string;
  /** The provider's bet-catalog ids for the three canonical templates (they differ per API even inside one vendor). */
  betIds: { moneyline: number; spread: number; total: number };
  /** Which canonical templates ingestion may create for this sport. Gradeable and presentable ones only; widening it is a one-line, reviewed change. */
  marketTemplates: readonly MarketTemplate[];
  /** The fair-probability band a quoted line must fall in to count as THE line rather than an alternate (see aggregate-spread.ts). */
  spreadMainLineBand: readonly [number, number];
  /** How far ahead of puck drop / tipoff odds are refreshed (48h: comfortably more than the daily ingestion cadence, so every Game is picked up at least once before it starts). `sportsbook-week` is the NFL's established window; `hours` bounds a daily-schedule sport. */
  oddsWindow: { kind: "sportsbook-week" } | { kind: "hours"; hours: number };
  /** Minimum minutes between odds refreshes for one Game (0 = every run). Protects a daily request budget. */
  oddsMinRefreshMinutes: number;
  /**
   * How a provider's league includes non-franchise "teams" (All-Star exhibitions), so they never become Teams / Communities.
   * `standings` = only teams that appear in the league's own standings table are franchises (data-driven: no hard-coded team list).
   */
  franchiseSource: "none" | "standings";
  /** `markets.ingestion_source` label stamped on Markets this sport's ingestion creates (a free-text diagnostic, not a key). */
  ingestionSource: string;
  /** How many franchises the league has — what a readiness check compares synced Teams against. Changes only on expansion (a reviewed edit here). */
  expectedTeamCount: number;
  /** Whether a finished game can end level. False for basketball / hockey / baseball: a COMPLETED level score there is an inconsistent provider result and is never graded. */
  tiesPossible: boolean;
}

const utcYear = (now: Date) => now.getUTCFullYear();
// Seasons that start in autumn and end the following summer: July onward belongs to the season that starts that year.
const autumnStartYear = (now: Date) => (now.getUTCMonth() >= 6 ? utcYear(now) : utcYear(now) - 1);
const autumnStartSeason = (now: Date) => String(autumnStartYear(now));

export const SPORT_CONFIGS: readonly SportConfig[] = [
  {
    sport: "american_football",
    status: "live",
    provider: "api_nfl",
    label: "NFL",
    sportLabel: "American Football",
    awayFirst: true,
    startTerm: "kickoff",
    scoreUnit: { singular: "point", plural: "points" },
    envPrefix: "API_NFL",
    defaultBaseUrl: "https://v1.american-football.api-sports.io",
    // externalLeagueId "1" confirmed live; "2" = NCAA, deliberately not supported.
    leagues: [{ externalLeagueId: "1", name: "NFL" }],
    // API-NFL's `season` is the calendar year the season STARTS in (Aug-Feb): the 2026 season is Aug 2026 - Feb 2027, so January and February
    // 2027 are still season "2026". (The previous rule — the plain UTC year — requested season "2027" from 2027-01-01, which would have stopped the
    // final regular-season weeks and the whole postseason from syncing or grading. Production data confirms every game through 2027-01-10 is
    // season "2026".) Same July rollover as the other autumn-start sports.
    seasonFor: autumnStartSeason,
    betIds: { moneyline: 1, spread: 2, total: 3 },
    // SPREAD enabled for the NFL on the owner's instruction (2026-10-07), after verifying 13 real games (4-6 bookmakers each): orientation, sign, canonical
    // YES-side mapping, grading and presentation — see tests/unit/prediction-markets/ingestion/aggregate-spread.test.ts.
    marketTemplates: ["MONEYLINE", "SPREAD", "TOTAL"],
    spreadMainLineBand: [0.35, 0.65],
    oddsWindow: { kind: "sportsbook-week" },
    oddsMinRefreshMinutes: 0,
    franchiseSource: "none",
    ingestionSource: "nfl_market_ingestion",
    expectedTeamCount: 32,
    tiesPossible: true,
  },
  {
    sport: "basketball",
    status: "live",
    provider: "api_nba",
    label: "NBA",
    sportLabel: "Basketball",
    awayFirst: true,
    startTerm: "tipoff",
    scoreUnit: { singular: "point", plural: "points" },
    envPrefix: "API_NBA",
    defaultBaseUrl: "https://v1.basketball.api-sports.io",
    // NBA is league 12 (confirmed live). G League (20), summer leagues, NBA Cup (422) and the W League (13) are separate leagues and are NOT Brohda inventory.
    leagues: [{ externalLeagueId: "12", name: "NBA" }],
    // Provider seasons are strings like "2026-2027" (confirmed live).
    seasonFor: (now) => {
      const start = autumnStartYear(now);
      return `${start}-${start + 1}`;
    },
    betIds: { moneyline: 2, spread: 3, total: 4 },
    // SPREAD is on for the NBA: its Asian Handicap convention, sign and side orientation were verified on real 2026-27 NBA payloads (6 games, 8-9 bookmakers each).
    marketTemplates: ["MONEYLINE", "SPREAD", "TOTAL"],
    spreadMainLineBand: [0.35, 0.65],
    oddsWindow: { kind: "hours", hours: 48 },
    oddsMinRefreshMinutes: 60,
    franchiseSource: "standings",
    ingestionSource: "nba_market_ingestion",
    expectedTeamCount: 30,
    tiesPossible: false,
  },
  {
    sport: "hockey",
    status: "live",
    provider: "api_nhl",
    label: "NHL",
    sportLabel: "Hockey",
    awayFirst: true,
    startTerm: "puck drop",
    scoreUnit: { singular: "goal", plural: "goals" },
    envPrefix: "API_NHL",
    defaultBaseUrl: "https://v1.hockey.api-sports.io",
    // NHL is league 57 (confirmed live); 271 = "NHL 4 Nations Face-Off" is a separate event and is not inventory.
    leagues: [{ externalLeagueId: "57", name: "NHL" }],
    // Provider seasons are the start year (season 2026 = 2026-09-19 .. 2027-04-11, confirmed live).
    seasonFor: (now) => String(autumnStartYear(now)),
    betIds: { moneyline: 2, spread: 3, total: 4 },
    // SPREAD (the puck line) is on for the NHL: its Asian Handicap convention was verified on real 2026 NHL payloads (BetVictor, Betano), see docs/SPORTS_AUDIT_NHL_NBA.md.
    marketTemplates: ["MONEYLINE", "SPREAD", "TOTAL"],
    // The puck line is always ±1.5, so its two sides are lopsided by nature (confirmed on real 2026 NHL payloads: a fair 0.31 / 0.39 for the home -1.5).
    spreadMainLineBand: [0.25, 0.75],
    oddsWindow: { kind: "hours", hours: 48 },
    oddsMinRefreshMinutes: 60,
    franchiseSource: "standings",
    ingestionSource: "nhl_market_ingestion",
    expectedTeamCount: 32,
    tiesPossible: false,
  },
  {
    sport: "baseball",
    status: "declared",
    provider: "api_mlb",
    label: "MLB",
    sportLabel: "Baseball",
    awayFirst: true,
    startTerm: "first pitch",
    scoreUnit: { singular: "run", plural: "runs" },
    envPrefix: "API_MLB",
    defaultBaseUrl: "https://v1.baseball.api-sports.io",
    // MLB is league 1 (confirmed live); 71 = Spring Training is not inventory.
    leagues: [{ externalLeagueId: "1", name: "MLB" }],
    seasonFor: (now) => String(utcYear(now)),
    betIds: { moneyline: 2, spread: 3, total: 4 },
    marketTemplates: ["MONEYLINE", "TOTAL"],
    spreadMainLineBand: [0.35, 0.65],
    oddsWindow: { kind: "hours", hours: 48 },
    oddsMinRefreshMinutes: 60,
    franchiseSource: "none",
    ingestionSource: "mlb_market_ingestion",
    expectedTeamCount: 30,
    tiesPossible: false,
  },
];

const BY_SPORT = new Map<string, SportConfig>(SPORT_CONFIGS.map((c) => [c.sport, c]));
const BY_PROVIDER = new Map<string, SportConfig>(SPORT_CONFIGS.map((c) => [c.provider, c]));

export function getSportConfig(sport: string | null | undefined): SportConfig | null {
  return sport ? (BY_SPORT.get(sport) ?? null) : null;
}

export function getSportConfigByProvider(provider: string | null | undefined): SportConfig | null {
  return provider ? (BY_PROVIDER.get(provider) ?? null) : null;
}

/** "Away @ Home" sports. Unknown sports (retired football/soccer history) keep the "Home vs Away" default. */
export function isAwayFirstSport(sport: string): boolean {
  return getSportConfig(sport)?.awayFirst ?? false;
}

/** Sport-level display name for Communities and navigation; unknown sports fall back to a humanised key. */
export function getSportLabel(sport: string): string | null {
  return getSportConfig(sport)?.sportLabel ?? null;
}

export function getScoreUnit(sport: string | null | undefined): { singular: string; plural: string } {
  return getSportConfig(sport)?.scoreUnit ?? { singular: "point", plural: "points" };
}

export function getStartTerm(sport: string | null | undefined): string {
  return getSportConfig(sport)?.startTerm ?? "start";
}

/** Whether `leagueExternalId` is one of this sport's allowlisted league ids. */
export function isSupportedLeague(config: SportConfig, leagueExternalId: string | null | undefined): boolean {
  return leagueExternalId != null && config.leagues.some((l) => l.externalLeagueId === leagueExternalId);
}

/** Activation is configuration: the provider's own env flag. (Server-side only.) */
export function isSportActive(config: SportConfig, env: Record<string, string | undefined> = process.env): boolean {
  return env[`${config.envPrefix}_ENABLED`] === "true";
}

export function activeSportConfigs(env: Record<string, string | undefined> = process.env): SportConfig[] {
  return SPORT_CONFIGS.filter((c) => c.status === "live" && isSportActive(c, env));
}

/** Can a finished game of this sport end level? Unknown sports (retired football/soccer history) keep the permissive NFL-style answer. */
export function canEndLevel(sport: string | null | undefined): boolean {
  return getSportConfig(sport)?.tiesPossible ?? true;
}

/** The sports a provider adapter exists for (client-safe: derived from the registry's own `status`). */
export function liveSportConfigs(): SportConfig[] {
  return SPORT_CONFIGS.filter((c) => c.status === "live");
}
