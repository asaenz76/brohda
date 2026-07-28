import { requireSuperAdmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { PoolTemplateBuilder } from "./pool-template-builder";

export default async function NewPoolPage() {
  await requireSuperAdmin();
  const supabase = await createClient();

  // Excludes any fixture whose every pool has already been graded (SETTLED/
  // CANCELLED/VOIDED) — nothing left to attach a new pool to. Team name/
  // logo/external-id fields are fetched (not just the display label) so the
  // client can run the exact same generatePoolTemplate() question/options
  // logic locally for a live preview, without a server round trip per pick.
  const { data: fixtures } = await supabase
    .from("fixtures_available_for_pool_creation")
    .select(
      "id, external_fixture_id, home_team_external_id, home_team_name, home_team_logo_url, away_team_external_id, away_team_name, away_team_logo_url, competition_name, competition_country, competition_type, scheduled_start_utc",
    )
    .order("scheduled_start_utc", { ascending: true });

  const fixtureOptions = (fixtures ?? []).map((f) => {
    const league = f.competition_name
      ? f.competition_country
        ? `${f.competition_country} | ${f.competition_name}`
        : f.competition_name
      : null;
    return {
      id: f.id,
      externalFixtureId: f.external_fixture_id,
      homeTeamExternalId: f.home_team_external_id,
      homeTeamName: f.home_team_name,
      homeTeamLogoUrl: f.home_team_logo_url,
      awayTeamExternalId: f.away_team_external_id,
      awayTeamName: f.away_team_name,
      awayTeamLogoUrl: f.away_team_logo_url,
      competitionType: f.competition_type,
      league,
      label: `${f.home_team_name} vs ${f.away_team_name}${league ? ` (${league})` : ""} — ${new Date(
        f.scheduled_start_utc,
      ).toLocaleString()}`,
      scheduledStartUtc: f.scheduled_start_utc,
    };
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Create a pool</h1>
      <PoolTemplateBuilder fixtures={fixtureOptions} />
    </div>
  );
}
