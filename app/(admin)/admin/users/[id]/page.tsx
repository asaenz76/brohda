import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Avatar } from "@/components/Avatar";
import { humanizeEnum } from "@/lib/utils/humanize";
import { Card, CardContent } from "@/components/ui/card";

interface FollowedTeamRow {
  team_id: string;
  teams: { name: string; logo_url: string | null } | null;
}

interface FollowedLeagueRow {
  league_id: string;
  leagues: { name: string; logo_url: string | null } | null;
}

function FollowedItem({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    <li className="flex items-center gap-2">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-6 rounded-full object-contain" />
      ) : (
        <span className="size-6 rounded-full bg-surface-elevated" aria-hidden="true" />
      )}
      <span className="text-sm text-text-primary">{name}</span>
    </li>
  );
}

// Followed teams/leagues are the user's own private preference data —
// select_all_team_follows_as_admin/select_all_league_follows_as_admin
// (20260101000082) scope this read to super_admin only, matching the
// wallet_balances admin-visibility precedent, so a plain 'admin' viewer
// would just get an empty result back rather than an error; the section
// is hidden entirely for them instead of rendering "not following anything."
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();

  const { data: user } = await supabase
    .from("user_profiles")
    .select("id, display_name, username, avatar_url, role, is_active, created_at")
    .eq("id", id)
    .single();
  if (!user) notFound();

  const [{ data: teamFollows }, { data: leagueFollows }] = await Promise.all([
    isSuperAdmin
      ? supabase
          .from("team_follows")
          .select("team_id, teams(name, logo_url)")
          .eq("user_id", id)
          .returns<FollowedTeamRow[]>()
      : Promise.resolve({ data: null }),
    isSuperAdmin
      ? supabase
          .from("league_follows")
          .select("league_id, leagues(name, logo_url)")
          .eq("user_id", id)
          .returns<FollowedLeagueRow[]>()
      : Promise.resolve({ data: null }),
  ]);

  const teams = teamFollows ?? [];
  const leagues = leagueFollows ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Avatar displayName={user.display_name} avatarUrl={user.avatar_url} size="lg" />
        <div>
          <h1 className="text-lg font-semibold text-text-primary">{user.display_name}</h1>
          {user.username && <p className="text-sm text-text-muted">@{user.username}</p>}
          <p className="text-xs text-text-secondary">
            {humanizeEnum(user.role)} · {user.is_active ? "Active" : "Inactive"}
          </p>
        </div>
      </div>

      <p className="text-sm">
        <Link href={`/profile/${user.username ?? user.id}`} className="text-accent-primary-label hover:underline">
          View public profile
        </Link>
      </p>

      {isSuperAdmin && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <h2 className="text-sm font-semibold text-text-primary">Following</h2>
            {teams.length === 0 && leagues.length === 0 ? (
              <p className="text-sm text-text-secondary">Not following any teams or leagues.</p>
            ) : (
              <div className="space-y-4">
                {teams.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-medium text-text-muted">Teams</h3>
                    <ul className="space-y-2">
                      {teams.map((f) => (
                        <FollowedItem key={f.team_id} name={f.teams?.name ?? "Unknown team"} logoUrl={f.teams?.logo_url ?? null} />
                      ))}
                    </ul>
                  </div>
                )}
                {leagues.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-medium text-text-muted">Leagues</h3>
                    <ul className="space-y-2">
                      {leagues.map((f) => (
                        <FollowedItem key={f.league_id} name={f.leagues?.name ?? "Unknown league"} logoUrl={f.leagues?.logo_url ?? null} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
