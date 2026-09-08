// SportsDataProvider abstraction (spec §9): no application code outside
// this folder should ever see a raw provider (e.g. API-Football) shape.

export type FixtureInternalStatus =
  | "NOT_STARTED"
  | "LIVE"
  | "HALFTIME"
  | "EXTRA_TIME"
  | "PENALTIES"
  | "COMPLETED"
  | "POSTPONED"
  | "SUSPENDED"
  | "ABANDONED"
  | "CANCELLED"
  | "AWARDED"
  | "UNKNOWN";

export interface NormalizedFixture {
  provider: string;
  externalFixtureId: string;
  sport: string;

  competitionExternalId: string | null;
  competitionName: string | null;
  competitionCountry: string | null;
  competitionLogoUrl: string | null;
  // Absent (not `null`) means "not looked up" — the /fixtures endpoint
  // never returns this, so mapFixture always omits the key entirely.
  // Callers that want it fetch it separately (getLeagueType) and merge it
  // in. toFixtureRow relies on this distinction to avoid the periodic
  // re-sync job (which never re-fetches it) silently clobbering the value
  // an import already stored.
  competitionType?: string | null;
  season: string | null;
  round: string | null;

  homeTeamExternalId: string | null;
  homeTeamName: string;
  homeTeamLogoUrl: string | null;
  awayTeamExternalId: string | null;
  awayTeamName: string;
  awayTeamLogoUrl: string | null;

  venueName: string | null;
  venueCity: string | null;
  venueTimezone: string | null;

  scheduledStartUtc: string; // ISO 8601
  providerTimezone: string | null;

  providerStatusCode: string | null;
  providerStatusDescription: string | null;
  internalStatus: FixtureInternalStatus;
  elapsedMinutes: number | null;

  homeScore: number | null;
  awayScore: number | null;
  halftimeHomeScore: number | null;
  halftimeAwayScore: number | null;
  regulationHomeScore: number | null;
  regulationAwayScore: number | null;
  extraTimeHomeScore: number | null;
  extraTimeAwayScore: number | null;
  penaltyHomeScore: number | null;
  penaltyAwayScore: number | null;

  providerPayload: unknown;
}

export interface FixtureSearchParams {
  competitionExternalId?: string;
  season?: string;
  date?: string; // YYYY-MM-DD
  externalFixtureId?: string;
  teamExternalId?: string;
}

// A provider search result for "find a team by name" — deliberately thin
// (just enough to disambiguate one team from another with a similar name
// and to key a follow-up fixtures-by-team search), not the full team
// profile API-Football's /teams endpoint returns.
export interface NormalizedTeam {
  provider: string;
  externalTeamId: string;
  name: string;
  countryName: string | null;
  logoUrl: string | null;
}

// A league's own season calendar — start/end vary per league (most run
// Aug-May, some run calendar-year) which is exactly why these dates are
// kept instead of just the year: it's what lets the fixture-import date
// picker figure out the right `season` param for a given date without
// guessing at a universal convention (see fixture-search.tsx).
// API-Football's per-season coverage flags — confirmed live against a real
// /leagues response before this was added. All booleans; `fixtures` nests
// four sub-flags rather than being a single flag itself. Stored verbatim
// into league_season_imports.coverage_snapshot (jsonb) — informational for
// now (surfaced in the Competition Workspace's Templates tab), not yet
// used to gate which pool templates are offered.
export interface LeagueSeasonCoverage {
  fixtures: {
    events: boolean;
    lineups: boolean;
    statistics_fixtures: boolean;
    statistics_players: boolean;
  };
  standings: boolean;
  players: boolean;
  top_scorers: boolean;
  top_assists: boolean;
  top_cards: boolean;
  injuries: boolean;
  predictions: boolean;
  odds: boolean;
}

// A league's own season calendar — start/end vary per league (most run
// Aug-May, some run calendar-year) which is exactly why these dates are
// kept instead of just the year: it's what lets the fixture-import date
// picker figure out the right `season` param for a given date without
// guessing at a universal convention (see fixture-search.tsx).
export interface LeagueSeason {
  year: string;
  startDate: string; // ISO YYYY-MM-DD
  endDate: string; // ISO YYYY-MM-DD
  // The provider's own "is this the season currently being played" flag —
  // a real signal, not a hand-guessed calendar approximation. Confirmed
  // live for API-NFL: this can already be true for a season whose first
  // fixture is still weeks away (flips at the season boundary, not at
  // kickoff) — never treat this alone as "operationally active."
  current: boolean;
  coverage: LeagueSeasonCoverage | null;
}

export interface NormalizedLeague {
  provider: string;
  externalLeagueId: string;
  name: string;
  type: string | null; // "League" | "Cup" etc.
  countryName: string | null;
  logoUrl: string | null;
  seasons: LeagueSeason[];
}

// Internal event vocabulary — application logic (lib/pools/templates/)
// reads only this, never API-Football's raw type/detail strings.
export type FixtureEventDetail =
  | "GOAL_NORMAL"
  | "GOAL_OWN"
  | "GOAL_PENALTY"
  | "GOAL_PENALTY_MISSED"
  | "CARD_YELLOW"
  | "CARD_RED"
  | "CARD_SECOND_YELLOW"
  | "SUBSTITUTION"
  | "VAR"
  | "UNKNOWN";

export interface NormalizedFixtureEvent {
  // elapsed + (extra ?? 0) — see lib/pools/templates/event-helpers.ts for
  // how this is used to exclude shootout events and grade minute-boundary
  // templates.
  effectiveMinute: number;
  teamExternalId: string | null;
  playerExternalId: string | null;
  playerName: string | null;
  assistPlayerExternalId: string | null;
  assistPlayerName: string | null;
  type: "GOAL" | "CARD" | "SUBSTITUTION" | "VAR";
  detail: FixtureEventDetail;
}

export interface NormalizedPlayer {
  externalPlayerId: string;
  name: string;
  position: string | null;
  jerseyNumber: number | null;
}

// ---------------------------------------------------------------------
// Odds/markets are deliberately NOT part of the shared SportsDataProvider
// contract below. This folder used to define a shared getFixtureOdds/
// getFixtureMarkets pair returning one canonical cross-sport shape — it
// was soccer-shaped in practice (goals-line over/unders, a 3-way match
// winner) and NFL could never genuinely implement it, only stub it out.
// The proven pattern, already in production for NFL, is the opposite:
// each sport-specific provider exposes its own raw-odds method with its
// own shape (see api-nfl-provider.ts's getFixtureRawOdds /
// NormalizedNflFixtureOdds below), consumed by that sport's own
// lib/pools/templates/<sport>-odds.ts normalizer. A future NBA/NHL/MLB
// provider should follow that same per-sport pattern rather than
// resurrecting a shared odds type here — bookmaker numbering, market
// structure, and even what counts as a "line" differ enough per sport
// that a single unified shape fights every provider except the one it
// was modeled on.
// ---------------------------------------------------------------------
// NFL raw odds layer — backs the Spread/Game Total/Team Total prefill in
// the pool-creation wizard (lib/pools/templates/nfl-odds.ts). Deliberately
// its own shape, not squeezed into OddsMarket/OddsMarketKey above (those
// are soccer-specific: 3-way match winner, no moneyline/Asian-Handicap
// concept). Kept RAW — the provider's own value labels verbatim (e.g.
// "Home -3.5", "Over 37.5") — rather than pre-interpreted here: the Asian
// Handicap value-pairing convention is genuinely ambiguous (see
// nfl-odds.ts's estimateSpreadMagnitude), so that interpretation, and the
// job of flagging it as unconfirmed, belongs in the one place that owns
// it, not silently baked into normalization.
// ---------------------------------------------------------------------

export interface NflRawOddsValue {
  value: string;
  odd: number;
}

export interface NflBookmakerOdds {
  bookmakerId: number;
  bookmakerName: string;
  moneyline: NflRawOddsValue[]; // bet id 1, "Home"/"Away" — unambiguous
  asianHandicap: NflRawOddsValue[]; // bet id 2, e.g. "Home -3.5" — ambiguous pairing, see nfl-odds.ts
  gameTotal: NflRawOddsValue[]; // bet id 3, e.g. "Over 37.5" / "Under 37"
  homeTeamTotal: NflRawOddsValue[]; // bet id 8, "Total - Home"
  awayTeamTotal: NflRawOddsValue[]; // bet id 9, "Total - Away"
}

export interface NormalizedNflFixtureOdds {
  externalFixtureId: string;
  providerUpdatedAt: string | null;
  bookmakers: NflBookmakerOdds[];
}

export interface SportsDataProvider {
  readonly name: string;
  isEnabled(): boolean;
  searchFixtures(params: FixtureSearchParams): Promise<NormalizedFixture[]>;
  getFixtureById(externalFixtureId: string): Promise<NormalizedFixture | null>;
  searchLeagues(query: string): Promise<NormalizedLeague[]>;
  getLeagueById(externalLeagueId: string): Promise<NormalizedLeague | null>;
  searchTeams(query: string): Promise<NormalizedTeam[]>;
  getLeagueType(externalLeagueId: string): Promise<string | null>;
  getFixtureEvents(externalFixtureId: string): Promise<NormalizedFixtureEvent[]>;
  getTeamSquad(externalTeamId: string): Promise<NormalizedPlayer[]>;
  // The complete season, past and future, in one call (no date
  // restriction) — backs the competition-import-manager's import,
  // discovery-sync, and recommendation-availability-cache paths. Distinct
  // from searchFixtures' league+season branch, which deliberately narrows
  // to upcoming-only for the existing by-league manual browse/import flow.
  getSeasonFixtures(externalLeagueId: string, season: string): Promise<NormalizedFixture[]>;
  // Every fixture across every competition on the given UTC calendar
  // dates — backs the date-first fixture discovery workflow
  // (app/(admin)/admin/fixtures, mode=date). fromDate/toDate are plain
  // UTC calendar dates (YYYY-MM-DD), inclusive — this method is
  // deliberately timezone-agnostic; converting an admin's local date
  // range (e.g. "Today" in America/Costa_Rica) into the UTC calendar
  // dates that need querying is the caller's job (see
  // lib/fixtures/date-window.ts's resolveFixtureDateWindow), not this
  // layer's. One provider request per calendar date (API-Football's
  // `date` filter has no native range form), merged and de-duplicated by
  // externalFixtureId before returning. An optional competitionExternalId
  // narrows the request itself (adds `league=X` to every per-date call)
  // rather than over-fetching every competition and filtering
  // client-side — this is what makes it a genuinely provider-backed
  // filter, not a local one, and why it belongs in the search's cache key.
  searchFixturesByDateRange(params: {
    fromDate: string;
    toDate: string;
    competitionExternalId?: string;
  }): Promise<NormalizedFixture[]>;
}
