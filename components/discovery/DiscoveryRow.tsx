import Link from "next/link";
import { CommunityMark } from "@/components/identity/CommunityMark";
import { CommunityFollowButton } from "@/components/communities/CommunityFollowButton";
import type { CommunityListItem } from "@/lib/communities/discovery";

// Phase D (Brohda 2.0 redesign) — one compact Discovery row: crest/icon,
// name, follow state. Deliberately NOT lib/identity/TeamIdentity's
// CommunityIdentity (which always repeats the Sport/League/Team type
// label inline) — Discovery's own tab context already establishes the
// type unambiguously, so repeating it on every single row would be exactly
// the "metadata-heavy" noise spec §20 warns against. Restrained by design
// (spec §15): no follower-count vanity metric, no reputation/leaderboard
// treatment — just identity + affinity.
export function DiscoveryRow({ item }: { item: CommunityListItem }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <Link href={`/community/${item.slug}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <CommunityMark logoUrl={item.logoUrl} name={item.displayName} sportKey={item.sportKey} className="size-8" />
        <span className="min-w-0 truncate text-sm font-medium text-text-primary">{item.displayName}</span>
      </Link>
      <CommunityFollowButton communityId={item.id} initiallyFollowing={item.isFollowing} />
    </li>
  );
}
