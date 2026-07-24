import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { AvatarUploader } from "./avatar-uploader";
import { ProfileForm } from "./profile-form";
import { ChangePasswordForm } from "./change-password-form";
import { PredictionsTab } from "./predictions-tab";
import { ProfileTabs } from "./profile-tabs";
import { CloseAccountForm } from "./close-account-form";

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; required?: string }>;
}) {
  const user = await requireUser();
  const { required } = await searchParams;
  const supabase = await createClient();

  const [{ data: countsRows }, { data: pickCount }, { data: editableFields }, { data: statsRows }] =
    await Promise.all([
      supabase.rpc("get_follow_counts", { p_user_id: user.id }),
      supabase.rpc("get_pick_count", { p_user_id: user.id }),
      // Not part of the shared session UserProfile type (kept narrow for
      // guards/middleware) — fetched separately for this page's edit form.
      supabase
        .from("user_profiles")
        .select("pronouns, gender, bio, show_pronouns, show_gender, show_bio")
        .eq("id", user.id)
        .single(),
      supabase.rpc("get_profile_stats", { p_user_id: user.id }),
    ]);

  const counts = Array.isArray(countsRows) ? countsRows[0] : countsRows;
  const stats = Array.isArray(statsRows) ? statsRows[0] : statsRows;

  return (
    <div className="space-y-6">
      {required === "1" && !user.username && (
        <p role="alert" className="rounded-lg bg-surface-secondary p-3 text-sm text-text-secondary">
          Please choose a username to continue.
        </p>
      )}

      <ProfileHeader
        displayName={user.display_name}
        username={user.username}
        pronouns={editableFields?.pronouns ?? null}
        gender={editableFields?.gender ?? null}
        bio={editableFields?.bio ?? null}
        avatarUrl={user.avatar_url}
        picksCount={pickCount ?? 0}
        followerCount={counts?.follower_count ?? 0}
        followingCount={counts?.following_count ?? 0}
        correctCount={stats?.correct_count ?? 0}
        totalCount={stats?.total_count ?? 0}
        currentStreak={stats?.current_streak ?? 0}
        profileHref={`/profile/${user.username ?? user.id}`}
      />

      <ProfileTabs
        predictions={
          <PredictionsTab
            userId={user.id}
            viewer={{ id: user.id, isModerator: isAdminOrAbove(user) }}
          />
        }
        edit={
          <div className="space-y-6">
            <Card>
              <CardContent className="pt-6">
                <AvatarUploader displayName={user.display_name} avatarUrl={user.avatar_url} />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <ProfileForm
                  key={`${user.display_name}-${user.username}-${editableFields?.bio}`}
                  displayName={user.display_name}
                  username={user.username}
                  pronouns={editableFields?.pronouns ?? null}
                  gender={editableFields?.gender ?? null}
                  bio={editableFields?.bio ?? null}
                  showPronouns={editableFields?.show_pronouns ?? true}
                  showGender={editableFields?.show_gender ?? true}
                  showBio={editableFields?.show_bio ?? true}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <ChangePasswordForm />
              </CardContent>
            </Card>

            <CloseAccountForm />
          </div>
        }
      />
    </div>
  );
}
