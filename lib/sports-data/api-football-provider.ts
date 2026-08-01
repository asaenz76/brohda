import "server-only";
import { fetchWithRetry } from "./http";
import { normalizeApiFootballStatus } from "./status-map";
import { normalizeEventDetail, normalizeEventType } from "./events";
import { resolveVenueTimezone } from "./timezone";
import type {
  FixtureSearchParams,
  NormalizedFixture,
  NormalizedFixtureEvent,
  NormalizedFixtureOdds,
  NormalizedLeague,
  NormalizedPlayer,
  NormalizedTeam,
  OddsExactGoalsBucket,
  OddsGoalsLine,
  SportsDataProvider,
} from "./types";

const PROVIDER_NAME = "api_football";

interface ApiFootballFixtureResponse {
  fixture: {
    id: number;
    date: string;
    timezone: string | null;
    status: { long: string | null; short: string | null; elapsed: number | null };
    venue: { name: string | null; city: string | null } | null;
  };
  league: {
    id: number | null;
    name: string | null;
    country: string | null;
    logo: string | null;
    season: number | string | null;
    round: string | null;
  };
  teams: {
    home: { id: number | null; name: string; logo: string | null };
    away: { id: number | null; name: string; logo: string | null };
  };
  goals: { home: number | null; away: number | null };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
    extratime: { home: number | null; away: number | null };
    penalty: { home: number | null; away: number | null };
  };
}

interface ApiFootballListResponse {
  response: ApiFootballFixtureResponse[];
}

interface ApiFootballLeagueResponse {
  league: { id: number; name: string; type: string | null; logo: string | null };
  country: { name: string | null; code: string | null; flag: string | null };
  seasons: Array<{ year: number; start: string; end: string; current?: boolean }>;
}

interface ApiFootballLeagueListResponse {
  response: ApiFootballLeagueResponse[];
}

interface ApiFootballTeamResponse {
  team: { id: number; name: string; logo: string | null; country: string | null };
}

interface ApiFootballTeamListResponse {
  response: ApiFootballTeamResponse[];
}

interface ApiFootballEventResponse {
  time: { elapsed: number | null; extra: number | null };
  team: { id: number | null; name: string | null; logo: string | null } | null;
  player: { id: number | null; name: string | null } | null;
  assist: { id: number | null; name: string | null } | null;
  type: string | null;
  detail: string | null;
  comments: string | null;
}

interface ApiFootballEventListResponse {
  response: ApiFootballEventResponse[];
}

interface ApiFootballSquadPlayerResponse {
  id: number;
  name: string;
  age: number | null;
  number: number | null;
  position: string | null;
  photo: string | null;
}

interface ApiFootballSquadResponse {
  team: { id: number; name: string | null; logo: string | null };
  players: ApiFootballSquadPlayerResponse[];
}

interface ApiFootballSquadListResponse {
  response: ApiFootballSquadResponse[];
}

interface ApiFootballOddsValue {
  // "Over 2.5"-style bets always send a string; "Exact Goals Number"-style
  // bets send a raw JSON number for every bucket except the open-ended
  // last one ("more 2"), which is a string — the API's shape genuinely
  // varies by bet type, not a normalization choice made here.
  value: string | number;
  odd: string; // e.g. "2.55"
}

interface ApiFootballOddsBet {
  id: number;
  values: ApiFootballOddsValue[];
}

interface ApiFootballOddsBookmaker {
  bets: ApiFootballOddsBet[];
}

interface ApiFootballOddsResponseItem {
  bookmakers: ApiFootballOddsBookmaker[];
}

interface ApiFootballOddsListResponse {
  response: ApiFootballOddsResponseItem[];
}

// "Goals Over/Under" (full match), "Goals Over/Under First Half", "Home/
// Away Team Exact Goals Number" — confirmed against /odds/bets, ids are
// stable across the API. There's no full-match single-team Over/Under
// line market — the exact-goals-count distribution is the closest
// equivalent, handled differently (see parseExactGoalsDistributions).
const MATCH_TOTAL_GOALS_BET_ID = 5;
const FIRST_HALF_TOTAL_GOALS_BET_ID = 6;
const HOME_TEAM_EXACT_GOALS_BET_ID = 40;
const AWAY_TEAM_EXACT_GOALS_BET_ID = 41;

const OVER_UNDER_VALUE_PATTERN = /^(Over|Under) (\d+(?:\.\d+)?)$/;
const MORE_THAN_VALUE_PATTERN = /^more (\d+)$/i;

function isEnabled(): boolean {
  return process.env.API_FOOTBALL_ENABLED === "true";
}

function baseUrl(): string {
  return process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";
}

function authHeaders(): HeadersInit {
  return { "x-apisports-key": process.env.API_FOOTBALL_KEY ?? "" };
}

function mapFixture(raw: ApiFootballFixtureResponse): NormalizedFixture {
  return {
    provider: PROVIDER_NAME,
    externalFixtureId: String(raw.fixture.id),
    sport: "football",
    competitionExternalId: raw.league?.id != null ? String(raw.league.id) : null,
    competitionName: raw.league?.name ?? null,
    competitionCountry: raw.league?.country ?? null,
    competitionLogoUrl: raw.league?.logo ?? null,
    season: raw.league?.season != null ? String(raw.league.season) : null,
    round: raw.league?.round ?? null,
    homeTeamExternalId: raw.teams?.home?.id != null ? String(raw.teams.home.id) : null,
    homeTeamName: raw.teams.home.name,
    homeTeamLogoUrl: raw.teams.home.logo ?? null,
    awayTeamExternalId: raw.teams?.away?.id != null ? String(raw.teams.away.id) : null,
    awayTeamName: raw.teams.away.name,
    awayTeamLogoUrl: raw.teams.away.logo ?? null,
    venueName: raw.fixture.venue?.name ?? null,
    venueCity: raw.fixture.venue?.city ?? null,
    venueTimezone: resolveVenueTimezone(raw.fixture.venue?.city ?? null, null),
    scheduledStartUtc: new Date(raw.fixture.date).toISOString(),
    providerTimezone: raw.fixture.timezone ?? null,
    providerStatusCode: raw.fixture.status?.short ?? null,
    providerStatusDescription: raw.fixture.status?.long ?? null,
    internalStatus: normalizeApiFootballStatus(raw.fixture.status?.short),
    elapsedMinutes: raw.fixture.status?.elapsed ?? null,
    homeScore: raw.goals?.home ?? null,
    awayScore: raw.goals?.away ?? null,
    halftimeHomeScore: raw.score?.halftime?.home ?? null,
    halftimeAwayScore: raw.score?.halftime?.away ?? null,
    // 90-minute score, even when ET/penalties were played — spec §16.3.
    regulationHomeScore: raw.score?.fulltime?.home ?? null,
    regulationAwayScore: raw.score?.fulltime?.away ?? null,
    extraTimeHomeScore: raw.score?.extratime?.home ?? null,
    extraTimeAwayScore: raw.score?.extratime?.away ?? null,
    penaltyHomeScore: raw.score?.penalty?.home ?? null,
    penaltyAwayScore: raw.score?.penalty?.away ?? null,
    providerPayload: raw,
  };
}

async function callFixturesEndpoint(
  params: Record<string, string>,
  requestType: string,
): Promise<NormalizedFixture[]> {
  const url = new URL(`${baseUrl()}/fixtures`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType, requestParams: params },
  );

  const body = (await response.json()) as ApiFootballListResponse;
  return (body.response ?? []).map(mapFixture);
}

function mapLeague(raw: ApiFootballLeagueResponse): NormalizedLeague {
  return {
    provider: PROVIDER_NAME,
    externalLeagueId: String(raw.league.id),
    name: raw.league.name,
    type: raw.league.type ?? null,
    countryName: raw.country?.name ?? null,
    logoUrl: raw.league.logo ?? null,
    seasons: (raw.seasons ?? []).map((s) => ({
      year: String(s.year),
      startDate: s.start,
      endDate: s.end,
      current: s.current ?? false,
    })),
  };
}

async function callLeaguesEndpoint(
  params: Record<string, string>,
  requestType: string,
): Promise<NormalizedLeague[]> {
  const url = new URL(`${baseUrl()}/leagues`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType, requestParams: params },
  );

  const body = (await response.json()) as ApiFootballLeagueListResponse;
  return (body.response ?? []).map(mapLeague);
}

function mapTeam(raw: ApiFootballTeamResponse): NormalizedTeam {
  return {
    provider: PROVIDER_NAME,
    externalTeamId: String(raw.team.id),
    name: raw.team.name,
    countryName: raw.team.country ?? null,
    logoUrl: raw.team.logo ?? null,
  };
}

async function callTeamsEndpoint(
  params: Record<string, string>,
  requestType: string,
): Promise<NormalizedTeam[]> {
  const url = new URL(`${baseUrl()}/teams`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType, requestParams: params },
  );

  const body = (await response.json()) as ApiFootballTeamListResponse;
  return (body.response ?? []).map(mapTeam);
}

function mapEvent(raw: ApiFootballEventResponse): NormalizedFixtureEvent {
  return {
    effectiveMinute: (raw.time?.elapsed ?? 0) + (raw.time?.extra ?? 0),
    teamExternalId: raw.team?.id != null ? String(raw.team.id) : null,
    playerExternalId: raw.player?.id != null ? String(raw.player.id) : null,
    playerName: raw.player?.name ?? null,
    assistPlayerExternalId: raw.assist?.id != null ? String(raw.assist.id) : null,
    assistPlayerName: raw.assist?.name ?? null,
    type: normalizeEventType(raw.type),
    detail: normalizeEventDetail(raw.type, raw.detail),
  };
}

async function callEventsEndpoint(externalFixtureId: string): Promise<NormalizedFixtureEvent[]> {
  const url = new URL(`${baseUrl()}/fixtures/events`);
  url.searchParams.set("fixture", externalFixtureId);

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType: "get_events", requestParams: { fixture: externalFixtureId } },
  );

  const body = (await response.json()) as ApiFootballEventListResponse;
  return (body.response ?? []).map(mapEvent);
}

function mapPlayer(raw: ApiFootballSquadPlayerResponse): NormalizedPlayer {
  return {
    externalPlayerId: String(raw.id),
    name: raw.name,
    position: raw.position ?? null,
    jerseyNumber: raw.number ?? null,
  };
}

async function callSquadEndpoint(externalTeamId: string): Promise<NormalizedPlayer[]> {
  const url = new URL(`${baseUrl()}/players/squads`);
  url.searchParams.set("team", externalTeamId);

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType: "get_squad", requestParams: { team: externalTeamId } },
  );

  const body = (await response.json()) as ApiFootballSquadListResponse;
  return (body.response?.[0]?.players ?? []).map(mapPlayer);
}

// Only `.5`-point Over/Under pairs are kept — the standard, unambiguous
// line convention (no "push"/void case, unlike a whole-number line), and
// the only shape lib/pools/templates/goals-odds.ts's suggestion algorithm
// is designed to consume. Pooled across every bookmaker offering this bet
// (the caller doesn't care which bookmaker, just the full set of lines).
function parseGoalsLines(bookmakers: ApiFootballOddsBookmaker[], betId: number): OddsGoalsLine[] {
  const lines: OddsGoalsLine[] = [];
  for (const bookmaker of bookmakers) {
    const bet = bookmaker.bets.find((b) => b.id === betId);
    if (!bet) continue;

    const byPoint = new Map<number, { overOdd?: number; underOdd?: number }>();
    for (const raw of bet.values) {
      const match = OVER_UNDER_VALUE_PATTERN.exec(String(raw.value));
      if (!match) continue;
      const point = Number(match[2]);
      if (Math.abs((point % 1) - 0.5) > 1e-9) continue; // whole/quarter lines excluded

      const entry = byPoint.get(point) ?? {};
      if (match[1] === "Over") entry.overOdd = Number(raw.odd);
      else entry.underOdd = Number(raw.odd);
      byPoint.set(point, entry);
    }

    for (const [point, { overOdd, underOdd }] of byPoint) {
      if (overOdd != null && underOdd != null) {
        lines.push({ point, overOdd, underOdd });
      }
    }
  }
  return lines;
}

// Each bookmaker's full exact-goals-count distribution for one team, kept
// separate per bookmaker (not merged) — lib/pools/templates/goals-odds.ts's
// suggestion algorithm evaluates each bookmaker's own distribution
// independently, same spirit as parseGoalsLines above.
function parseExactGoalsDistributions(bookmakers: ApiFootballOddsBookmaker[], betId: number): OddsExactGoalsBucket[][] {
  const distributions: OddsExactGoalsBucket[][] = [];
  for (const bookmaker of bookmakers) {
    const bet = bookmaker.bets.find((b) => b.id === betId);
    if (!bet) continue;

    const buckets: OddsExactGoalsBucket[] = [];
    for (const raw of bet.values) {
      const odd = Number(raw.odd);
      if (typeof raw.value === "number") {
        buckets.push({ count: raw.value, isTail: false, odd });
        continue;
      }
      const match = MORE_THAN_VALUE_PATTERN.exec(raw.value.trim());
      if (match) {
        buckets.push({ count: Number(match[1]) + 1, isTail: true, odd });
      }
    }
    if (buckets.length > 0) distributions.push(buckets);
  }
  return distributions;
}

async function callOddsEndpoint(externalFixtureId: string): Promise<ApiFootballOddsResponseItem | null> {
  const url = new URL(`${baseUrl()}/odds`);
  url.searchParams.set("fixture", externalFixtureId);

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType: "get_odds", requestParams: { fixture: externalFixtureId } },
  );

  const body = (await response.json()) as ApiFootballOddsListResponse;
  return body.response?.[0] ?? null;
}

export class ApiFootballProvider implements SportsDataProvider {
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
      // Neither season nor date given — the common case, since an admin
      // searching by team almost always wants an upcoming match, not a
      // historical one, and API-Football's /fixtures requires a season
      // whenever a date isn't given directly. "next": the next 10
      // fixtures for this team, unlike league search which has no
      // equivalent season-free default.
      if (!params.season && !params.date) query.next = "10";
      return callFixturesEndpoint(query, "search_by_team");
    }

    const query: Record<string, string> = {};
    if (params.competitionExternalId) query.league = params.competitionExternalId;
    if (params.season) query.season = params.season;
    if (params.date) {
      query.date = params.date;
    } else if (params.competitionExternalId && params.season) {
      // No specific date given — an admin browsing a league+season wants
      // fixtures still worth importing, not ones already played. API-
      // Football has no "upcoming only" flag for this combo (unlike team
      // search's `next`), so this uses a from/to range instead: from today,
      // to a generously-far future bound (API-Football 400s if `from` is
      // given without `to`, and there's no real "season end" to reach for
      // here without an extra lookup).
      const today = new Date();
      const farFuture = new Date(today);
      farFuture.setFullYear(farFuture.getFullYear() + 2);
      query.from = today.toISOString().slice(0, 10);
      query.to = farFuture.toISOString().slice(0, 10);
    }

    return callFixturesEndpoint(query, "search");
  }

  async getFixtureById(externalFixtureId: string): Promise<NormalizedFixture | null> {
    if (!this.isEnabled()) return null;

    const fixtures = await callFixturesEndpoint({ id: externalFixtureId }, "get_by_id");
    return fixtures[0] ?? null;
  }

  async searchLeagues(query: string): Promise<NormalizedLeague[]> {
    if (!this.isEnabled()) return [];

    const trimmed = query.trim();
    // Empty query lists every league the provider knows about (used to
    // populate the admin fixture-import league dropdown) rather than
    // searching by name.
    return trimmed
      ? callLeaguesEndpoint({ search: trimmed }, "search_leagues")
      : callLeaguesEndpoint({}, "list_leagues");
  }

  async searchTeams(query: string): Promise<NormalizedTeam[]> {
    if (!this.isEnabled()) return [];

    const trimmed = query.trim();
    if (!trimmed) return [];
    return callTeamsEndpoint({ search: trimmed }, "search_teams");
  }

  // The /fixtures endpoint never returns league.type ("League"/"Cup") —
  // only /leagues does. Called once per fixture import (not on every
  // periodic re-sync) to stage-gate the pool creation template picker.
  async getLeagueType(externalLeagueId: string): Promise<string | null> {
    if (!this.isEnabled()) return null;

    const leagues = await callLeaguesEndpoint({ id: externalLeagueId }, "get_league_type");
    return leagues[0]?.type ?? null;
  }

  // Phase 2 of the pool-template registry — only ever meaningful once a
  // fixture has actually kicked off; lib/sports-data/sync.ts is the only
  // caller, and only for fixtures with an active FIXTURE_EVENTS-dependent
  // pool (never fetched speculatively for every fixture).
  async getFixtureEvents(externalFixtureId: string): Promise<NormalizedFixtureEvent[]> {
    if (!this.isEnabled()) return [];
    return callEventsEndpoint(externalFixtureId);
  }

  // Squad list (not lineups — see docs/ARCHITECTURE.md's Phase 2 section
  // for why) backing the "Player to score" template's player picker.
  // Called on demand from lib/actions/squads.ts, cached in team_players.
  async getTeamSquad(externalTeamId: string): Promise<NormalizedPlayer[]> {
    if (!this.isEnabled()) return [];
    return callSquadEndpoint(externalTeamId);
  }

  // Backs the "Match total goals"/"First-half total goals"/"Team total
  // goals" templates' odds-derived default (lib/actions/odds.ts) — never
  // cached (odds move as kickoff approaches, and this is only ever called
  // once per pool-creation session, unlike the squad list above).
  async getFixtureOdds(externalFixtureId: string): Promise<NormalizedFixtureOdds | null> {
    if (!this.isEnabled()) return null;
    const item = await callOddsEndpoint(externalFixtureId);
    if (!item) return null;
    return {
      externalFixtureId,
      matchGoalsLines: parseGoalsLines(item.bookmakers, MATCH_TOTAL_GOALS_BET_ID),
      firstHalfGoalsLines: parseGoalsLines(item.bookmakers, FIRST_HALF_TOTAL_GOALS_BET_ID),
      homeTeamGoalsDistributions: parseExactGoalsDistributions(item.bookmakers, HOME_TEAM_EXACT_GOALS_BET_ID),
      awayTeamGoalsDistributions: parseExactGoalsDistributions(item.bookmakers, AWAY_TEAM_EXACT_GOALS_BET_ID),
    };
  }
}

export const apiFootballProvider = new ApiFootballProvider();
