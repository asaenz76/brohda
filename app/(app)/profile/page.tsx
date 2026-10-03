import Link from "next/link";
import { User } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getUserPredictionRecord } from "@/lib/reputation/repository";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { ProfileTabNav, type ProfileTab } from "./profile-tab-nav";
import { PredictionsHistory } from "./predictions-history";
import { CommunitiesTab } from "./communities-tab";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

/**
 * Own Profile (Phase F, Brohda 2.0 redesign) — a social identity, not a
 * dashboard/analytics product/leaderboard/Pool-history page/settings hub
 * (spec §0). Header → two tabs (Predictions, Communities) → that's the
 * whole page. Down from the old six-item tab row (Predictions / Market
 * Predictions / Teams & Leagues / Edit profile / Analytics / Rules):
 * - "Predictions" (legacy Pool `entries`) — REMOVED (spec §10), no
 *   replacement archive; Pool backend/schema untouched.
 * - "Market Predictions" — kept, renamed "Predictions", reframed as the
 *   canonical Brohda 2.0 history (predictions-history.tsx).
 * - "Teams & Leagues" — REMOVED; it was legacy Pool team/league
 *   notification preferences (`team_follows`/`league_follows`), NOT
 *   Phase D/E Community follows, despite the similar name — replaced by a
 *   genuinely new "Communities" tab over the real `community_follows`
 *   domain (communities-tab.tsx).
 * - "Edit profile" — moved to a header action button, see below.
 * - "Analytics"/"Rules" — REMOVED entirely, per spec §17-18 (routes
 *   untouched, just no longer linked from Profile).
 */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const supabase = await createClient();
  const { tab: tabParam } = await searchParams;
  const tab: ProfileTab = tabParam === "communities" ? "communities" : "predictions";

  const [{ data: countsRows }, { data: editableFields }, reputation] = await Promise.all([
    supabase.rpc("get_follow_counts", { p_user_id: user.id }),
    // Not part of the shared session UserProfile type (kept narrow for
    // guards/middleware) — fetched separately for this page's header/edit form.
    supabase
      .from("user_profiles")
      .select("pronouns, gender, bio, show_pronouns, show_gender, show_bio")
      .eq("id", user.id)
      .single(),
    getUserPredictionRecord(user.id),
  ]);

  const counts = Array.isArray(countsRows) ? countsRows[0] : countsRows;
  const profileHref = `/profile/${user.username ?? user.id}`;

  return (
    <div className="space-y-4">
      <ColumnHeader title="Profile" icon={User} />
      <ProfileHeader
        displayName={user.display_name}
        username={user.username}
        pronouns={editableFields?.pronouns ?? null}
        gender={editableFields?.gender ?? null}
        bio={editableFields?.bio ?? null}
        avatarUrl={user.avatar_url}
        reputation={reputation}
        followerCount={counts?.follower_count ?? 0}
        followingCount={counts?.following_count ?? 0}
        profileHref={profileHref}
        action={
          <Link href="/profile/edit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Edit profile
          </Link>
        }
      />

      <ProfileTabNav active={tab} basePath="/profile" />

      {tab === "predictions" ? <PredictionsHistory userId={user.id} /> : <CommunitiesTab profileUserId={user.id} viewerId={user.id} />}
    </div>
  );
}
