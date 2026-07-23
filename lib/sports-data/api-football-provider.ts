import "server-only";
import { fetchWithRetry } from "./http";
import { normalizeApiFootballStatus } from "./status-map";
import { normalizeEventDetail, normalizeEventType } from "./events";
import { resolveVenueTimezone } from "./timezone";
import type {
  FixtureSearchParams,
  NormalizedFixture,
  NormalizedFixtureEvent,
  NormalizedLeague,
  NormalizedPlayer,
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
  seasons: Array<{ year: number }>;
}

interface ApiFootballLeagueListResponse {
  response: ApiFootballLeagueResponse[];
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
    seasons: (raw.seasons ?? []).map((s) => String(s.year)),
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

    const query: Record<string, string> = {};
    if (params.competitionExternalId) query.league = params.competitionExternalId;
    if (params.season) query.season = params.season;
    if (params.date) query.date = params.date;

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
}

export const apiFootballProvider = new ApiFootballProvider();
