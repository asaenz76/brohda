import Link from "next/link";
import { getCommunityTypeLabel } from "@/lib/communities/presentation";
import type { FeedCommunityRef } from "@/lib/communities/feed";

// Stage 4A remediation (Stage 4 audit §11): compact Community context on
// the Post detail page — links to the existing canonical Community pages,
// never implies any one Community "owns" the Post (a Post can belong to
// several), and never duplicates the Post itself.

export function PostCommunityBadges({ communities }: { communities: FeedCommunityRef[] }) {
  if (communities.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {communities.map((c) => (
        <Link
          key={c.id}
          href={`/community/${c.slug}`}
          className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-text-secondary transition hover:border-accent-primary/50 hover:text-accent-primary"
        >
          {c.displayName}
          <span className="sr-only"> ({getCommunityTypeLabel(c.type)})</span>
        </Link>
      ))}
    </div>
  );
}
