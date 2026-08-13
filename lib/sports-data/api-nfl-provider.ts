import "server-only";
import { fetchWithRetry } from "./http";
import { normalizeApiNflStatus } from "./status-map";
import { resolveVenueTimezone } from "./timezone";
import type {
  FixtureSearchParams,
  NflBookmakerOdds,
  NflRawOddsValue,
  NormalizedFixture,
  NormalizedFixtureEvent,
  NormalizedFixtureMarkets,
  NormalizedFixtureOdds,
  NormalizedLeague,
  NormalizedNflFixtureOdds,
  NormalizedPlayer,
  NormalizedTeam,
  SportsDataProvider,
} from "./types";
import { ProviderApiError } from "./api-football-provider";

// API-NFL (api-sports.io's American-football sibling to API-Football).
// Shapes below are transcribed from real, live-verified responses (not
// vendor docs) — see the header comment on each interface for exactly
// what was confirmed and what wasn't.
const PROVIDER_NAME = "api_nfl";

// Confirmed live: /leagues returns { league: {id, name, logo}, country,
// seasons: [...] } — id: 1, name: "NFL". Only one season's coverage
// sub-object was inspected closely; "statisitcs" (not a typo introduced
// here — the real API response spells it this way) is left exactly as
// the provider returns it since nothing in this codebase currently reads
// that nested field.
interface ApiNflLeagueResponse {
  league: { id: number; name: string; logo: string | null };
  country: { name: string | null; code: string | null; flag: string | null } | null;
  seasons: Array<{
    year: number;
    start: string;
    end: string;
    current?: boolean;
  }>;
}

interface ApiNflLeagueListResponse {
  response: ApiNflLeagueResponse[];
}

// Confirmed live: /games?league=1&season=2026 (and a single-date variant
// implied by the same shape, per API-Sports' shared house convention —
// not independently re-verified for the date-only query form). `scores`
// is present with `total: null` and no per-quarter breakdown before a
// game starts (inferred from the NS-status game observed lacking a
// populated scores object in the same response batch — not captured
// verbatim, so every score field below is read defensively).
interface ApiNflGameResponse {
  game: {
    id: number;
    stage: string | null; // "Pre Season" | "Regular Season" | "Post Season" (confirmed live)
    week: string | null;
    date: { timezone: string | null; date: string; time: string; timestamp: number };
    venue: { name: string | null; city: string | null } | null;
    status: { short: string | null; long: string | null; timer: number | null };
  };
  league: {
    id: number;
    name: string;
    season: string | number;
    logo: string | null;
    country: { name: string | null; code: string | null; flag: string | null } | null;
  };
  teams: {
    home: { id: number; name: string; logo: string | null };
    away: { id: number; name: string; logo: string | null };
  };
  scores?: {
    home: { quarter_1: number | null; quarter_2: number | null; quarter_3: number | null; quarter_4: number | null; overtime: number | null; total: number | null };
    away: { quarter_1: number | null; quarter_2: number | null; quarter_3: number | null; quarter_4: number | null; overtime: number | null; total: number | null };
  };
}

interface ApiNflGameListResponse {
  response: ApiNflGameResponse[];
}

function isEnabled(): boolean {
  return process.env.API_NFL_ENABLED === "true";
}

function baseUrl(): string {
  return process.env.API_NFL_BASE_URL || "https://v1.american-football.api-sports.io";
}

function authHeaders(): HeadersInit {
  return { "x-apisports-key": process.env.API_NFL_KEY ?? "" };
}

// Confirmed live: an unrecognized query param (e.g. /leagues?name=NFL)
// returns HTTP 200 with a populated `errors` object and an empty
// `response` — the exact same soft-error convention API-Football uses,
// so this reuses ProviderApiError (imported, not redefined) and the same
// parse-then-check-errors pattern.
async function parseApiNflBody<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { errors?: unknown };
  const errors = body.errors;
  const hasErrors = errors != null && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors as object).length > 0);
  if (hasErrors) {
    const summary = Array.isArray(errors)
      ? errors.map(String).join("; ")
      : Object.values(errors as Record<string, unknown>).map(String).join("; ");
    throw new ProviderApiError(`API-NFL request failed: ${summary}`, errors);
  }
  return body;
}

function mapGame(raw: ApiNflGameResponse): NormalizedFixture {
  const home = raw.scores?.home;
  const away = raw.scores?.away;
  // Per-quarter values are the points scored in that quarter, not a
  // running cumulative total (confirmed: quarter_1..4 sum to `total` in
  // every sample checked) — halftime score is a legitimate derived sum,
  // not a field the provider returns directly.
  const halftimeHome = home && home.quarter_1 != null && home.quarter_2 != null ? home.quarter_1 + home.quarter_2 : null;
  const halftimeAway = away && away.quarter_1 != null && away.quarter_2 != null ? away.quarter_1 + away.quarter_2 : null;

  return {
    provider: PROVIDER_NAME,
    externalFixtureId: String(raw.game.id),
    sport: "american_football",
    competitionExternalId: String(raw.league.id),
    competitionName: raw.league.name,
    competitionCountry: raw.league.country?.name ?? null,
    competitionLogoUrl: raw.league.logo ?? null,
    season: String(raw.league.season),
    // No single "round" field on API-NFL — stage + week is the closest
    // equivalent to football's round string (e.g. "Regular Season -
    // Week 5", "Pre Season - Hall of Fame Weekend").
    round: [raw.game.stage, raw.game.week].filter(Boolean).join(" - ") || null,
    homeTeamExternalId: String(raw.teams.home.id),
    homeTeamName: raw.teams.home.name,
    homeTeamLogoUrl: raw.teams.home.logo ?? null,
    awayTeamExternalId: String(raw.teams.away.id),
    awayTeamName: raw.teams.away.name,
    awayTeamLogoUrl: raw.teams.away.logo ?? null,
    venueName: raw.game.venue?.name ?? null,
    venueCity: raw.game.venue?.city ?? null,
    venueTimezone: resolveVenueTimezone(raw.game.venue?.city ?? null, null),
    // timestamp is Unix seconds (confirmed live) — more reliable than
    // composing game.date.date + game.date.time ourselves.
    scheduledStartUtc: new Date(raw.game.date.timestamp * 1000).toISOString(),
    providerTimezone: raw.game.date.timezone ?? null,
    providerStatusCode: raw.game.status.short,
    providerStatusDescription: raw.game.status.long,
    internalStatus: normalizeApiNflStatus(raw.game.status.short),
    elapsedMinutes: raw.game.status.timer,
    homeScore: home?.total ?? null,
    awayScore: away?.total ?? null,
    halftimeHomeScore: halftimeHome,
    halftimeAwayScore: halftimeAway,
    // The final score including any overtime — the NFL has no separate
    // "extra time" phase the way soccer does, so this (not a 90-minutes-
    // only figure) is the value every NFL grading template reads.
    regulationHomeScore: home?.total ?? null,
    regulationAwayScore: away?.total ?? null,
    // Just the overtime period's own points (null when no OT was played),
    // analogous to football's extraTimeScore — informational, no current
    // NFL template reads this directly.
    extraTimeHomeScore: home?.overtime ?? null,
    extraTimeAwayScore: away?.overtime ?? null,
    // The NFL has no penalty-shootout tiebreaker.
    penaltyHomeScore: null,
    penaltyAwayScore: null,
    providerPayload: raw,
  };
}

async function callGamesEndpoint(params: Record<string, string>, requestType: string): Promise<NormalizedFixture[]> {
  const url = new URL(`${baseUrl()}/games`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType, requestParams: params },
  );

  const body = await parseApiNflBody<ApiNflGameListResponse>(response);
  return (body.response ?? []).map(mapGame);
}

// A full NFL season (confirmed live: league=1 season=2026 returned 328
// games — preseason + 18-week regular season + playoffs — in one
// response, no pagination). Capped defensively in case of a malformed or
// oversized response, same principle as api-football-provider.ts's
// MAX_SEASON_FIXTURES_RESPONSE, just a much smaller number since the NFL
// has one competition, not dozens.
const MAX_NFL_SEASON_GAMES = 500;

async function callSeasonGamesEndpoint(externalLeagueId: string, season: string): Promise<NormalizedFixture[]> {
  const games = await callGamesEndpoint({ league: externalLeagueId, season }, "get_season_fixtures");
  if (games.length > MAX_NFL_SEASON_GAMES) {
    throw new Error(
      `Season fixture fetch for NFL league ${externalLeagueId} season ${season} exceeded the defensive cap of ${MAX_NFL_SEASON_GAMES} games — aborting rather than importing a possibly-corrupt or oversized response.`,
    );
  }
  return games;
}

function mapLeague(raw: ApiNflLeagueResponse): NormalizedLeague {
  return {
    provider: PROVIDER_NAME,
    externalLeagueId: String(raw.league.id),
    name: raw.league.name,
    // API-NFL's /leagues response has no League/Cup-equivalent type field
    // (confirmed live) — there's exactly one competition, so nothing in
    // this codebase currently branches on this for NFL.
    type: null,
    countryName: raw.country?.name ?? null,
    logoUrl: raw.league.logo ?? null,
    seasons: (raw.seasons ?? []).map((s) => ({
      year: String(s.year),
      startDate: s.start,
      endDate: s.end,
      current: s.current ?? false,
      // Coverage shape differs from API-Football's LeagueSeasonCoverage
      // (confirmed live: nests differently, e.g. games.statisitcs vs a
      // flat fixtures object) and nothing currently reads it for NFL, so
      // it's intentionally left null rather than force-fit into a type
      // that doesn't match what this provider actually returns.
      coverage: null,
    })),
  };
}

async function callLeaguesEndpoint(params: Record<string, string>, requestType: string): Promise<NormalizedLeague[]> {
  const url = new URL(`${baseUrl()}/leagues`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType, requestParams: params },
  );

  const body = await parseApiNflBody<ApiNflLeagueListResponse>(response);
  return (body.response ?? []).map(mapLeague);
}

// Confirmed live: /odds?game=<id> returns { response: [{ game, league,
// country, update, bookmakers: [{ id, name, bets: [{ id, name, values:
// [{value, odd}] }] }] }] } — one response item per game, real bookmaker
// data (11 books observed for a real upcoming game). Bet ids relevant to
// NFL_SPREAD/NFL_GAME_TOTAL/NFL_TEAM_TOTAL: 1 "Home/Away" (moneyline,
// unambiguous), 2 "Asian Handicap" (spread candidate — value-pairing
// convention not fully confirmed, see nfl-odds.ts), 3 "Over/Under" (game
// total, unambiguous), 8 "Total - Home" / 9 "Total - Away" (team totals,
// unambiguous — confirmed live to be plain Over/Under per team).
interface ApiNflOddsValue {
  value: string;
  odd: string;
}

interface ApiNflOddsBet {
  id: number;
  name: string;
  values: ApiNflOddsValue[];
}

interface ApiNflOddsBookmaker {
  id: number;
  name: string;
  bets: ApiNflOddsBet[];
}

interface ApiNflOddsResponseItem {
  game: { id: number };
  update: string | null;
  bookmakers: ApiNflOddsBookmaker[];
}

interface ApiNflOddsListResponse {
  response: ApiNflOddsResponseItem[];
}

const NFL_MONEYLINE_BET_ID = 1;
const NFL_ASIAN_HANDICAP_BET_ID = 2;
const NFL_GAME_TOTAL_BET_ID = 3;
const NFL_TEAM_TOTAL_HOME_BET_ID = 8;
const NFL_TEAM_TOTAL_AWAY_BET_ID = 9;

function rawValuesForBet(bookmaker: ApiNflOddsBookmaker, betId: number): NflRawOddsValue[] {
  const bet = bookmaker.bets.find((b) => b.id === betId);
  if (!bet) return [];
  return bet.values.map((v) => ({ value: v.value, odd: Number(v.odd) }));
}

function normalizeNflBookmakerOdds(bookmaker: ApiNflOddsBookmaker): NflBookmakerOdds {
  return {
    bookmakerId: bookmaker.id,
    bookmakerName: bookmaker.name,
    moneyline: rawValuesForBet(bookmaker, NFL_MONEYLINE_BET_ID),
    asianHandicap: rawValuesForBet(bookmaker, NFL_ASIAN_HANDICAP_BET_ID),
    gameTotal: rawValuesForBet(bookmaker, NFL_GAME_TOTAL_BET_ID),
    homeTeamTotal: rawValuesForBet(bookmaker, NFL_TEAM_TOTAL_HOME_BET_ID),
    awayTeamTotal: rawValuesForBet(bookmaker, NFL_TEAM_TOTAL_AWAY_BET_ID),
  };
}

async function callNflOddsEndpoint(externalFixtureId: string): Promise<ApiNflOddsResponseItem | null> {
  const url = new URL(`${baseUrl()}/odds`);
  url.searchParams.set("game", externalFixtureId);

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType: "get_odds", requestParams: { game: externalFixtureId } },
  );

  const body = await parseApiNflBody<ApiNflOddsListResponse>(response);
  return body.response?.[0] ?? null;
}

export class ApiNflProvider implements SportsDataProvider {
  readonly name = PROVIDER_NAME;

  isEnabled(): boolean {
    return isEnabled();
  }

  async searchFixtures(params: FixtureSearchParams): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];

    if (params.externalFixtureId) {
      const fixture = await this.getFixtureById(params.externalFixtureId);
      return fixture ? [fixture] : [];
    }

    if (params.teamExternalId) {
      const query: Record<string, string> = { team: params.teamExternalId };
      if (params.season) query.season = params.season;
      if (params.date) query.date = params.date;
      return callGamesEndpoint(query, "search_by_team");
    }

    const query: Record<string, string> = {};
    if (params.competitionExternalId) query.league = params.competitionExternalId;
    if (params.season) query.season = params.season;
    if (params.date) query.date = params.date;
    return callGamesEndpoint(query, "search");
  }

  // The complete season in one call (confirmed live, no pagination) —
  // backs the (much lighter-weight than football's) NFL sync path.
  async getSeasonFixtures(externalLeagueId: string, season: string): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];
    return callSeasonGamesEndpoint(externalLeagueId, season);
  }

  // NFL has one competition and ~350 games/season — a bare date filter
  // (mirroring api-football-provider.ts's per-day approach) is untested
  // for API-NFL specifically; season-scoped fetches cover the real V1
  // need (see getSeasonFixtures) so this narrows to that instead of an
  // unverified per-day loop.
  async searchFixturesByDateRange(params: {
    fromDate: string;
    toDate: string;
    competitionExternalId?: string;
  }): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];
    const query: Record<string, string> = { date: params.fromDate };
    if (params.competitionExternalId) query.league = params.competitionExternalId;
    return callGamesEndpoint(query, "search_by_date");
  }

  async getFixtureById(externalFixtureId: string): Promise<NormalizedFixture | null> {
    if (!this.isEnabled()) return null;
    const games = await callGamesEndpoint({ id: externalFixtureId }, "get_by_id");
    return games[0] ?? null;
  }

  async searchLeagues(query: string): Promise<NormalizedLeague[]> {
    if (!this.isEnabled()) return [];
    const trimmed = query.trim();
    return trimmed ? callLeaguesEndpoint({ search: trimmed }, "search_leagues") : callLeaguesEndpoint({}, "list_leagues");
  }

  async searchTeams(query: string): Promise<NormalizedTeam[]> {
    // Not implemented for V1 — no NFL template needs team search yet
    // (unlike football's by-team fixture browsing, the NFL admin flow is
    // season-scoped, see getSeasonFixtures). Returning [] rather than
    // guessing at the /teams response shape without live verification.
    void query;
    return [];
  }

  async getLeagueType(externalLeagueId: string): Promise<string | null> {
    // API-NFL has no League/Cup-equivalent type field (confirmed live).
    void externalLeagueId;
    return null;
  }

  async getLeagueById(externalLeagueId: string): Promise<NormalizedLeague | null> {
    if (!this.isEnabled()) return null;
    const leagues = await callLeaguesEndpoint({ id: externalLeagueId }, "get_league_by_id");
    return leagues[0] ?? null;
  }

  // Not implemented for V1 — no NFL template needs play-by-play events or
  // roster data (grading reads only the final score, and NFL has no
  // player-scoped template). Stubbed rather than guessing at unverified
  // response shapes for a feature nothing calls yet.
  async getFixtureEvents(externalFixtureId: string): Promise<NormalizedFixtureEvent[]> {
    void externalFixtureId;
    return [];
  }

  async getTeamSquad(externalTeamId: string): Promise<NormalizedPlayer[]> {
    void externalTeamId;
    return [];
  }

  // NormalizedFixtureOdds/NormalizedFixtureMarkets (the shared
  // SportsDataProvider shapes) are soccer-specific — goals-line
  // over/unders and a 3-way match winner, neither of which fits NFL's
  // markets (moneyline, Asian Handicap spread, team totals). Left stubbed
  // rather than force-fit; getFixtureRawOdds below is the real NFL odds
  // fetch, deliberately not part of the shared interface.
  async getFixtureOdds(externalFixtureId: string): Promise<NormalizedFixtureOdds | null> {
    void externalFixtureId;
    return null;
  }

  async getFixtureMarkets(externalFixtureId: string): Promise<NormalizedFixtureMarkets | null> {
    void externalFixtureId;
    return null;
  }

  // Backs the pool-creation wizard's Spread/Game Total/Team Total prefill
  // (lib/pools/templates/nfl-odds.ts via lib/actions/odds.ts's
  // getNflFixtureLinesAction) — never cached, same reasoning as football's
  // getFixtureOdds (called at most once per wizard template-selection).
  async getFixtureRawOdds(externalFixtureId: string): Promise<NormalizedNflFixtureOdds | null> {
    if (!this.isEnabled()) return null;
    const item = await callNflOddsEndpoint(externalFixtureId);
    if (!item) return null;
    return {
      externalFixtureId,
      providerUpdatedAt: item.update ?? null,
      bookmakers: item.bookmakers.map(normalizeNflBookmakerOdds),
    };
  }
}

export const apiNflProvider = new ApiNflProvider();
