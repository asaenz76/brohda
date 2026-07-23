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
}

export interface NormalizedLeague {
  provider: string;
  externalLeagueId: string;
  name: string;
  type: string | null; // "League" | "Cup" etc.
  countryName: string | null;
  logoUrl: string | null;
  seasons: string[];
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

export interface SportsDataProvider {
  readonly name: string;
  isEnabled(): boolean;
  searchFixtures(params: FixtureSearchParams): Promise<NormalizedFixture[]>;
  getFixtureById(externalFixtureId: string): Promise<NormalizedFixture | null>;
  searchLeagues(query: string): Promise<NormalizedLeague[]>;
  getLeagueType(externalLeagueId: string): Promise<string | null>;
  getFixtureEvents(externalFixtureId: string): Promise<NormalizedFixtureEvent[]>;
  getTeamSquad(externalTeamId: string): Promise<NormalizedPlayer[]>;
}
