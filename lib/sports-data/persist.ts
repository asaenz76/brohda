import type { createAdminClient } from "@/lib/supabase/admin";
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

/** Maps a NormalizedFixture to `teams` upsert rows (home + away), shared
 * by the sync job and the admin import action alongside toFixtureRow —
 * the same fixture payload is the only place a team's external_id, name,
 * and logo are all available together. Teams with no external_id are
 * skipped (teams.external_id is not null). */
export function toTeamRows(fixture: NormalizedFixture) {
  return [
    {
      provider: fixture.provider,
      external_id: fixture.homeTeamExternalId,
      name: fixture.homeTeamName,
      logo_url: fixture.homeTeamLogoUrl,
    },
    {
      provider: fixture.provider,
      external_id: fixture.awayTeamExternalId,
      name: fixture.awayTeamName,
      logo_url: fixture.awayTeamLogoUrl,
    },
  ].filter((row): row is typeof row & { external_id: string } => row.external_id != null);
}

/** Maps a NormalizedFixture to a `leagues` upsert row, or null when the
 * fixture is missing the external_id or name leagues.name requires (both
 * are nullable on NormalizedFixture, unlike the team name fields). */
export function toLeagueRow(fixture: NormalizedFixture) {
  if (fixture.competitionExternalId == null || fixture.competitionName == null) return null;
  return {
    provider: fixture.provider,
    external_id: fixture.competitionExternalId,
    name: fixture.competitionName,
    logo_url: fixture.competitionLogoUrl,
  };
}

/** Writes one fixture (any provider — nothing here is football-specific)
 * plus its teams/leagues follow-target rows in one call. Moved here from
 * sync.ts so the NFL sync path can share it verbatim instead of
 * duplicating the same three upserts. Teams/leagues upsert with `do
 * update` (not `do nothing`) so a provider rename/rebrand is reflected on
 * next sync. */
export async function upsertFixture(
  admin: ReturnType<typeof createAdminClient>,
  fixture: NormalizedFixture,
): Promise<void> {
  await admin.from("fixtures").upsert(toFixtureRow(fixture), { onConflict: "provider,external_fixture_id" });

  const teamRows = toTeamRows(fixture);
  if (teamRows.length > 0) {
    await admin.from("teams").upsert(teamRows, { onConflict: "provider,external_id" });
  }
  const leagueRow = toLeagueRow(fixture);
  if (leagueRow) {
    await admin.from("leagues").upsert(leagueRow, { onConflict: "provider,external_id" });
  }
}

/** Same three upserts as upsertFixture, but one round trip per TABLE
 * instead of one per FIXTURE — for sync-nfl.ts's use only. NFL's sync
 * fetches an entire ~320-game season in a single provider call (unlike
 * football's adaptive per-fixture polling, which genuinely processes one
 * fixture at a time and has no batch to make), so a first-ever run that
 * looped upsertFixture per game would serialize ~960 DB round trips —
 * measured in production to blow past cron-job.org's fixed 30s job
 * timeout. Every upsert's `error` is checked and thrown explicitly — the
 * Supabase JS client resolves (never rejects) on a PostgREST error, so an
 * un-checked `await` here would silently no-op instead of failing loudly
 * (exactly what happened during testing: a batch upsert error was
 * swallowed, reporting 328 "refreshed" while writing zero rows). Fixture
 * rows are deduplicated by (provider, external_fixture_id) before
 * upserting — a single multi-row upsert statement errors outright
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time") if
 * two rows in the same call share a conflict key, unlike upsertFixture's
 * per-row loop where a duplicate is harmless (second write just
 * overwrites the first). Teams/leagues rows are deduplicated the same
 * way, since the same team/league appears in many fixtures. On failure,
 * every fixture in the batch is reported failed together (not isolated
 * per-fixture like upsertFixture) — an acceptable tradeoff here since the
 * next cron tick re-fetches and retries the full season anyway. */
export async function upsertFixturesBatch(
  admin: ReturnType<typeof createAdminClient>,
  fixtures: NormalizedFixture[],
): Promise<void> {
  if (fixtures.length === 0) return;

  const fixturesByKey = new Map<string, NormalizedFixture>();
  for (const fixture of fixtures) {
    fixturesByKey.set(`${fixture.provider}:${fixture.externalFixtureId}`, fixture);
  }
  const dedupedFixtures = [...fixturesByKey.values()];

  const { error: fixturesError } = await admin
    .from("fixtures")
    .upsert(dedupedFixtures.map(toFixtureRow), { onConflict: "provider,external_fixture_id" });
  if (fixturesError) throw fixturesError;

  const teamRowsByKey = new Map<string, ReturnType<typeof toTeamRows>[number]>();
  for (const fixture of dedupedFixtures) {
    for (const row of toTeamRows(fixture)) {
      teamRowsByKey.set(`${row.provider}:${row.external_id}`, row);
    }
  }
  if (teamRowsByKey.size > 0) {
    const { error: teamsError } = await admin
      .from("teams")
      .upsert([...teamRowsByKey.values()], { onConflict: "provider,external_id" });
    if (teamsError) throw teamsError;
  }

  const leagueRowsByKey = new Map<string, NonNullable<ReturnType<typeof toLeagueRow>>>();
  for (const fixture of dedupedFixtures) {
    const row = toLeagueRow(fixture);
    if (row) leagueRowsByKey.set(`${row.provider}:${row.external_id}`, row);
  }
  if (leagueRowsByKey.size > 0) {
    const { error: leaguesError } = await admin
      .from("leagues")
      .upsert([...leagueRowsByKey.values()], { onConflict: "provider,external_id" });
    if (leaguesError) throw leaguesError;
  }
}
