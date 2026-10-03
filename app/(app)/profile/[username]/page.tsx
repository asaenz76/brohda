import { redirect, notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { resolvePublicProfile } from "@/lib/profiles/fetch";
import { getUserPredictionRecord } from "@/lib/reputation/repository";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { FollowButton } from "@/components/profile/FollowButton";
import { ProfileTabNav, type ProfileTab } from "../profile-tab-nav";
import { PredictionsHistory } from "../predictions-history";
import { CommunitiesTab } from "../communities-tab";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

/**
 * Public Profile (Phase F, Brohda 2.0 redesign) — the same identity
 * header and the same two tabs (Predictions, Communities) as your own
 * profile, so visiting someone else never feels like a different product
 * (spec §8). Two deliberate differences from the own-profile page:
 *
 * 1. Predictions is `gradedOnly` — a visited profile never shows an
 *    in-flight Pick, the same privacy posture the legacy Pool Predictions
 *    tab already established (settled results only), carried over rather
 *    than invented fresh for this new surface.
 * 2. The action slot is a FollowButton, not an Edit-profile link — no
 *    Edit profile, no Analytics/Rules (those never existed on the public
 *    profile either, before or after this redesign).
 */
export default async function PublicProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { username: identifier } = await params;
  const currentUser = await requireUser();
  const supabase = await createClient();
  const { tab: tabParam } = await searchParams;
  const tab: ProfileTab = tabParam === "communities" ? "communities" : "predictions";

  const profile = await resolvePublicProfile(identifier);

  if (!profile) notFound();
  if (profile.id === currentUser.id) redirect("/profile");

  const [{ data: countsRows }, { data: isFollowing }, reputation] = await Promise.all([
    supabase.rpc("get_follow_counts", { p_user_id: profile.id }),
    supabase.rpc("is_following", { p_follower_id: currentUser.id, p_followee_id: profile.id }),
    getUserPredictionRecord(profile.id),
  ]);

  const counts = Array.isArray(countsRows) ? countsRows[0] : countsRows;

  return (
    <div className="space-y-4">
      <ColumnHeader title="Profile" backHref="/feed" backLabel="Back to Home" />
      <ProfileHeader
        displayName={profile.display_name}
        username={profile.username}
        pronouns={profile.pronouns}
        gender={profile.gender}
        bio={profile.bio}
        avatarUrl={profile.avatar_url}
        reputation={reputation}
        followerCount={counts?.follower_count ?? 0}
        followingCount={counts?.following_count ?? 0}
        profileHref={`/profile/${identifier}`}
        action={<FollowButton followeeId={profile.id} initiallyFollowing={Boolean(isFollowing)} />}
      />

      <ProfileTabNav active={tab} basePath={`/profile/${identifier}`} />

      {tab === "predictions" ? (
        <PredictionsHistory userId={profile.id} gradedOnly />
      ) : (
        <CommunitiesTab profileUserId={profile.id} viewerId={currentUser.id} />
      )}
    </div>
  );
}
