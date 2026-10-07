import Link from "next/link";
import { CommunityMark } from "@/components/identity/CommunityMark";
import type { CommunityListItem } from "@/lib/communities/discovery";

// The logged-out twin of DiscoveryRow: the same crest + name row, without
// the follow control (following is an account action). The link goes to
// the real Community page, which asks a visitor to log in.
export function PublicCommunityRow({ item }: { item: CommunityListItem }) {
  return (
    <li>
      <Link
        href={`/community/${item.slug}`}
        className="flex min-w-0 items-center gap-3 px-4 py-3 outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <CommunityMark logoUrl={item.logoUrl} name={item.displayName} sportKey={item.sportKey} className="size-8" />
        <span className="min-w-0 truncate text-sm font-medium text-text-primary">{item.displayName}</span>
      </Link>
    </li>
  );
}
