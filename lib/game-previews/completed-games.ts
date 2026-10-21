import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** A completed Game is treated as over this long after it started (a conservative upper bound for NFL, NBA and NHL). */
const GAME_LENGTH_MS = 3 * 3_600_000;

export interface FixtureForFreshness {
  provider: string | null;
  competition_external_id: string | null;
  season: string | null;
  scheduled_start_utc: string;
  home_team_name: string;
  away_team_name: string;
  home_team_external_id: string | null;
  away_team_external_id: string | null;
}

/**
 * The most recent COMPLETED Game of each team before this fixture (same provider, competition and season identifier), as `{ team, completedUtc }`. A team with no earlier completed Game is simply absent (an opener: nothing can be stale).
 * Throws when the schedule data cannot be read: the caller must treat that as "unknown", never as "none", because freshness cannot be shown without it.
 */
export async function latestCompletedGames(f: FixtureForFreshness): Promise<Array<{ team: string; completedUtc: string }>> {
  const teams = [
    { name: f.home_team_name, id: f.home_team_external_id },
    { name: f.away_team_name, id: f.away_team_external_id },
  ];
  let q = createAdminClient()
    .from("fixtures")
    .select("home_team_name, away_team_name, home_team_external_id, away_team_external_id, scheduled_start_utc")
    .eq("internal_status", "COMPLETED")
    .lt("scheduled_start_utc", f.scheduled_start_utc);
  if (f.provider) q = q.eq("provider", f.provider);
  if (f.competition_external_id) q = q.eq("competition_external_id", f.competition_external_id);
  if (f.season) q = q.eq("season", f.season);
  const ors = teams.flatMap((t) => (t.id ? [`home_team_external_id.eq.${t.id}`, `away_team_external_id.eq.${t.id}`] : [`home_team_name.eq.${JSON.stringify(t.name)}`, `away_team_name.eq.${JSON.stringify(t.name)}`]));
  const { data, error } = await q.or(ors.join(",")).order("scheduled_start_utc", { ascending: false }).limit(30);
  if (error) throw error;
  const rows = data ?? [];
  const out: Array<{ team: string; completedUtc: string }> = [];
  for (const t of teams) {
    const game = rows.find((r) => (t.id ? r.home_team_external_id === t.id || r.away_team_external_id === t.id : r.home_team_name === t.name || r.away_team_name === t.name));
    if (game) out.push({ team: t.name, completedUtc: new Date(new Date(game.scheduled_start_utc).getTime() + GAME_LENGTH_MS).toISOString() });
  }
  return out;
}
