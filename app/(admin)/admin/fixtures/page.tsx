import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import { FixtureSearch } from "./fixture-search";
import { ImportedFixturesList } from "./imported-fixtures-list";

export default async function AdminFixturesPage() {
  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();

  const providerEnabled = apiFootballProvider.isEnabled();
  const leagues = providerEnabled ? await apiFootballProvider.searchLeagues("").catch(() => []) : [];

  const [{ data: fixtures }, { data: pools }] = await Promise.all([
    supabase
      .from("fixtures")
      .select(
        "id, external_fixture_id, sport, home_team_name, away_team_name, competition_name, competition_country, scheduled_start_utc, hidden_from_pool_creation",
      )
      .not("internal_status", "in", `(${TERMINAL_STATUSES.join(",")})`)
      .order("scheduled_start_utc", { ascending: false }),
    supabase.from("pools").select("fixture_id").not("fixture_id", "is", null),
  ]);

  const poolCountByFixtureId = new Map<string, number>();
  for (const pool of pools ?? []) {
    const fixtureId = pool.fixture_id as string;
    poolCountByFixtureId.set(fixtureId, (poolCountByFixtureId.get(fixtureId) ?? 0) + 1);
  }

  const importedFixtures = (fixtures ?? []).map((f) => ({
    id: f.id as string,
    externalFixtureId: f.external_fixture_id as string,
    sport: f.sport as string | null,
    homeTeamName: f.home_team_name as string,
    awayTeamName: f.away_team_name as string,
    competitionName: f.competition_name as string | null,
    competitionCountry: f.competition_country as string | null,
    scheduledStartUtc: f.scheduled_start_utc as string,
    poolCount: poolCountByFixtureId.get(f.id as string) ?? 0,
    hidden: f.hidden_from_pool_creation as boolean,
  }));

  return (
    <div className="space-y-8">
      <h1 className="sr-only">Fixtures</h1>
      <FixtureSearch leagues={leagues} providerDisabled={!providerEnabled} />
      <ImportedFixturesList fixtures={importedFixtures} isSuperAdmin={isSuperAdmin} />
    </div>
  );
}
