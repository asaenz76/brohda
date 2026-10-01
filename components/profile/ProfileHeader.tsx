import { UserIdentity } from "@/components/identity/UserIdentity";
import type { UserIdentityReputation } from "@/components/identity/UserIdentity";
import { ProfileStatsRow } from "./ProfileStatsRow";

/**
 * Phase F (Brohda 2.0 redesign) — the Profile header as a social identity
 * header (spec §7, §40): identity (avatar/name/handle/reputation, via the
 * Phase B UserIdentity primitive — finally wired in here, its first real
 * consumer) → bio/pronouns/gender metadata → follow/edit action → social
 * (follower/following) stats. Shared by the own-profile page and the
 * public /profile/[username] page — only the action slot differs (an Edit
 * profile link for yourself, a FollowButton for anyone else).
 *
 * Dropped from the old header: `correctCount`/`totalCount`/`currentStreak`
 * (ProfileStatBadges) and the `picksCount` stat. Those came from
 * `get_profile_stats`/`get_pick_count`, both of which read legacy Pool
 * data (`user_profiles.correct_predictions_count`, `entries`,
 * deprecated streak columns per lib/predictions/streak.ts's own comment)
 * — a second, inconsistent reputation source existing alongside the real
 * canonical one (lib/reputation/*). Phase F standardizes on exactly one:
 * the `reputation` prop below, sourced from getUserPredictionRecord,
 * formatted by UserIdentity's own locked formatter (never a second ad hoc
 * accuracy string).
 *
 * pronouns/gender arrive already nulled per-viewer by public_profiles when
 * this is someone else's profile (never nulled for your own — page.tsx
 * reads those directly off user_profiles).
 */
export function ProfileHeader({
  displayName,
  username,
  pronouns,
  gender,
  bio,
  avatarUrl,
  reputation,
  followerCount,
  followingCount,
  profileHref,
  action,
}: {
  displayName: string;
  username?: string | null;
  pronouns?: string | null;
  gender?: string | null;
  bio?: string | null;
  avatarUrl: string | null;
  reputation: UserIdentityReputation | null;
  followerCount: number;
  followingCount: number;
  profileHref: string;
  action?: React.ReactNode;
}) {
  const metaLine = [pronouns, gender].filter(Boolean).join(" · ");

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <UserIdentity displayName={displayName} username={username ?? null} avatarUrl={avatarUrl} reputation={reputation} size="lg" />
        {action}
      </div>
      {metaLine && <p className="text-sm text-text-secondary">{metaLine}</p>}
      {bio && <p className="text-sm text-text-primary">{bio}</p>}
      <ProfileStatsRow followerCount={followerCount} followingCount={followingCount} profileHref={profileHref} />
    </div>
  );
}
