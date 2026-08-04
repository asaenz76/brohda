import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import { parseDateRangeParam } from "@/lib/fixtures/date-window";
import { ModeTabs, type FixturesMode } from "./mode-tabs";
import { DateMode } from "./date-mode/date-mode";
import { CompetitionMode, type WorkspaceRef } from "./competition-mode";
import { FixtureIdMode } from "./fixture-id-mode";
import { ImportedFixturesList } from "./imported-fixtures-list";

function normalizeMode(raw: string | undefined): FixturesMode {
  if (raw === "competition" || raw === "fixture-id") return raw;
  return "date"; // default per spec §0
}

export default async function AdminFixturesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();
  const params = await searchParams;
  const mode = normalizeMode(params.mode);

  const providerEnabled = apiFootballProvider.isEnabled();
  const leagues = providerEnabled && mode === "competition" ? await apiFootballProvider.searchLeagues("").catch(() => []) : [];

  const [{ data: fixtures }, { data: pools }, { data: workspaceRows }] = await Promise.all([
    supabase
      .from("fixtures")
      .select(
        "id, external_fixture_id, sport, home_team_name, away_team_name, competition_name, competition_country, scheduled_start_utc, hidden_from_pool_creation",
      )
      .not("internal_status", "in", `(${TERMINAL_STATUSES.join(",")})`)
      .order("scheduled_start_utc", { ascending: false }),
    supabase.from("pools").select("fixture_id").not("fixture_id", "is", null),
    mode === "competition"
      ? supabase.from("league_season_imports").select("id, external_league_id, season")
      : Promise.resolve({ data: [] as Array<{ id: string; external_league_id: string; season: string }> }),
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

  const workspaces: WorkspaceRef[] = (workspaceRows ?? []).map((w) => ({
    id: w.id as string,
    externalLeagueId: w.external_league_id as string,
    season: w.season as string,
  }));

  // Server-side normalization of date-mode URL params — a malformed
  // preset/date silently falls back to the default rather than ever
  // reaching a provider call with bad input (real validation happens
  // again, authoritatively, inside searchFixturesByDateAction; this only
  // resolves what DateMode's initial client state should be).
  const initialPreset = parseDateRangeParam(params.range);
  const initialCustomFrom = params.from ?? "";
  const initialCustomTo = params.to ?? "";
  const initialCompetitionExternalId = params.competition ?? "";

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Fixtures</h1>
      <ModeTabs mode={mode} />

      {mode === "date" && (
        <DateMode
          providerDisabled={!providerEnabled}
          initialPreset={initialPreset}
          initialCustomFrom={initialCustomFrom}
          initialCustomTo={initialCustomTo}
          initialCompetitionExternalId={initialCompetitionExternalId}
        />
      )}
      {mode === "competition" && <CompetitionMode leagues={leagues} workspaces={workspaces} providerDisabled={!providerEnabled} />}
      {mode === "fixture-id" && <FixtureIdMode providerDisabled={!providerEnabled} />}

      <ImportedFixturesList fixtures={importedFixtures} isSuperAdmin={isSuperAdmin} />
    </div>
  );
}
