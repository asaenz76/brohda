import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SportConfig } from "@/lib/sports-data/sport-registry";
import { getCurrentSportsbookWeek } from "@/lib/sports-data/sportsbook-week";

export interface EligibleFixture {
  id: string;
  externalFixtureId: string;
  homeTeamName: string;
  awayTeamName: string;
}

/**
 * The not-yet-started Games of this sport inside its window: the NFL's established "current sportsbook week", or a bounded number of hours for a daily-schedule
 * sport (sport registry data). Used by odds ingestion (which then also skips recently refreshed Games to protect the request budget) and by the Game-driven Market step.
 * The original incident this window exists for: an unbounded candidate set once exhausted the whole NFL daily quota; the same discipline applies to every sport.
 */
export async function listUpcomingFixtures(config: SportConfig, now: Date = new Date()): Promise<EligibleFixture[]> {
  const admin = createAdminClient();
  const windowEnd = config.oddsWindow.kind === "sportsbook-week" ? getCurrentSportsbookWeek(now).weekEndUtc : new Date(now.getTime() + config.oddsWindow.hours * 3_600_000).toISOString();
  const { data, error } = await admin
    .from("fixtures")
    .select("id, external_fixture_id, home_team_name, away_team_name")
    .eq("provider", config.provider)
    .eq("internal_status", "NOT_STARTED")
    .gt("scheduled_start_utc", now.toISOString())
    .lt("scheduled_start_utc", windowEnd);
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id, externalFixtureId: row.external_fixture_id, homeTeamName: row.home_team_name, awayTeamName: row.away_team_name }));
}

