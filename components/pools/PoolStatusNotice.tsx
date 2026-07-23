import { cn } from "@/lib/utils";
import type { Notice } from "@/lib/pools/notices";

// All copy is precomputed server-side by lib/pools/notices.ts (spec
// X.5.12/X.7.6-11/X.5.14/READY_FOR_REVIEW) — this component just renders it.
// X.10's "heavier motion polish" is scoped to exactly this one celebratory
// pop on a win, nothing broader; the global prefers-reduced-motion rule in
// globals.css already neutralizes the animation for anyone who's opted out.
export function PoolStatusNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;

  const isWon = notice.type === "SETTLED_WON";
  const isLost = notice.type === "SETTLED_LOST";

  return (
    <p
      className={cn(
        "rounded-lg bg-surface-secondary px-3 py-2 text-sm text-text-secondary",
        // Pool win/loss get their own dedicated color, distinct from
        // credit/debit (wallet ledger direction) — "you won this pool" isn't
        // the same concept as "money was added to your wallet", even though
        // one causes the other. Only the win gets the celebratory pop; a
        // loss should read as neutral-negative, not draw extra attention.
        isWon && "bg-pool-win/10 text-pool-win font-medium animate-[celebrate-pop_0.4s_ease-out]",
        isLost && "bg-pool-loss/10 text-pool-loss font-medium",
      )}
    >
      {notice.message}
    </p>
  );
}
