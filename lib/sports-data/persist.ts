import type { NormalizedFixture } from "./types";

/** Maps a NormalizedFixture to the `fixtures` table row shape, shared by
 * the sync job and the admin import action so the two never drift apart.
 * `competition_type` is only ever included in the returned object when
 * `fixture.competitionType` is explicitly set (import path) — omitting the
 * key entirely (re-sync path, where it's never looked up) means Postgres's
 * ON CONFLICT DO UPDATE leaves the already-stored value untouched instead
 * of clobbering it back to null on every periodic re-sync. */
export function toFixtureRow(fixture: NormalizedFixture) {
  return {
    provider: fixture.provider,
    external_fixture_id: fixture.externalFixtureId,
    sport: fixture.sport,
    competition_external_id: fixture.competitionExternalId,
    competition_name: fixture.competitionName,
    competition_country: fixture.competitionCountry,
    competition_logo_url: fixture.competitionLogoUrl,
    ...(fixture.competitionType !== undefined ? { competition_type: fixture.competitionType } : {}),
    season: fixture.season,
    round: fixture.round,
    home_team_external_id: fixture.homeTeamExternalId,
    home_team_name: fixture.homeTeamName,
    home_team_logo_url: fixture.homeTeamLogoUrl,
    away_team_external_id: fixture.awayTeamExternalId,
    away_team_name: fixture.awayTeamName,
    away_team_logo_url: fixture.awayTeamLogoUrl,
    venue_name: fixture.venueName,
    venue_city: fixture.venueCity,
    venue_timezone: fixture.venueTimezone,
    scheduled_start_utc: fixture.scheduledStartUtc,
    provider_timezone: fixture.providerTimezone,
    provider_status_code: fixture.providerStatusCode,
    provider_status_description: fixture.providerStatusDescription,
    internal_status: fixture.internalStatus,
    elapsed_minutes: fixture.elapsedMinutes,
    home_score: fixture.homeScore,
    away_score: fixture.awayScore,
    halftime_home_score: fixture.halftimeHomeScore,
    halftime_away_score: fixture.halftimeAwayScore,
    regulation_home_score: fixture.regulationHomeScore,
    regulation_away_score: fixture.regulationAwayScore,
    extra_time_home_score: fixture.extraTimeHomeScore,
    extra_time_away_score: fixture.extraTimeAwayScore,
    penalty_home_score: fixture.penaltyHomeScore,
    penalty_away_score: fixture.penaltyAwayScore,
    provider_payload: fixture.providerPayload,
    last_synced_at: new Date().toISOString(),
    sync_error: null,
  };
}
