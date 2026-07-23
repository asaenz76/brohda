import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { resolvePublicProfile } from "@/lib/profiles/fetch";
import { UserListRow, type UserListEntry } from "@/components/profile/UserListRow";
import { EmptyFeedState } from "@/components/EmptyFeedState";

// Reachable for your own profile too (the stats row links here from
// /profile using your own username-or-id) — unlike the main profile page,
// there's no redirect for viewing your own list.
export default async function FollowingPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username: identifier } = await params;
  const currentUser = await requireUser();
  const supabase = await createClient();

  const profile = await resolvePublicProfile(identifier);
  if (!profile) notFound();

  const { data: rows } = await supabase.rpc("get_following", {
    p_user_id: profile.id,
    p_viewer_id: currentUser.id,
  });

  const entries: UserListEntry[] = (
    (rows ?? []) as Array<{
      user_id: string;
      display_name: string;
      username: string | null;
      avatar_url: string | null;
      is_following: boolean;
    }>
  ).map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    isFollowing: row.is_following,
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-text-primary">
        {profile.id === currentUser.id ? "Following" : `Who ${profile.display_name} follows`}
      </h1>

      {entries.length === 0 ? (
        <EmptyFeedState icon={Users} title="Not following anyone yet" description="Nobody here yet." />
      ) : (
        <ul className="space-y-1">
          {entries.map((entry) => (
            <UserListRow key={entry.userId} entry={entry} viewerId={currentUser.id} />
          ))}
        </ul>
      )}
    </div>
  );
}
