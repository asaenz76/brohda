import Link from "next/link";
import { ChevronRight } from "lucide-react";

// The single disclosure mechanism for everything that used to live in the
// card's permanent footer (entry fee/platform fee/min-entries text) — a
// plain link to the pool's own detail page rather than a second in-card
// accordion. Omit on the detail page itself (via SocialPoolCard's
// `isDetailPage`) so the card never links to the page it's already on.
export function PoolDetailsDisclosure({ poolId }: { poolId: string }) {
  return (
    <Link
      href={`/pool/${poolId}`}
      className="flex items-center gap-0.5 text-xs font-medium text-text-muted hover:text-text-secondary"
    >
      Pool details
      <ChevronRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}
