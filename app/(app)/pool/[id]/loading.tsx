import { PoolCardSkeleton } from "@/components/pools/PoolCardSkeleton";

// Next.js route-segment loading state: PoolDetailPage is a pure async
// Server Component, so this file streams in automatically while the pool
// and wallet queries resolve.
export default function PoolDetailLoading() {
  return (
    <div aria-busy="true" aria-label="Loading pool">
      <PoolCardSkeleton />
    </div>
  );
}
