import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { toggleTeamFollowAction, updateTeamFollowEmailAction } from "@/lib/actions/team-follows";
import { toggleLeagueFollowAction, updateLeagueFollowEmailAction } from "@/lib/actions/league-follows";
import { FollowedItemRow } from "./followed-item-row";

interface TeamFollowRow {
  team_id: string;
  email_enabled: boolean;
  teams: { name: string; logo_url: string | null } | null;
}

interface LeagueFollowRow {
  league_id: string;
  email_enabled: boolean;
  leagues: { name: string; logo_url: string | null } | null;
}

// Own-account-only management view (not a public /profile/[username] route,
// unlike the people followers/following lists) — listing the current
// viewer's own private notification preferences, so it's read through the
// request-scoped client via select_own_team_follows/select_own_league_follows
// rather than the admin client.
export async function FollowedTeamsLeaguesTab() {
  const user = await requireUser();
  const supabase = await createClient();

  const [{ data: teamFollows }, { data: leagueFollows }] = await Promise.all([
    supabase
      .from("team_follows")
      .select("team_id, email_enabled, teams(name, logo_url)")
      .eq("user_id", user.id)
      .returns<TeamFollowRow[]>(),
    supabase
      .from("league_follows")
      .select("league_id, email_enabled, leagues(name, logo_url)")
      .eq("user_id", user.id)
      .returns<LeagueFollowRow[]>(),
  ]);

  const teams = teamFollows ?? [];
  const leagues = leagueFollows ?? [];

  if (teams.length === 0 && leagues.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        You&apos;re not following any teams or leagues yet. Tap the star next to a team name or league on any pool
        card to get notified when a new pool goes up for it.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {teams.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Teams</h2>
          <ul className="space-y-2">
            {teams.map((follow) => (
              <FollowedItemRow
                key={follow.team_id}
                id={follow.team_id}
                name={follow.teams?.name ?? "Unknown team"}
                logoUrl={follow.teams?.logo_url ?? null}
                emailEnabled={follow.email_enabled}
                onToggleEmail={updateTeamFollowEmailAction}
                onUnfollow={toggleTeamFollowAction}
              />
            ))}
          </ul>
        </div>
      )}

      {leagues.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Leagues</h2>
          <ul className="space-y-2">
            {leagues.map((follow) => (
              <FollowedItemRow
                key={follow.league_id}
                id={follow.league_id}
                name={follow.leagues?.name ?? "Unknown league"}
                logoUrl={follow.leagues?.logo_url ?? null}
                emailEnabled={follow.email_enabled}
                onToggleEmail={updateLeagueFollowEmailAction}
                onUnfollow={toggleLeagueFollowAction}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
