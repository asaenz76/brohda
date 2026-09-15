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
 * 20260101000122 migration and createPoolTierGroupAction). The tier picker
 * sits in this wrapper's own header, above and visually separate from
 * SocialPoolCard's bordered card — the prediction choice inside the card
 * stays the only thing competing for attention there, per the approved
 * interaction hierarchy ("place fee tier within the post-selection entry
 * flow whenever possible rather than competing visually with the
 * prediction choices"). Deliberately plain text, not a pill/tab control —
 * a solid-fill selected pill here would read as a second "choice" next to
 * PoolChoiceButton's own solid-fill selected state, recreating exactly the
 * sportsbook-stake-selector look this redesign removed. Picking a tier here
 * fully remounts the card (via
 * `key`), giving fresh state (realtime channel, comments, likes) for free
 * with zero changes to SocialPoolCard's own hooks (it already leans on this
 * same reset-on-prop-change idiom internally, see its own ssrFingerprint
 * comparison). Switching tiers from *inside* an already-open entry sheet
 * (to change the amount without going back) doesn't remount — see
 * EntryConfirmationSheet's own `tiers` prop instead.
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
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1 text-xs" role="tablist" aria-label="Entry fee">
        <span className="text-text-muted">Entry:</span>
        {tiers.map((tier, i) => (
          <button
            key={tier.poolId}
            type="button"
            role="tab"
            aria-selected={i === selectedIndex}
            onClick={() => setSelectedIndex(i)}
            className={cn(
              "rounded px-1 py-0.5 font-medium transition-colors",
              i === selectedIndex
                ? "text-text-primary underline decoration-2 underline-offset-4"
                : "text-text-muted hover:text-text-secondary",
            )}
          >
            {/* Tier groups are exclusively a PAID concept — a FREE pool's
                tier_group_id is constraint-enforced null, so tier.entryFee
                is always present here. */}
            {formatCents(tier.entryFee!)}
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
        siblingTiers={tiers}
      />
    </div>
  );
}
