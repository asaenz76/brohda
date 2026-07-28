import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import { ImportedFixturesList } from "../fixtures/imported-fixtures-list";

export default async function FixtureArchivePage() {
  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();

  const [{ data: fixtures }, { data: pools }] = await Promise.all([
    supabase
      .from("fixtures")
      .select(
        "id, external_fixture_id, home_team_name, away_team_name, competition_name, scheduled_start_utc, hidden_from_pool_creation",
      )
      .in("internal_status", TERMINAL_STATUSES)
      .order("scheduled_start_utc", { ascending: false }),
    supabase.from("pools").select("fixture_id").not("fixture_id", "is", null),
  ]);

  const poolCountByFixtureId = new Map<string, number>();
  for (const pool of pools ?? []) {
    const fixtureId = pool.fixture_id as string;
    poolCountByFixtureId.set(fixtureId, (poolCountByFixtureId.get(fixtureId) ?? 0) + 1);
  }

  const archivedFixtures = (fixtures ?? []).map((f) => ({
    id: f.id as string,
    externalFixtureId: f.external_fixture_id as string,
    homeTeamName: f.home_team_name as string,
    awayTeamName: f.away_team_name as string,
    competitionName: f.competition_name as string | null,
    scheduledStartUtc: f.scheduled_start_utc as string,
    poolCount: poolCountByFixtureId.get(f.id as string) ?? 0,
    hidden: f.hidden_from_pool_creation as boolean,
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Fixture Archive</h1>
        <p className="text-sm text-text-secondary">
          Fixtures that have finished, been cancelled, abandoned, or awarded — moved out of the main
          Fixtures list automatically once settled.
        </p>
      </div>
      <ImportedFixturesList fixtures={archivedFixtures} isSuperAdmin={isSuperAdmin} heading="Archived fixtures" />
    </div>
  );
}
