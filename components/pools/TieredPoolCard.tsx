"use client";

import { useState } from "react";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { SocialPoolCard } from "./SocialPoolCard";

/**
 * Thin wrapper around SocialPoolCard for a fee-tier group (same
 * matchup+question offered at several entry fees — see the
 * 20260101000122 migration and createPoolTierGroupAction). The fee
 * dropdown itself lives inside SocialPoolCard's own bordered card (passed
 * down as `siblingTiers`); picking a different tier there switches which
 * pool id is rendered via the `key` prop — React fully remounts the card,
 * giving fresh state (realtime channel, comments, likes) for free with
 * zero changes to SocialPoolCard's own hooks (it already leans on this
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
    <SocialPoolCard
      key={selected.poolId}
      viewModel={selected}
      balanceCents={balanceCents}
      paymentMethods={paymentMethods}
      viewer={viewer}
      collapsible={collapsible}
      siblingTiers={tiers}
      onTierChange={(poolId) => {
        const index = tiers.findIndex((t) => t.poolId === poolId);
        if (index >= 0) setSelectedIndex(index);
      }}
    />
  );
}
