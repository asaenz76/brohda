import "server-only";
import { fetchWithRetry } from "./http";
import { normalizeApiBasketballStatus, normalizeApiHockeyStatus } from "./status-map";
import type {
  FixtureSearchParams,
  NormalizedFixture,
  NormalizedFixtureEvent,
  NormalizedLeague,
  NormalizedPlayer,
  NormalizedRawFixtureOdds,
  NormalizedTeam,
  RawBookmakerOdds,
  RawOddsValue,
  SportsOddsProvider,
} from "./types";
import { ProviderApiError } from "./provider-errors";
import { getCachedRawOdds, setCachedRawOdds } from "./odds-raw-cache";
import { API_NBA_PROVIDER, API_NHL_PROVIDER } from "./provider-names";
import { SPORT_CONFIGS, type SportConfig } from "./sport-registry";

// The shared adapter for API-Sports' basketball and hockey products (same vendor, same envelope, same key, same bet-catalog format as the NFL
// product — but each has its own game record shape, which is the ONLY thing that differs and therefore the only thing mapped per sport below).
// Everything else — HTTP, retry, request logging / circuit breaker (fetchWithRetry), the odds cache, the Brohda NormalizedFixture contract —
// is the same code every provider already uses.
//
// Response shapes below are transcribed from REAL payloads captured against historical seasons (basketball 2024-2025: 1,387 games; hockey 2024:
// 1,503 games), not vendor docs. What was and was not confirmed is stated on each interface.

// ---- raw shapes -------------------------------------------------------------------------------------------------------------------

interface RawTeam {
  id: number;
  name: string | null;
  logo: string | null;
}

interface RawGameCommon {
  id: number;
  timestamp: number; // Unix seconds, UTC (confirmed)
  timezone: string | null; // always "UTC" in every captured game
  week: string | null; // a playoff-round / event label when present; NOT a reliable stage flag (see docs/SPORTS_AUDIT_NHL_NBA.md)
  status: { long: string | null; short: string | null; timer?: number | string | null };
  league: { id: number; name: string; season: string | number; logo: string | null };
  country: { name: string | null } | null;
  teams: { home: RawTeam; away: RawTeam };
}

/** Hockey (confirmed live): `scores` is the OFFICIAL final score as a plain integer pair. For a shootout game ("AP", After Penalties) it already contains the credited shootout-deciding goal: in 79 of 79 observed 2024 shootout games it equals regulation + overtime goals + exactly 1 for the winner, and no final game was ever tied. For an overtime game ("AOT") it equals the period sum. `periods` holds "home-away" strings per period, `penalties` the shootout goals actually scored. */
export interface RawHockeyGame extends RawGameCommon {
  scores: { home: number | null; away: number | null };
  periods: { first: string | null; second: string | null; third: string | null; overtime: string | null; penalties: string | null } | null;
}

/** Basketball (confirmed live): `total` already includes overtime (equals quarters + over_time in all 140 observed "AOT" games). `over_time` is the combined points of all overtime periods. Exhibition games (All-Star) carry no quarter breakdown. */
export interface RawBasketballGame extends RawGameCommon {
  venue: string | null;
  scores: {
    home: { quarter_1: number | null; quarter_2: number | null; quarter_3: number | null; quarter_4: number | null; over_time: number | null; total: number | null };
    away: { quarter_1: number | null; quarter_2: number | null; quarter_3: number | null; quarter_4: number | null; over_time: number | null; total: number | null };
  };
}

interface GameListResponse<G> {
  response: G[];
}

// ---- mapping ----------------------------------------------------------------------------------------------------------------------

/** "2-1" -> [2, 1]; anything else (null, "0-0 ", garbage) -> null. Never throws. */
export function parseScorePair(value: string | null | undefined): [number, number] | null {
  if (!value) return null;
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function sumPairs(pairs: Array<[number, number] | null>): [number, number] | null {
  if (pairs.some((p) => p === null)) return null;
  return (pairs as Array<[number, number]>).reduce<[number, number]>((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
}

function timerToMinutes(timer: number | string | null | undefined): number | null {
  return typeof timer === "number" ? timer : null;
}

function mapCommon(config: SportConfig, raw: RawGameCommon): Omit<NormalizedFixture, "internalStatus" | "homeScore" | "awayScore" | "halftimeHomeScore" | "halftimeAwayScore" | "regulationHomeScore" | "regulationAwayScore" | "extraTimeHomeScore" | "extraTimeAwayScore" | "penaltyHomeScore" | "penaltyAwayScore" | "venueName" | "venueCity" | "venueTimezone"> {
  return {
    provider: config.provider,
    externalFixtureId: String(raw.id),
    sport: config.sport,
    competitionExternalId: String(raw.league.id),
    competitionName: raw.league.name,
    competitionCountry: raw.country?.name ?? null,
    competitionLogoUrl: raw.league.logo ?? null,
    season: String(raw.league.season),
    // A playoff-round / event label when the provider supplies one, else null (regular-season games carry none).
    round: raw.week ?? null,
    homeTeamExternalId: raw.teams.home?.id != null ? String(raw.teams.home.id) : null,
    homeTeamName: raw.teams.home?.name as string,
    homeTeamLogoUrl: raw.teams.home?.logo ?? null,
    awayTeamExternalId: raw.teams.away?.id != null ? String(raw.teams.away.id) : null,
    awayTeamName: raw.teams.away?.name as string,
    awayTeamLogoUrl: raw.teams.away?.logo ?? null,
    scheduledStartUtc: new Date(raw.timestamp * 1000).toISOString(),
    providerTimezone: raw.timezone ?? null,
    providerStatusCode: raw.status.short,
    providerStatusDescription: raw.status.long,
    elapsedMinutes: timerToMinutes(raw.status.timer),
    providerPayload: raw,
  };
}

export function mapHockeyGame(config: SportConfig, raw: RawHockeyGame): NormalizedFixture {
  const periods = raw.periods;
  const first = parseScorePair(periods?.first);
  const second = parseScorePair(periods?.second);
  const third = parseScorePair(periods?.third);
  const overtime = parseScorePair(periods?.overtime);
  const shootout = parseScorePair(periods?.penalties);
  const regulation = sumPairs([first, second, third]);
  const firstTwo = sumPairs([first, second]);
  return {
    ...mapCommon(config, raw),
    venueName: null,
    venueCity: null,
    venueTimezone: null,
    internalStatus: normalizeApiHockeyStatus(raw.status.short),
    // The OFFICIAL final score: overtime included, shootout winner credited one goal (confirmed against 79/79 provider shootout games). This is
    // what every Market is graded on; nothing is added or subtracted here.
    homeScore: raw.scores?.home ?? null,
    awayScore: raw.scores?.away ?? null,
    halftimeHomeScore: firstTwo?.[0] ?? null, // no halftime in hockey; first two periods, informational only
    halftimeAwayScore: firstTwo?.[1] ?? null,
    regulationHomeScore: regulation?.[0] ?? null, // goals after three periods, informational
    regulationAwayScore: regulation?.[1] ?? null,
    extraTimeHomeScore: overtime?.[0] ?? null,
    extraTimeAwayScore: overtime?.[1] ?? null,
    penaltyHomeScore: shootout?.[0] ?? null, // shootout goals scored (informational — already reflected in the final score as +1 for the winner)
    penaltyAwayScore: shootout?.[1] ?? null,
  };
}

export function mapBasketballGame(config: SportConfig, raw: RawBasketballGame): NormalizedFixture {
  const home = raw.scores?.home;
  const away = raw.scores?.away;
  const quarters = (s: typeof home, ...qs: Array<1 | 2 | 3 | 4>) => {
    if (!s) return null;
    const values = qs.map((q) => s[`quarter_${q}` as const]);
    return values.some((v) => v == null) ? null : (values as number[]).reduce((a, b) => a + b, 0);
  };
  return {
    ...mapCommon(config, raw),
    venueName: raw.venue ?? null,
    venueCity: null,
    venueTimezone: null,
    internalStatus: normalizeApiBasketballStatus(raw.status.short),
    homeScore: home?.total ?? null, // official final, overtime included (confirmed)
    awayScore: away?.total ?? null,
    halftimeHomeScore: quarters(home, 1, 2),
    halftimeAwayScore: quarters(away, 1, 2),
    regulationHomeScore: quarters(home, 1, 2, 3, 4),
    regulationAwayScore: quarters(away, 1, 2, 3, 4),
    extraTimeHomeScore: home?.over_time ?? null,
    extraTimeAwayScore: away?.over_time ?? null,
    penaltyHomeScore: null,
    penaltyAwayScore: null,
  };
}

// ---- odds -------------------------------------------------------------------------------------------------------------------------

interface RawOddsBet {
  id: number;
  name: string;
  values: Array<{ value: string; odd: string }>;
}

interface RawOddsBookmaker {
  id: number;
  name: string;
  bets: RawOddsBet[];
}

interface RawOddsItem {
  update: string | null;
  bookmakers: RawOddsBookmaker[];
}

// A bet id is only trusted when the catalog still calls it what we think it is. The three templates map to bets the vendor names exactly
// like this in every API-Sports product (confirmed in the basketball, hockey and NFL bet catalogs); a renumbered catalog fails closed (the
// bet is treated as absent and no Market is created) instead of quietly reading the wrong market.
const EXPECTED_BET_NAME = { moneyline: "Home/Away", spread: "Asian Handicap", total: "Over/Under" } as const;

export function rawValuesForBet(bookmaker: RawOddsBookmaker, id: number, expectedName: string): RawOddsValue[] {
  const bet = bookmaker.bets.find((b) => b.id === id && b.name === expectedName);
  return bet ? bet.values.map((v) => ({ value: v.value, odd: Number(v.odd) })) : [];
}

export function normalizeBookmaker(config: SportConfig, bookmaker: RawOddsBookmaker): RawBookmakerOdds {
  return {
    bookmakerId: bookmaker.id,
    bookmakerName: bookmaker.name,
    moneyline: rawValuesForBet(bookmaker, config.betIds.moneyline, EXPECTED_BET_NAME.moneyline),
    asianHandicap: rawValuesForBet(bookmaker, config.betIds.spread, EXPECTED_BET_NAME.spread),
    gameTotal: rawValuesForBet(bookmaker, config.betIds.total, EXPECTED_BET_NAME.total),
  };
}

// ---- provider ---------------------------------------------------------------------------------------------------------------------

const MAX_SEASON_GAMES = 2500; // a full NBA/NHL season incl. preseason and playoffs is ~1,400-1,550; defensive cap against a malformed response

export class ApiSportsProvider implements SportsOddsProvider {
  readonly name: string;

  constructor(
    private readonly config: SportConfig,
    private readonly mapGame: (config: SportConfig, raw: never) => NormalizedFixture,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.name = config.provider;
  }

  isEnabled(): boolean {
    return this.env[`${this.config.envPrefix}_ENABLED`] === "true";
  }

  private baseUrl(): string {
    return this.env[`${this.config.envPrefix}_BASE_URL`] || this.config.defaultBaseUrl;
  }

  // One API-Sports account key authenticates every product (each product has its own subscription/plan); a sport-specific key wins when set.
  private headers(): HeadersInit {
    const key = this.env[`${this.config.envPrefix}_KEY`] || this.env.API_SPORTS_KEY || this.env.API_NFL_KEY || "";
    return { "x-apisports-key": key };
  }

  private async get<T>(path: string, params: Record<string, string>, requestType: string): Promise<T> {
    const url = new URL(`${this.baseUrl()}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const response = await fetchWithRetry(url.toString(), { headers: this.headers() }, { provider: this.name, requestType, requestParams: params });
    const body = (await response.json()) as T & { errors?: unknown };
    const errors = body.errors;
    const hasErrors = errors != null && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors as object).length > 0);
    if (hasErrors) {
      const summary = Array.isArray(errors) ? errors.map(String).join("; ") : Object.values(errors as Record<string, unknown>).map(String).join("; ");
      // e.g. the Free plan's "do not have access to this season" arrives as a 200 with `errors.plan` — surfaced, never swallowed as "no games".
      throw new ProviderApiError(`${this.config.label} provider request failed: ${summary}`, errors);
    }
    return body;
  }

  private async games(params: Record<string, string>, requestType: string): Promise<NormalizedFixture[]> {
    const body = await this.get<GameListResponse<never>>("/games", params, requestType);
    return (body.response ?? []).map((g) => this.mapGame(this.config, g));
  }

  async searchFixtures(params: FixtureSearchParams): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];
    if (params.externalFixtureId) {
      const fixture = await this.getFixtureById(params.externalFixtureId);
      return fixture ? [fixture] : [];
    }
    const query: Record<string, string> = {};
    if (params.teamExternalId) query.team = params.teamExternalId;
    if (params.competitionExternalId) query.league = params.competitionExternalId;
    if (params.season) query.season = params.season;
    if (params.date) query.date = params.date;
    return this.games(query, params.teamExternalId ? "search_by_team" : "search");
  }

  async getSeasonFixtures(externalLeagueId: string, season: string): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];
    const games = await this.games({ league: externalLeagueId, season }, "get_season_fixtures");
    if (games.length > MAX_SEASON_GAMES) {
      throw new Error(`Season fixture fetch for ${this.config.label} league ${externalLeagueId} season ${season} exceeded the defensive cap of ${MAX_SEASON_GAMES} games — aborting rather than importing a possibly-corrupt response.`);
    }
    return games;
  }

  async searchFixturesByDateRange(params: { fromDate: string; toDate: string; competitionExternalId?: string }): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];
    const query: Record<string, string> = { date: params.fromDate };
    if (params.competitionExternalId) query.league = params.competitionExternalId;
    return this.games(query, "search_by_date");
  }

  async getFixtureById(externalFixtureId: string): Promise<NormalizedFixture | null> {
    if (!this.isEnabled()) return null;
    return (await this.games({ id: externalFixtureId }, "get_by_id"))[0] ?? null;
  }

  private async leagues(params: Record<string, string>, requestType: string): Promise<NormalizedLeague[]> {
    const body = await this.get<{
      response: Array<{ id: number; name: string; type: string | null; logo: string | null; country: { name: string | null } | null; seasons: Array<{ season: string | number; current?: boolean | null; start: string; end: string }> }>;
    }>("/leagues", params, requestType);
    return (body.response ?? []).map((l) => ({
      provider: this.name,
      externalLeagueId: String(l.id),
      name: l.name,
      type: l.type ?? null,
      countryName: l.country?.name ?? null,
      logoUrl: l.logo ?? null,
      seasons: (l.seasons ?? []).map((s) => ({ year: String(s.season), startDate: s.start, endDate: s.end, current: s.current ?? false, coverage: null })),
    }));
  }

  async searchLeagues(query: string): Promise<NormalizedLeague[]> {
    if (!this.isEnabled()) return [];
    const trimmed = query.trim();
    return trimmed ? this.leagues({ search: trimmed }, "search_leagues") : this.leagues({}, "list_leagues");
  }

  async getLeagueById(externalLeagueId: string): Promise<NormalizedLeague | null> {
    if (!this.isEnabled()) return null;
    return (await this.leagues({ id: externalLeagueId }, "get_league_by_id"))[0] ?? null;
  }

  // Not needed by any Brohda flow (same stance as the NFL adapter): no team search UI, no league type branching, no play-by-play, no squads.
  async searchTeams(): Promise<NormalizedTeam[]> {
    return [];
  }
  async getLeagueType(): Promise<string | null> {
    return null;
  }
  async getFixtureEvents(): Promise<NormalizedFixtureEvent[]> {
    return [];
  }
  async getTeamSquad(): Promise<NormalizedPlayer[]> {
    return [];
  }

  /**
   * The league's franchises, from its own standings table (confirmed live: NBA 2024-25 -> exactly the 30 franchises, NHL 2024 -> exactly the 32;
   * the NBA's /teams list and game list ALSO contain the four All-Star exhibition "teams", which is why neither is used). Null when the provider
   * has no standings for that season yet (a brand-new season) — the caller decides what to do; this never guesses.
   */
  async getFranchiseTeamExternalIds(externalLeagueId: string, season: string): Promise<Set<string> | null> {
    if (!this.isEnabled()) return null;
    const body = await this.get<{ response: Array<Array<{ team: { id: number } }> | { team: { id: number } }> }>("/standings", { league: externalLeagueId, season }, "get_standings");
    const ids = new Set<string>();
    for (const group of body.response ?? []) {
      for (const entry of Array.isArray(group) ? group : [group]) {
        if (entry?.team?.id != null) ids.add(String(entry.team.id));
      }
    }
    return ids.size > 0 ? ids : null;
  }

  async getFixtureRawOdds(externalFixtureId: string): Promise<NormalizedRawFixtureOdds | null> {
    if (!this.isEnabled()) return null;
    let item = await getCachedRawOdds<RawOddsItem>(this.name, externalFixtureId);
    if (!item) {
      const body = await this.get<{ response: RawOddsItem[] }>("/odds", { game: externalFixtureId }, "get_odds");
      item = body.response?.[0] ?? null;
      if (item) await setCachedRawOdds(this.name, externalFixtureId, item);
    }
    if (!item) return null;
    return { externalFixtureId, providerUpdatedAt: item.update ?? null, bookmakers: item.bookmakers.map((b) => normalizeBookmaker(this.config, b)) };
  }
}

const configFor = (provider: string): SportConfig => {
  const config = SPORT_CONFIGS.find((c) => c.provider === provider);
  if (!config) throw new Error(`No sport config for provider ${provider}`);
  return config;
};

export const apiNbaProvider = new ApiSportsProvider(configFor(API_NBA_PROVIDER), mapBasketballGame as (config: SportConfig, raw: never) => NormalizedFixture);
export const apiNhlProvider = new ApiSportsProvider(configFor(API_NHL_PROVIDER), mapHockeyGame as (config: SportConfig, raw: never) => NormalizedFixture);
