import { PoolCardSkeleton } from "@/components/pools/PoolCardSkeleton";

// Next.js route-segment loading state: automatically wraps FeedPage in a
// Suspense boundary since it's a pure async Server Component. Mirrors the
// real page's spacing/filter-bar shape so streaming in the real content
// doesn't shift the layout.
export default function FeedLoading() {
  return (
    <div className="space-y-[18px] sm:space-y-[22px]" aria-busy="true" aria-label="Loading feed">
      <h1 className="sr-only">Feed</h1>
      <div className="flex gap-2">
        <div className="h-8 w-28 animate-pulse rounded-lg bg-surface-elevated" />
        <div className="h-8 w-28 animate-pulse rounded-lg bg-surface-elevated" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <PoolCardSkeleton key={i} />
      ))}
    </div>
  );
}
