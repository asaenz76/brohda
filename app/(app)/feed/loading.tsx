import { GamePostCardSkeleton } from "@/components/posts/GamePostCardSkeleton";
import { TrendingUp } from "lucide-react";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

// Next.js route-segment loading state: automatically wraps FeedPage in a
// Suspense boundary since it's a pure async Server Component. Mirrors the
// real page's header and card spacing so streaming in the real content
// doesn't shift the layout.
export default function FeedLoading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading feed">
      <ColumnHeader title="Upcoming games" icon={TrendingUp}>
        {/* Holds the tab row's height so the real tabs don't shift the page when they stream in. */}
        <div className="h-[43px] border-b border-border-subtle" aria-hidden="true" />
      </ColumnHeader>
      {Array.from({ length: 4 }).map((_, i) => (
        <GamePostCardSkeleton key={i} />
      ))}
    </div>
  );
}
