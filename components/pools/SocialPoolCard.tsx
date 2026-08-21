"use client";

import { useEffect, useState } from "react";
import { ChevronDown, MessageCircle } from "lucide-react";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import type { PoolLiveStats } from "@/lib/pools/fetch";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { getPoolLiveStatsAction } from "@/lib/actions/pools";
import { poolEntriesChannelName } from "@/lib/realtime/channel-names";
import { createClient } from "@/lib/supabase/client";
import { formatCents, formatBps } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PoolLeagueHeader } from "./PoolLeagueHeader";
import { MatchIdentity } from "./MatchIdentity";
import { RulePill } from "./RulePill";
import { PoolOptionButton } from "./PoolOptionButton";
import { PoolDistributionBar } from "./PoolDistributionBar";
import { AvatarStack } from "./AvatarStack";
import { LiveMatchStatus } from "./LiveMatchStatus";
import { PotentialPayoutFooter } from "./PotentialPayoutFooter";
import { PoolStatusNotice } from "./PoolStatusNotice";
import { EntryConfirmationSheet } from "./EntryConfirmationSheet";
import { TopUpAndJoinModal } from "./TopUpAndJoinModal";
import { SharePoolButton } from "./SharePoolButton";
import { LikeButton } from "./LikeButton";
import { CommentSheet } from "./CommentSheet";

export function SocialPoolCard({
  viewModel,
  balanceCents,
  paymentMethods,
  viewer,
  // Profile "Predictions" tab opts into this to save space (the list reads
  // like a second Feed otherwise) — Feed/pool-detail/fixture-detail leave
  // this unset and render exactly as before. Only the league/match header
  // stays visible while collapsed; a comment sheet or entry sheet already
  // open stays open regardless (those are excluded from the collapse gate
  // below), since the collapse toggle sits in that same persistent header.
  collapsible = false,
  // Every tier of this pool's fee-tier group (see TieredPoolCard), sorted
  // ascending by entryFee, including this card's own viewModel. Omitted
  // for an ordinary, non-tiered pool. When present (length > 1) a compact
  // fee dropdown renders inside the card, and the same list is threaded
  // into EntryConfirmationSheet so the amount can be changed from inside
  // the open sheet too, without switching cards first.
  siblingTiers,
  onTierChange,
}: {
  viewModel: SocialPoolCardViewModel;
  balanceCents: number;
  paymentMethods: PaymentMethodRow[];
  viewer: { id: string; isModerator: boolean };
  collapsible?: boolean;
  siblingTiers?: SocialPoolCardViewModel[];
  onTierChange?: (poolId: string) => void;
}) {
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentCount, setCommentCount] = useState(viewModel.commentCount);
  const [liveStats, setLiveStats] = useState<PoolLiveStats | null>(null);
  const [collapsed, setCollapsed] = useState(collapsible);

  // A fresh SSR-rendered viewModel (e.g. after the current user's own entry
  // triggers Next's post-action route refresh) must always win over a stale
  // broadcast-derived override — otherwise an old live update could keep
  // masking newer server data indefinitely. React's sanctioned pattern for
  // "reset state when a prop changes" is to compare during render (not in
  // an effect, which would cascade an extra render for no benefit).
  const ssrFingerprint = `${viewModel.totalEntries}:${viewModel.grossPool}`;
  const [lastSsrFingerprint, setLastSsrFingerprint] = useState(ssrFingerprint);
  if (ssrFingerprint !== lastSsrFingerprint) {
    setLastSsrFingerprint(ssrFingerprint);
    setLiveStats(null);
  }

  const isPreVote = viewModel.status === "OPEN_PRE_VOTE";
  const isPostVote = viewModel.status === "OPEN_POST_VOTE";
  const isLive = viewModel.status === "LIVE";
  const isLocked = viewModel.status === "LOCKED";
  // Distribution (the bar + per-option percentage/payout, already gated
  // upstream by can_view_pool_distribution) now defaults to visible before
  // entry too — engagement decision, matching Polymarket/Kalshi showing
  // live odds pre-trade rather than hiding them behind a pick.
  const showDistribution = isPreVote || isPostVote || isLive || isLocked;

  // Only worth subscribing while entries are still possible — total volume
  // (always visible, regardless of participation_visibility) and, once
  // distribution is visible to this viewer, per-option percentages/payouts
  // can all still change up until lock.
  const canReceiveLiveUpdates = isPreVote || isPostVote;

  useEffect(() => {
    if (!canReceiveLiveUpdates) return;

    let cancelled = false;
    const supabase = createClient();
    const channel = supabase.channel(poolEntriesChannelName(viewModel.poolId));

    channel
      .on("broadcast", { event: "entry_added" }, () => {
        getPoolLiveStatsAction(viewModel.poolId).then((stats) => {
          if (!cancelled && stats) setLiveStats(stats);
        });
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [viewModel.poolId, canReceiveLiveUpdates]);

  const mergedOptions = viewModel.options.map((option) => {
    const live = liveStats?.options[option.optionId];
    return {
      ...option,
      percentage: live?.percentage ?? option.percentage,
      estimatedPayout: live?.estimatedPayout ?? option.estimatedPayout,
    };
  });

  // Total money staked — unlike percentage/payout, never gated by
  // participation_visibility (get_pool_totals sums pool_options directly,
  // with no distribution-visibility check), so this renders before entry
  // too, mirroring Polymarket/Kalshi's "Vol. $X" convention.
  const mergedGrossPool = liveStats?.grossPool ?? viewModel.grossPool;

  const selectedOption = viewModel.options.find((o) => o.optionId === selectedOptionId);

  return (
    <article
      className={cn(
        "space-y-3.5 rounded-2xl border border-border-subtle bg-surface-primary p-5",
        // A pool that's just locked (not yet live/settled/voided — those
        // have their own status notices) reads as "no longer available"
        // rather than looking identical to an actively OPEN pool.
        isLocked && "opacity-70 grayscale-[0.4]",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <PoolLeagueHeader
            competitionName={viewModel.fixture.competitionName}
            competitionCountry={viewModel.fixture.competitionCountry}
            competitionLogoUrl={viewModel.fixture.competitionLogoUrl}
            poolType={viewModel.poolType}
            visibility={viewModel.visibility}
            createdAt={viewModel.postedAt}
            locksAt={viewModel.locksAt}
            isLocked={isLocked || isLive}
            isResolved={!isPreVote && !isPostVote && !isLocked && !isLive}
            hasEntered={viewModel.currentUser.hasEntered}
            leagueFollow={viewModel.fixture.leagueFollow}
          />
        </div>
        {collapsible && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Show pick details" : "Hide pick details"}
            aria-expanded={!collapsed}
            className="shrink-0 rounded-full p-1 text-text-muted hover:bg-surface-secondary"
          >
            <ChevronDown className={cn("size-5 transition-transform", !collapsed && "rotate-180")} />
          </button>
        )}
      </div>

      {siblingTiers && siblingTiers.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor={`tier-fee-${viewModel.poolId}`} className="text-xs font-medium text-text-secondary">
            Entry fee
          </label>
          <select
            id={`tier-fee-${viewModel.poolId}`}
            value={viewModel.poolId}
            onChange={(e) => onTierChange?.(e.target.value)}
            className="rounded-lg border border-border-subtle bg-surface-secondary px-2 py-1 text-xs font-semibold text-text-primary"
          >
            {siblingTiers.map((tier) => (
              <option key={tier.poolId} value={tier.poolId}>
                {formatCents(tier.entryFee)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* homeTeamName is the fetch-layer sentinel for "has a real fixture" —
          empty string only for CUSTOM pools' synthesized stand-in
          (lib/pools/fetch.ts). COMBO pools now can (and, via the template
          builder, always do) carry a real fixture too, so this is keyed on
          actually having fixture data, not on poolType — a COMBO prop tied
          to a match should show the same team badges + kickoff date/time
          as WHO_WILL_ADVANCE/REGULATION_RESULT, not just its title. */}
      {viewModel.fixture.homeTeamName && <MatchIdentity fixture={viewModel.fixture} />}

      {!collapsed && (
        <>
          {viewModel.title && (
            <p className="text-sm font-medium text-text-secondary">{viewModel.title}</p>
          )}

          {isLive && (
            <LiveMatchStatus
              homeTeamName={viewModel.fixture.homeTeamName}
              awayTeamName={viewModel.fixture.awayTeamName}
              homeScore={viewModel.fixture.homeScore}
              awayScore={viewModel.fixture.awayScore}
              elapsedMinutes={viewModel.fixture.elapsedMinutes}
            />
          )}

          {/* Community sentiment leads — the aggregate social signal, ahead
              of who specifically is in the pool and ahead of the pick
              itself. */}
          {showDistribution && <PoolDistributionBar options={mergedOptions} />}

          {/* Social proof-of-life next — "who else is in this" — but kept
              modest (not the same visual weight as the question/options
              below it) since it's context, not the main content of the
              card. */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <AvatarStack
                participants={viewModel.socialProof.visibleParticipants}
                totalCount={viewModel.socialProof.participantCount}
              />
              <span className="text-xs font-medium text-text-secondary">
                {formatCents(mergedGrossPool)} volume
              </span>
            </div>
            <div className="flex items-center gap-0.5 text-text-secondary">
              <LikeButton
                poolId={viewModel.poolId}
                initiallyLiked={viewModel.isLikedByCurrentUser}
                initialCount={viewModel.likeCount}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCommentsOpen(true)}
                aria-label="Comments"
                className="px-1.5 text-text-muted"
              >
                <MessageCircle className="size-5" aria-hidden="true" />
                {commentCount > 0 && <span className="text-xs font-medium">{commentCount}</span>}
              </Button>
              <SharePoolButton poolId={viewModel.poolId} question={viewModel.question} />
            </div>
          </div>

          <div>
            <h3 className="text-lg font-bold text-text-primary">{viewModel.question}</h3>
            <div className="mt-1.5">
              <RulePill label={viewModel.ruleLabel} />
            </div>
          </div>

          {/* Read-only context for what Yes/No actually grades against —
              never itself selectable, only the two options below take
              entries. */}
          {viewModel.comboLegs && viewModel.comboLegs.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-border-subtle bg-surface-secondary px-3 py-2">
              {viewModel.comboLegs.map((leg) => (
                <li key={leg.id} className="flex items-center gap-2 text-sm text-text-secondary">
                  <span className="size-1.5 shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
                  {leg.label}
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-2">
            {mergedOptions.map((option) => (
              <PoolOptionButton
                key={option.optionId}
                label={option.label}
                logoUrl={option.teamLogoUrl}
                percentage={option.percentage}
                estimatedPayout={option.estimatedPayout}
                isCurrentUserChoice={option.isCurrentUserChoice}
                // Admins/super_admins coordinate pools, they don't play in
                // them — create_pool_entry rejects this server-side too, but
                // hiding the affordance here avoids a pointless round trip.
                disabled={!isPreVote || viewer.isModerator}
                onSelect={() => isPreVote && !viewer.isModerator && setSelectedOptionId(option.optionId)}
              />
            ))}
          </div>

          <PoolStatusNotice notice={viewModel.notice} />

          {showDistribution && <PotentialPayoutFooter />}

          <p className="text-xs text-text-muted">
            Entry {formatCents(viewModel.entryFee)} · Platform Fee{" "}
            {formatBps(viewModel.houseFeeBasisPoints)}
            {(isPreVote || isPostVote) && (
              <>
                {" · Requires "}
                {viewModel.minTotalEntries}+ entries to run
              </>
            )}
          </p>
        </>
      )}

      {selectedOption &&
        (balanceCents < viewModel.entryFee ? (
          <TopUpAndJoinModal
            poolId={viewModel.poolId}
            optionId={selectedOption.optionId}
            optionLabel={selectedOption.label}
            entryFee={viewModel.entryFee}
            balanceCents={balanceCents}
            paymentMethods={paymentMethods}
            onClose={() => setSelectedOptionId(null)}
          />
        ) : (
          <EntryConfirmationSheet
            poolId={viewModel.poolId}
            optionId={selectedOption.optionId}
            optionLabel={selectedOption.label}
            ruleLabel={viewModel.ruleLabel}
            entryFee={viewModel.entryFee}
            houseFeeBasisPoints={viewModel.houseFeeBasisPoints}
            balanceCents={balanceCents}
            locksAt={viewModel.locksAt}
            tiers={siblingTiers?.map((tier) => ({
              poolId: tier.poolId,
              entryFee: tier.entryFee,
              options: tier.options.map((o) => ({ optionId: o.optionId, label: o.label })),
            }))}
            onClose={() => setSelectedOptionId(null)}
            onSuccess={() => setSelectedOptionId(null)}
          />
        ))}

      {commentsOpen && (
        <CommentSheet
          poolId={viewModel.poolId}
          viewer={viewer}
          onClose={() => setCommentsOpen(false)}
          onCountChange={setCommentCount}
        />
      )}
    </article>
  );
}
