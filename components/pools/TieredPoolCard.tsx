"use client";

import { useState } from "react";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { formatCents } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { SocialPoolCard } from "./SocialPoolCard";

/**
 * Thin wrapper around SocialPoolCard for a fee-tier group (same
 * matchup+question offered at several entry fees — see the
 * 20260101000122 migration and createPoolTierGroupAction). Every piece of
 * SocialPoolCard's interactive state (selectedOptionId, the realtime
 * channel subscription, live stats, comments/likes) is keyed off
 * viewModel.poolId alone, so switching tiers renders a *different* pool id
 * entirely via the `key` prop — React fully remounts the card, giving
 * fresh state for free with zero changes to SocialPoolCard itself (it
 * already leans on this same reset-on-prop-change idiom internally, see
 * its own ssrFingerprint comparison).
 *
 * Known, deliberate limitation: comments and likes are per-pool_id, so
 * switching tiers switches to a genuinely different comment thread and
 * like count (separate pools rows). Sharing a conversation across tiers
 * would need CommentSheet/LikeButton/SharePoolButton to accept a
 * "canonical" pool id instead — out of scope for now.
 */
export function TieredPoolCard({
  tiers,
  balanceCents,
  paymentMethods,
  viewer,
  collapsible = false,
}: {
  /** Every tier of the group, pre-sorted ascending by entry fee. A single-
   *  element array (the common case — an ordinary, non-tiered pool)
   *  renders SocialPoolCard directly with no selector. */
  tiers: SocialPoolCardViewModel[];
  balanceCents: number;
  paymentMethods: PaymentMethodRow[];
  viewer: { id: string; isModerator: boolean };
  collapsible?: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = tiers[selectedIndex] ?? tiers[0];

  if (tiers.length <= 1) {
    return (
      <SocialPoolCard
        viewModel={selected}
        balanceCents={balanceCents}
        paymentMethods={paymentMethods}
        viewer={viewer}
        collapsible={collapsible}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 px-1" role="tablist" aria-label="Entry fee">
        {tiers.map((tier, index) => (
          <button
            key={tier.poolId}
            type="button"
            role="tab"
            aria-selected={index === selectedIndex}
            onClick={() => setSelectedIndex(index)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              index === selectedIndex
                ? "bg-accent-primary text-white"
                : "bg-surface-secondary text-text-secondary hover:text-text-primary",
            )}
          >
            {formatCents(tier.entryFee)}
          </button>
        ))}
      </div>
      <SocialPoolCard
        key={selected.poolId}
        viewModel={selected}
        balanceCents={balanceCents}
        paymentMethods={paymentMethods}
        viewer={viewer}
        collapsible={collapsible}
      />
    </div>
  );
}
