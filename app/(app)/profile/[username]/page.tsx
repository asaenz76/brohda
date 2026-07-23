import { redirect, notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { resolvePublicProfile } from "@/lib/profiles/fetch";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { FollowButton } from "@/components/profile/FollowButton";
import { PredictionsTab } from "../predictions-tab";

// A visited profile's Predictions tab is scoped to settled (WON/LOST)
// picks only — never in-flight ACTIVE entries, which would leak "what did
// they pick on a still-open pool" and undermine participation_visibility's
// protections at the pool level.
export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username: identifier } = await params;
  const currentUser = await requireUser();
  const supabase = await createClient();

  const profile = await resolvePublicProfile(identifier);

  if (!profile) notFound();
  if (profile.id === currentUser.id) redirect("/profile");

  const [{ data: countsRows }, { data: isFollowing }, { data: pickCount }, { data: statsRows }] =
    await Promise.all([
      supabase.rpc("get_follow_counts", { p_user_id: profile.id }),
      supabase.rpc("is_following", { p_follower_id: currentUser.id, p_followee_id: profile.id }),
      supabase.rpc("get_pick_count", { p_user_id: profile.id }),
      supabase.rpc("get_profile_stats", { p_user_id: profile.id }),
    ]);

  const counts = Array.isArray(countsRows) ? countsRows[0] : countsRows;
  const stats = Array.isArray(statsRows) ? statsRows[0] : statsRows;

  return (
    <div className="space-y-6">
      <ProfileHeader
        displayName={profile.display_name}
        username={profile.username}
        pronouns={profile.pronouns}
        gender={profile.gender}
        bio={profile.bio}
        avatarUrl={profile.avatar_url}
        picksCount={pickCount ?? 0}
        followerCount={counts?.follower_count ?? 0}
        followingCount={counts?.following_count ?? 0}
        correctCount={stats?.correct_count ?? 0}
        totalCount={stats?.total_count ?? 0}
        currentStreak={stats?.current_streak ?? 0}
        profileHref={`/profile/${identifier}`}
        action={<FollowButton followeeId={profile.id} initiallyFollowing={Boolean(isFollowing)} />}
      />

      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Predictions</h2>
        <PredictionsTab
          userId={profile.id}
          statuses={["WON", "LOST"]}
          viewer={{ id: currentUser.id, isModerator: isAdminOrAbove(currentUser) }}
        />
      </div>
    </div>
  );
}
