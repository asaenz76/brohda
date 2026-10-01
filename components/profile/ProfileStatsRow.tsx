import Link from "next/link";

// Instagram-style "Followers / Following" row. Phase F (Brohda 2.0
// redesign) dropped the third "picks" stat this row used to show first —
// that number came from get_pick_count, which counts legacy Pool
// `entries`, not anything in the canonical Brohda 2.0 domain (predictions
// or reputation); it's gone from Profile now, not relabeled or replaced,
// per the same "no Pool stats on the redesigned Profile" rule as the
// removed legacy tabs. Real prediction counts live in the reputation line
// (UserIdentity's own "N predicted") instead — spec §21 keeps follower
// counts and prediction reputation as two distinct, never-conflated
// numbers, which is exactly what keeping this row separate preserves.
export function ProfileStatsRow({
  followerCount,
  followingCount,
  profileHref,
}: {
  followerCount: number;
  followingCount: number;
  profileHref: string;
}) {
  return (
    <div className="flex items-center gap-6 text-sm text-text-secondary">
      <Link href={`${profileHref}/followers`} className="flex flex-col items-center">
        <span className="text-base font-bold text-text-primary">{followerCount}</span>
        <span>followers</span>
      </Link>
      <Link href={`${profileHref}/following`} className="flex flex-col items-center">
        <span className="text-base font-bold text-text-primary">{followingCount}</span>
        <span>following</span>
      </Link>
    </div>
  );
}
