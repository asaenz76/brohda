import "server-only";
import { fetchWithRetry } from "./http";
import { normalizeApiFootballStatus } from "./status-map";
import { normalizeEventDetail, normalizeEventType } from "./events";
import { resolveVenueTimezone } from "./timezone";
import { API_FOOTBALL_PROVIDER } from "./provider-names";
import type {
  FixtureSearchParams,
  LeagueSeasonCoverage,
  MatchWinnerLine,
  NormalizedFixture,
  NormalizedFixtureEvent,
  NormalizedFixtureMarkets,
  NormalizedFixtureOdds,
  NormalizedLeague,
  NormalizedPlayer,
  NormalizedTeam,
  OddsExactGoalsBucket,
  OddsGoalsLine,
  OddsMarket,
  OddsMarketKey,
  OddsMarketLine,
  OddsProposition,
  SportsDataProvider,
} from "./types";

const PROVIDER_NAME = API_FOOTBALL_PROVIDER;

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
  paging?: { current: number; total: number };
}

interface ApiFootballLeagueResponse {
  league: { id: number; name: string; type: string | null; logo: string | null };
  country: { name: string | null; code: string | null; flag: string | null };
  seasons: Array<{
    year: number;
    start: string;
    end: string;
    current?: boolean;
    coverage?: LeagueSeasonCoverage;
  }>;
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
  id: number;
  name: string;
  bets: ApiFootballOddsBet[];
}

interface ApiFootballOddsResponseItem {
  bookmakers: ApiFootballOddsBookmaker[];
  update?: string; // e.g. "2026-08-03T00:15:08+00:00" — the provider's own freshness timestamp
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

// Bet ids backing the normalized market layer (lib/pools/templates/
// odds-mapping.ts) — confirmed live against /odds/bets and a real /odds
// response before this was built. "Total - Home"/"Total - Away" (16/17)
// are genuine full-match single-team Over/Under line markets — the
// comment above (kept for the older exact-goals-distribution path) turned
// out not to apply here.
const MATCH_WINNER_BET_ID = 1;
const BOTH_TEAMS_SCORE_BET_ID = 8;
const TEAM_TOTAL_HOME_BET_ID = 16;
const TEAM_TOTAL_AWAY_BET_ID = 17;
const CLEAN_SHEET_HOME_BET_ID = 27;
const CLEAN_SHEET_AWAY_BET_ID = 28;
const WIN_TO_NIL_HOME_BET_ID = 29;
const WIN_TO_NIL_AWAY_BET_ID = 30;
const OWN_GOAL_BET_ID = 59;

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

/**
 * API-Football signals request-level failures — daily quota exhausted,
 * a plan-restricted endpoint/parameter combination, an invalid parameter
 * — via HTTP 200 with a non-empty `errors` object and an empty
 * `response` array. `fetchWithRetry` only inspects HTTP status (as it
 * should — that's a generic HTTP-transport concern), so without this
 * check a quota-exhausted day is silently indistinguishable from a
 * genuine zero-fixture day everywhere below. Confirmed live: a real
 * request during quota exhaustion returns exactly
 * `{"errors":{"requests":"You have reached the request limit for the
 * day..."},"results":0,"response":[]}` with a 200 status.
 */
export class ProviderApiError extends Error {
  constructor(
    message: string,
    public readonly providerErrors: unknown,
  ) {
    super(message);
    this.name = "ProviderApiError";
  }
}

function summarizeApiFootballErrors(errors: unknown): string {
  if (Array.isArray(errors)) return errors.map(String).join("; ");
  if (errors && typeof errors === "object") return Object.values(errors as Record<string, unknown>).map(String).join("; ");
  return String(errors);
}

// Every raw API-Football body must pass through here before its
// `.response` is read — the single choke point for the soft-error check
// above, shared by every endpoint this provider calls (fixtures,
// leagues, teams, events, squads, odds) rather than duplicated per call
// site. `errors` is always present in a real response, normally as an
// empty object/array on success — only a *populated* one is a failure.
async function parseApiFootballBody<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { errors?: unknown };
  const errors = body.errors;
  const hasErrors = errors != null && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors as object).length > 0);
  if (hasErrors) {
    throw new ProviderApiError(`API-Football request failed: ${summarizeApiFootballErrors(errors)}`, errors);
  }
  return body;
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

  const body = await parseApiFootballBody<ApiFootballListResponse>(response);
  return (body.response ?? []).map(mapFixture);
}

// Defensive cap against a runaway/bugged provider response (e.g. a
// malformed season param matching far more than one season's worth of
// fixtures) — a realistic domestic season tops out in the 300s-400s
// (confirmed live: league=39 season=2025 returned exactly 380, one page).
// Aborting outright is safer than silently importing a wildly oversized
// response.
const MAX_SEASON_FIXTURES_RESPONSE = 2000;

// Backs getSeasonFixtures — deliberately separate from callFixturesEndpoint
// (used by searchFixtures/getFixtureById, neither of which has ever needed
// pagination): `/fixtures?league=X&season=Y` with NO date/from/to returns
// the complete season, past and future, in one call (confirmed live) —
// unlike searchFixtures' league+season branch, which deliberately narrows
// to upcoming-only via an injected from/to range for the existing by-league
// browse-and-import UI. Paginated defensively even though a real season
// fetch was confirmed to return everything in a single page.
async function callSeasonFixturesEndpoint(externalLeagueId: string, season: string): Promise<NormalizedFixture[]> {
  const results: NormalizedFixture[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = new URL(`${baseUrl()}/fixtures`);
    url.searchParams.set("league", externalLeagueId);
    url.searchParams.set("season", season);
    if (page > 1) url.searchParams.set("page", String(page));

    const response = await fetchWithRetry(
      url.toString(),
      { headers: authHeaders() },
      {
        provider: PROVIDER_NAME,
        requestType: "get_season_fixtures",
        requestParams: { league: externalLeagueId, season, page: String(page) },
      },
    );
    const body = await parseApiFootballBody<ApiFootballListResponse>(response);
    results.push(...(body.response ?? []).map(mapFixture));
    totalPages = body.paging?.total ?? 1;
    page += 1;

    if (results.length > MAX_SEASON_FIXTURES_RESPONSE) {
      throw new Error(
        `Season fixture fetch for league ${externalLeagueId} season ${season} exceeded the defensive cap of ${MAX_SEASON_FIXTURES_RESPONSE} fixtures — aborting rather than importing a possibly-corrupt or oversized response.`,
      );
    }
  } while (page <= totalPages);

  return results;
}

// A realistic single-day cross-league response is in the hundreds
// (confirmed by the same "domestic season tops out in the 300s-400s"
// order of magnitude noted for MAX_SEASON_FIXTURES_RESPONSE) — capping
// per-day here guards the same "malformed/oversized response" risk
// without being anywhere close to a real busy football day's true count.
const MAX_FIXTURES_PER_DATE = 2000;

// Backs searchFixturesByDateRange. One `/fixtures?date=X` request per UTC
// calendar date in [fromDate, toDate] — sequential, not parallel: a
// 31-day custom range can mean up to ~32 requests, and API-Football's
// lower-tier plans rate-limit aggressively (confirmed this session: the
// free-tier key used for live verification exhausted its *daily* quota
// well before finishing this feature's testing) — firing them
// concurrently would only make that worse. `date` (bare, no league) is
// the documented, long-established way to fetch every fixture across
// every competition on one day; unlike `from`/`to`, which this provider
// has only ever used already scoped to a specific league+season (see
// callSeasonFixturesEndpoint's own comment) and which API-Football's own
// docs describe as intended for that pairing, not a bare cross-league
// range — so date-per-day, not from/to, is the query this method builds.
async function callFixturesByDateRangeEndpoint(
  fromDate: string,
  toDate: string,
  competitionExternalId?: string,
): Promise<NormalizedFixture[]> {
  const dates = enumerateUtcCalendarDates(fromDate, toDate);
  const byExternalId = new Map<string, NormalizedFixture>();

  for (const date of dates) {
    const url = new URL(`${baseUrl()}/fixtures`);
    url.searchParams.set("date", date);
    if (competitionExternalId) url.searchParams.set("league", competitionExternalId);

    const response = await fetchWithRetry(
      url.toString(),
      { headers: authHeaders() },
      {
        provider: PROVIDER_NAME,
        requestType: "search_by_date",
        requestParams: competitionExternalId ? { date, league: competitionExternalId } : { date },
      },
    );
    const body = await parseApiFootballBody<ApiFootballListResponse>(response);
    const fixtures = (body.response ?? []).map(mapFixture);
    if (fixtures.length > MAX_FIXTURES_PER_DATE) {
      throw new Error(
        `Fixture search for date ${date} exceeded the defensive cap of ${MAX_FIXTURES_PER_DATE} fixtures — aborting rather than importing a possibly-corrupt or oversized response.`,
      );
    }
    for (const fixture of fixtures) byExternalId.set(fixture.externalFixtureId, fixture);
  }

  return [...byExternalId.values()];
}

function enumerateUtcCalendarDates(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  let cursor = Date.parse(`${fromDate}T00:00:00.000Z`);
  const end = Date.parse(`${toDate}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return dates;
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
      coverage: s.coverage ?? null,
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

  const body = await parseApiFootballBody<ApiFootballLeagueListResponse>(response);
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

  const body = await parseApiFootballBody<ApiFootballTeamListResponse>(response);
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

  const body = await parseApiFootballBody<ApiFootballEventListResponse>(response);
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

  const body = await parseApiFootballBody<ApiFootballSquadListResponse>(response);
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

// ---------------------------------------------------------------------
// Normalized market layer (lib/pools/templates/odds-mapping.ts and up
// consume only this shape — never the raw ApiFootball* types above).
// ---------------------------------------------------------------------

function normalizeMatchWinner(bookmakers: ApiFootballOddsBookmaker[]): MatchWinnerLine[] {
  const lines: MatchWinnerLine[] = [];
  for (const bookmaker of bookmakers) {
    const bet = bookmaker.bets.find((b) => b.id === MATCH_WINNER_BET_ID);
    if (!bet) continue;

    const home = bet.values.find((v) => v.value === "Home");
    const draw = bet.values.find((v) => v.value === "Draw");
    const away = bet.values.find((v) => v.value === "Away");
    if (!home || !draw || !away) continue;

    lines.push({
      bookmakerId: bookmaker.id,
      bookmakerName: bookmaker.name,
      homeOdd: Number(home.odd),
      drawOdd: Number(draw.odd),
      awayOdd: Number(away.odd),
    });
  }
  return lines;
}

// Backs every non-threshold, single-proposition market (Both Teams Score,
// Clean Sheet, Win to Nil, Own Goal) — each is a plain Yes/No bet with no
// line to choose, so it always normalizes to exactly one OddsMarketLine
// with point 0.
function normalizeSingleProposition(bookmakers: ApiFootballOddsBookmaker[], betId: number): OddsMarketLine[] {
  const propositions: OddsProposition[] = [];
  for (const bookmaker of bookmakers) {
    const bet = bookmaker.bets.find((b) => b.id === betId);
    if (!bet) continue;

    const yes = bet.values.find((v) => v.value === "Yes");
    const no = bet.values.find((v) => v.value === "No");
    if (!yes || !no) continue;

    propositions.push({
      bookmakerId: bookmaker.id,
      bookmakerName: bookmaker.name,
      yesOdd: Number(yes.odd),
      noOdd: Number(no.odd),
    });
  }
  return propositions.length > 0 ? [{ point: 0, propositions }] : [];
}

// Backs every Over/Under threshold market (match/first-half/team totals) —
// unlike parseGoalsLines above, this keeps bookmaker identity per line (the
// consensus builder needs to know which bookmaker each price came from) and
// doesn't merge across bookmakers. Same half-line-only filter as
// parseGoalsLines: a whole or quarter line can push, which this market
// shape has no room to represent, so it's dropped rather than mismapped.
function normalizeOverUnderLines(bookmakers: ApiFootballOddsBookmaker[], betId: number): OddsMarketLine[] {
  const byPoint = new Map<number, OddsProposition[]>();
  for (const bookmaker of bookmakers) {
    const bet = bookmaker.bets.find((b) => b.id === betId);
    if (!bet) continue;

    const byPointForBookmaker = new Map<number, { overOdd?: number; underOdd?: number }>();
    for (const raw of bet.values) {
      const match = OVER_UNDER_VALUE_PATTERN.exec(String(raw.value));
      if (!match) continue;
      const point = Number(match[2]);
      if (Math.abs((point % 1) - 0.5) > 1e-9) continue; // whole/quarter lines excluded

      const entry = byPointForBookmaker.get(point) ?? {};
      if (match[1] === "Over") entry.overOdd = Number(raw.odd);
      else entry.underOdd = Number(raw.odd);
      byPointForBookmaker.set(point, entry);
    }

    for (const [point, { overOdd, underOdd }] of byPointForBookmaker) {
      if (overOdd == null || underOdd == null) continue;
      const list = byPoint.get(point) ?? [];
      list.push({ bookmakerId: bookmaker.id, bookmakerName: bookmaker.name, yesOdd: overOdd, noOdd: underOdd });
      byPoint.set(point, list);
    }
  }

  return [...byPoint.entries()]
    .sort(([a], [b]) => a - b)
    .map(([point, propositions]) => ({ point, propositions }));
}

function buildOddsMarket(key: OddsMarketKey, lines: OddsMarketLine[]): OddsMarket | null {
  return lines.length > 0 ? { key, lines } : null;
}

function normalizeFixtureMarkets(externalFixtureId: string, item: ApiFootballOddsResponseItem): NormalizedFixtureMarkets {
  const { bookmakers } = item;
  const markets: OddsMarket[] = [];
  const add = (key: OddsMarketKey, lines: OddsMarketLine[]) => {
    const market = buildOddsMarket(key, lines);
    if (market) markets.push(market);
  };

  add("BOTH_TEAMS_SCORE", normalizeSingleProposition(bookmakers, BOTH_TEAMS_SCORE_BET_ID));
  add("CLEAN_SHEET_HOME", normalizeSingleProposition(bookmakers, CLEAN_SHEET_HOME_BET_ID));
  add("CLEAN_SHEET_AWAY", normalizeSingleProposition(bookmakers, CLEAN_SHEET_AWAY_BET_ID));
  add("WIN_TO_NIL_HOME", normalizeSingleProposition(bookmakers, WIN_TO_NIL_HOME_BET_ID));
  add("WIN_TO_NIL_AWAY", normalizeSingleProposition(bookmakers, WIN_TO_NIL_AWAY_BET_ID));
  add("OWN_GOAL", normalizeSingleProposition(bookmakers, OWN_GOAL_BET_ID));
  add("MATCH_TOTAL_GOALS", normalizeOverUnderLines(bookmakers, MATCH_TOTAL_GOALS_BET_ID));
  add("FIRST_HALF_TOTAL_GOALS", normalizeOverUnderLines(bookmakers, FIRST_HALF_TOTAL_GOALS_BET_ID));
  add("TEAM_TOTAL_GOALS_HOME", normalizeOverUnderLines(bookmakers, TEAM_TOTAL_HOME_BET_ID));
  add("TEAM_TOTAL_GOALS_AWAY", normalizeOverUnderLines(bookmakers, TEAM_TOTAL_AWAY_BET_ID));

  return {
    externalFixtureId,
    providerUpdatedAt: item.update ?? null,
    matchWinner: normalizeMatchWinner(bookmakers),
    markets,
  };
}

async function callOddsEndpoint(externalFixtureId: string): Promise<ApiFootballOddsResponseItem | null> {
  const url = new URL(`${baseUrl()}/odds`);
  url.searchParams.set("fixture", externalFixtureId);

  const response = await fetchWithRetry(
    url.toString(),
    { headers: authHeaders() },
    { provider: PROVIDER_NAME, requestType: "get_odds", requestParams: { fixture: externalFixtureId } },
  );

  const body = await parseApiFootballBody<ApiFootballOddsListResponse>(response);
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

  // Backs the competition-import-manager: the complete season, past and
  // future, in one request (no date restriction) — used by the initial
  // competition import, the discovery-sync cron, and the recommendation-
  // availability cache refresh, so none of them need a different request
  // shape from each other. Deliberately distinct from searchFixtures'
  // league+season branch above, which intentionally narrows to
  // upcoming-only for the existing by-league manual browse/import flow.
  async getSeasonFixtures(externalLeagueId: string, season: string): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];
    return callSeasonFixturesEndpoint(externalLeagueId, season);
  }

  async searchFixturesByDateRange(params: {
    fromDate: string;
    toDate: string;
    competitionExternalId?: string;
  }): Promise<NormalizedFixture[]> {
    if (!this.isEnabled()) return [];
    return callFixturesByDateRangeEndpoint(params.fromDate, params.toDate, params.competitionExternalId);
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

  // Backs the competition-import-manager: the full NormalizedLeague (name,
  // country, type, and — importantly — the seasons[] array with each
  // season's start/end dates, current flag, and coverage snapshot), unlike
  // getLeagueType above which only ever plucks the bare type string.
  async getLeagueById(externalLeagueId: string): Promise<NormalizedLeague | null> {
    if (!this.isEnabled()) return null;

    const leagues = await callLeaguesEndpoint({ id: externalLeagueId }, "get_league_by_id");
    return leagues[0] ?? null;
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

  // Backs the odds-driven recommendation engine (lib/pools/templates/
  // odds-mapping.ts and up) — a separate call from getFixtureOdds above
  // (accepted duplicate-fetch tradeoff: unifying the two would mean
  // refactoring the older, already-shipped goals-line prefill, which isn't
  // worth the regression risk given how much API quota headroom exists).
  // Callers are expected to go through lib/actions/odds.ts's cache, not
  // call this directly on every wizard render.
  async getFixtureMarkets(externalFixtureId: string): Promise<NormalizedFixtureMarkets | null> {
    if (!this.isEnabled()) return null;
    const item = await callOddsEndpoint(externalFixtureId);
    if (!item) return null;
    return normalizeFixtureMarkets(externalFixtureId, item);
  }
}

export const apiFootballProvider = new ApiFootballProvider();
