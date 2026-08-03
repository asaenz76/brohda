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
  // API-Football's own "is this the season currently being played" flag —
  // the real signal for the fixture-import league picker's "In season now"
  // group (lib/sports-data/league-picker.ts), instead of a hand-guessed
  // calendar approximation. Confirmed live: this can already be true for a
  // season whose first fixture is still weeks away (flips at the season
  // boundary, not at kickoff) — never treat this alone as "operationally
  // active," see ACTIVATION_WINDOW_DAYS in the competition-import design.
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

// A single bookmaker's Over/Under total-goals line — only `.5`-point lines
// are ever normalized into this shape (see api-football-provider.ts's
// parseGoalsLines): the standard, unambiguous over/under convention with
// no "push"/void case, unlike a whole-number line.
export interface OddsGoalsLine {
  point: number; // e.g. 2.5
  overOdd: number;
  underOdd: number;
}

// A single bookmaker's full-match exact-goals-count distribution for one
// team (no Over/Under line market exists for this, unlike match/first-half
// totals — "Home/Away Team Exact Goals Number" is the closest equivalent).
// `count` is the exact goal count for a normal bucket; for the open-ended
// last bucket (API-Football's "more N" value), `count` is `N + 1` and
// `isTail` is true, meaning "this many goals or more."
export interface OddsExactGoalsBucket {
  count: number;
  isTail: boolean;
  odd: number;
}

export interface NormalizedFixtureOdds {
  externalFixtureId: string;
  matchGoalsLines: OddsGoalsLine[]; // bet id 5, "Goals Over/Under"
  firstHalfGoalsLines: OddsGoalsLine[]; // bet id 6, "Goals Over/Under First Half"
  homeTeamGoalsDistributions: OddsExactGoalsBucket[][]; // bet id 40, one array per bookmaker
  awayTeamGoalsDistributions: OddsExactGoalsBucket[][]; // bet id 41, one array per bookmaker
}

// ---------------------------------------------------------------------
// Normalized market layer — backs the odds-driven recommendation engine
// (lib/pools/templates/odds-mapping.ts, odds-consensus.ts, odds-devig.ts).
// Deliberately separate from NormalizedFixtureOdds above (which only ever
// feeds the older, unrelated goals-line prefill in lib/pools/templates/
// goals-odds.ts) — this shape keeps per-bookmaker identity, which that
// older shape discards, since consensus-building needs to know which
// bookmaker each price came from. A future non-soccer provider only needs
// to produce this same shape for the recommendation engine to work
// unchanged; nothing above this layer (odds-mapping.ts and up) ever reads
// provider-specific bet ids or response shapes.
// ---------------------------------------------------------------------

/** One bookmaker's two-way price for a single proposition (a specific
 * line, or the only line for a non-threshold market like "Both teams to
 * score"). Raw, pre-devig — every consumer removes the vig itself. */
export interface OddsProposition {
  bookmakerId: number;
  bookmakerName: string;
  yesOdd: number;
  noOdd: number;
}

/** One threshold ("line") of a market, e.g. "Over/Under 2.5 goals" — every
 * bookmaker offering exactly this point, so a consensus can be built per
 * line before picking which line to use (see odds-mapping.ts). Non-
 * threshold markets (BOTH_TEAMS_SCORE, CLEAN_SHEET_*, ...) always have
 * exactly one line, with `point` fixed at 0. */
export interface OddsMarketLine {
  point: number;
  propositions: OddsProposition[];
}

// Every market family the recommendation engine's allowlist can consume —
// see odds-mapping.ts for which PollPools templates map to which key.
// Deliberately does NOT include a general Asian Handicap / winning-margin
// market: API-Football's value-pairing convention for that bet type
// couldn't be confirmed with confidence from the live samples audited
// before this was built (see the WINNING_MARGIN note in odds-mapping.ts),
// so it was left out rather than risk a silently wrong consensus label on
// an admin-facing "market estimate."
export type OddsMarketKey =
  | "BOTH_TEAMS_SCORE"
  | "CLEAN_SHEET_HOME"
  | "CLEAN_SHEET_AWAY"
  | "WIN_TO_NIL_HOME"
  | "WIN_TO_NIL_AWAY"
  | "OWN_GOAL"
  | "MATCH_TOTAL_GOALS"
  | "FIRST_HALF_TOTAL_GOALS"
  | "TEAM_TOTAL_GOALS_HOME"
  | "TEAM_TOTAL_GOALS_AWAY";

export interface OddsMarket {
  key: OddsMarketKey;
  lines: OddsMarketLine[];
}

/** One bookmaker's full 3-way match-winner price — kept as its own shape
 * (not squeezed into OddsProposition's 2-way form) since HOME_TEAM_TO_WIN/
 * AWAY_TEAM_TO_WIN/EITHER_TEAM_TO_WIN/TEAM_TO_AVOID_DEFEAT are all derived
 * from the same 3-way de-vig (see odds-consensus.ts's
 * buildMatchWinnerConsensus). */
export interface MatchWinnerLine {
  bookmakerId: number;
  bookmakerName: string;
  homeOdd: number;
  drawOdd: number;
  awayOdd: number;
}

export interface NormalizedFixtureMarkets {
  externalFixtureId: string;
  // The provider's own "last updated" timestamp for this odds snapshot —
  // never our own fetch time, so the UI's "Updated N minutes ago" reflects
  // when the market actually moved, not when we last polled it.
  providerUpdatedAt: string | null;
  matchWinner: MatchWinnerLine[];
  markets: OddsMarket[];
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
  getFixtureOdds(externalFixtureId: string): Promise<NormalizedFixtureOdds | null>;
  getFixtureMarkets(externalFixtureId: string): Promise<NormalizedFixtureMarkets | null>;
  // The complete season, past and future, in one call (no date
  // restriction) — backs the competition-import-manager's import,
  // discovery-sync, and recommendation-availability-cache paths. Distinct
  // from searchFixtures' league+season branch, which deliberately narrows
  // to upcoming-only for the existing by-league manual browse/import flow.
  getSeasonFixtures(externalLeagueId: string, season: string): Promise<NormalizedFixture[]>;
}
