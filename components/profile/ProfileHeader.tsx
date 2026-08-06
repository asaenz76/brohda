import { Avatar } from "@/components/Avatar";
import { ProfileStatsRow } from "./ProfileStatsRow";
import { ProfileStatBadges } from "./ProfileStatBadges";

// Shared by the own-profile page and the public /profile/[username] page —
// the avatar/name/stats layout is identical, only what renders in the
// action slot differs (nothing for yourself, a FollowButton for anyone
// else). pronouns/gender arrive already nulled per-viewer by
// public_profiles when this is someone else's profile (never nulled for
// your own — page.tsx reads those directly off user_profiles).
export function ProfileHeader({
  displayName,
  username,
  pronouns,
  gender,
  bio,
  avatarUrl,
  picksCount,
  followerCount,
  followingCount,
  correctCount,
  totalCount,
  currentStreak,
  profileHref,
  action,
}: {
  displayName: string;
  username?: string | null;
  pronouns?: string | null;
  gender?: string | null;
  bio?: string | null;
  avatarUrl: string | null;
  picksCount: number;
  followerCount: number;
  followingCount: number;
  correctCount: number;
  totalCount: number;
  currentStreak: number;
  profileHref: string;
  action?: React.ReactNode;
}) {
  const identityLine = [username ? `@${username}` : null, pronouns, gender]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Avatar displayName={displayName} avatarUrl={avatarUrl} size="xl" />
        <div className="flex-1 space-y-1">
          <p className="text-lg font-bold text-text-primary">{displayName}</p>
          {identityLine && <p className="text-sm text-text-secondary">{identityLine}</p>}
        </div>
        {action}
      </div>
      {bio && <p className="text-sm text-text-primary">{bio}</p>}
      <ProfileStatBadges correctCount={correctCount} totalCount={totalCount} currentStreak={currentStreak} />
      <ProfileStatsRow
        picksCount={picksCount}
        followerCount={followerCount}
        followingCount={followingCount}
        profileHref={profileHref}
      />
    </div>
  );
}
