import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R4 (§14): derives canonical sports entities from a Game's
// existing, already-populated relationships — never display-text matching,
// never fuzzy matching. `teams`/`leagues` are populated automatically
// alongside every fixture sync (lib/sports-data/persist.ts), keyed by
// (provider, external_id) — the same join key this function uses.
// Resolution can legitimately fail for one or more entities (a
// best-effort external id was never populated, or that team/league hasn't
// synced yet) — every field is nullable except sportKey (fixtures.sport is
// NOT NULL) and callers must treat a null as "skip this one distribution
// target," never as an error blocking the others.

export interface FixtureSportsEntities {
  homeTeamId: string | null;
  awayTeamId: string | null;
  leagueId: string | null;
  sportKey: string;
}

export async function resolveFixtureSportsEntities(fixtureId: string): Promise<FixtureSportsEntities | null> {
  const admin = createAdminClient();
  const { data: fixture, error } = await admin
    .from("fixtures")
    .select("provider, sport, home_team_external_id, away_team_external_id, competition_external_id")
    .eq("id", fixtureId)
    .maybeSingle();
  if (error) throw error;
  if (!fixture) return null;

  const [homeTeam, awayTeam, league] = await Promise.all([
    fixture.home_team_external_id
      ? admin.from("teams").select("id").eq("provider", fixture.provider).eq("external_id", fixture.home_team_external_id).maybeSingle()
      : Promise.resolve({ data: null }),
    fixture.away_team_external_id
      ? admin.from("teams").select("id").eq("provider", fixture.provider).eq("external_id", fixture.away_team_external_id).maybeSingle()
      : Promise.resolve({ data: null }),
    fixture.competition_external_id
      ? admin.from("leagues").select("id").eq("provider", fixture.provider).eq("external_id", fixture.competition_external_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    homeTeamId: homeTeam.data?.id ?? null,
    awayTeamId: awayTeam.data?.id ?? null,
    leagueId: league.data?.id ?? null,
    sportKey: fixture.sport,
  };
}
