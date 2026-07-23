import Link from "next/link";

// Instagram-style "Posts / Followers / Following" row, renamed to fit a
// prediction app — Picks isn't a link (there's nowhere else to send you,
// the picks are already right below on both profile pages), Followers/
// Following each link to their own list page.
export function ProfileStatsRow({
  picksCount,
  followerCount,
  followingCount,
  profileHref,
}: {
  picksCount: number;
  followerCount: number;
  followingCount: number;
  profileHref: string;
}) {
  return (
    <div className="flex items-center gap-6 text-sm text-text-secondary">
      <div className="flex flex-col items-center">
        <span className="text-base font-bold text-text-primary">{picksCount}</span>
        <span>picks</span>
      </div>
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
