"use client";

import { useEffect, useState } from "react";
import { ChevronDown, MessageCircle } from "lucide-react";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import type { PoolLiveStats } from "@/lib/pools/fetch";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { getPoolLiveStatsAction } from "@/lib/actions/pools";
import { poolEntriesChannelName } from "@/lib/realtime/channel-names";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LeagueIdentity } from "./LeagueIdentity";
import { PoolStatus } from "./PoolStatus";
import { PoolMetadata } from "./PoolMetadata";
import { MatchIdentity } from "./MatchIdentity";
import { PoolQuestion } from "./PoolQuestion";
import { PoolChoiceButton } from "./PoolChoiceButton";
import { CommunitySplit } from "./CommunitySplit";
import { PoolResult } from "./PoolResult";
import { PoolDetailsDisclosure } from "./PoolDetailsDisclosure";
import { PoolSummary } from "./PoolSummary";
import { LiveMatchStatus } from "./LiveMatchStatus";
import { PoolStatusNotice } from "./PoolStatusNotice";
import { EntryConfirmationSheet } from "./EntryConfirmationSheet";
import { FreeEntryConfirmationSheet } from "./FreeEntryConfirmationSheet";
import { TopUpAndJoinModal } from "./TopUpAndJoinModal";
import { requiresPayment } from "@/lib/pools/capabilities";
import { SharePoolButton } from "./SharePoolButton";
import { LikeButton } from "./LikeButton";
import { CommentSheet } from "./CommentSheet";

// Terminal states with nothing left to decide — CommunitySplit and the
// choice buttons (the "open pool" interface) are hidden entirely, not
// merely disabled, so these states stay genuinely simpler than OPEN rather
// than gradually re-accumulating the full interface with everything
// grayed out. SETTLED_WON/SETTLED_LOST additionally swap in PoolResult
// (final score + pick + outcome) in place of MatchIdentity.
const SIMPLIFIED_STATES: ReadonlySet<SocialPoolCardViewModel["status"]> = new Set([
  "SETTLED_WON",
  "SETTLED_LOST",
  "VOIDED",
  "POSTPONED_NOTICE",
  "CANCELLED_NOTICE",
  "SUSPENDED_NOTICE",
]);

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
  // True only when this card is already rendered on its own /pool/[id]
  // detail page — suppresses the "Pool details ›" link so the card never
  // links to the page it's already on, and reveals the administrative
  // metadata (visibility, posted time) that a feed/list card never shows.
  isDetailPage = false,
  // Every tier of this pool's fee-tier group (see TieredPoolCard), sorted
  // ascending by entryFee, including this card's own viewModel. Omitted
  // for an ordinary, non-tiered pool. The fee-tier picker itself now lives
  // entirely inside EntryConfirmationSheet (post-selection) — the
  // prediction choice stays the card's only pre-selection action, per the
  // approved interaction hierarchy.
  siblingTiers,
}: {
  viewModel: SocialPoolCardViewModel;
  balanceCents: number;
  paymentMethods: PaymentMethodRow[];
  viewer: { id: string; isModerator: boolean };
  collapsible?: boolean;
  isDetailPage?: boolean;
  siblingTiers?: SocialPoolCardViewModel[];
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
  const isResolved = !isPreVote && !isPostVote && !isLocked && !isLive;
  const isSimplified = SIMPLIFIED_STATES.has(viewModel.status);
  const isSettled = viewModel.status === "SETTLED_WON" || viewModel.status === "SETTLED_LOST";
  // Distribution (the split bar + per-option percentage, already gated
  // upstream by can_view_pool_distribution) defaults to visible before
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

  const selectedOption = mergedOptions.find((o) => o.optionId === selectedOptionId);

  return (
    <article
      className={cn(
        // Generous geometry, matching the approved mockup — this card is
        // deliberately larger and more spacious than the old dense
        // dashboard-style card. The prediction is the point; whitespace
        // around it is not wasted space. Bolder border + a hard offset
        // shadow for the graphic "pop" of the Common Ninja reference —
        // drawn from text-primary (near-black in light mode, near-white
        // in dark) rather than literal black, so it stays high-contrast
        // in both themes instead of vanishing against the dark one.
        "space-y-6 rounded-[24px] border-2 border-text-primary bg-surface-primary p-7 shadow-[6px_6px_0_0_var(--text-primary)] sm:p-8",
        // A pool that's just locked (not yet live/settled/voided — those
        // have their own status notices) reads as "no longer available"
        // rather than looking identical to an actively OPEN pool.
        isLocked && "opacity-70 grayscale-[0.4]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <LeagueIdentity
          competitionName={viewModel.fixture.competitionName}
          competitionCountry={viewModel.fixture.competitionCountry}
          competitionLogoUrl={viewModel.fixture.competitionLogoUrl}
          poolType={viewModel.poolType}
          leagueFollow={viewModel.fixture.leagueFollow}
        />
        <div className="flex shrink-0 items-center gap-1">
          <PoolStatus status={viewModel.status} />
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
      </div>

      {isDetailPage && <PoolMetadata visibility={viewModel.visibility} createdAt={viewModel.postedAt} />}

      {!collapsed && (
        <>
          {isSettled ? (
            <PoolResult viewModel={viewModel} />
          ) : (
            <>
              {/* Question leads — matches the approved mockup's hierarchy
                  (question, then fixture context), not the other way
                  around. */}
              <PoolQuestion question={viewModel.question} ruleLabel={viewModel.ruleLabel} />

              {viewModel.title && (
                <p className="text-center text-sm font-medium text-text-secondary">{viewModel.title}</p>
              )}

              {/* homeTeamName is the fetch-layer sentinel for "has a real
                  fixture" — empty string only for CUSTOM pools' synthesized
                  stand-in (lib/pools/fetch.ts). COMBO pools now can (and,
                  via the template builder, always do) carry a real fixture
                  too, so this is keyed on actually having fixture data, not
                  on poolType — a COMBO prop tied to a match should show the
                  same team badges + kickoff date/time as
                  WHO_WILL_ADVANCE/REGULATION_RESULT, not just its title. */}
              {viewModel.fixture.homeTeamName && <MatchIdentity fixture={viewModel.fixture} />}

              {isLive && (
                <LiveMatchStatus
                  homeTeamName={viewModel.fixture.homeTeamName}
                  awayTeamName={viewModel.fixture.awayTeamName}
                  homeScore={viewModel.fixture.homeScore}
                  awayScore={viewModel.fixture.awayScore}
                  elapsedMinutes={viewModel.fixture.elapsedMinutes}
                />
              )}

              {!isSimplified && (
                <>
                  {/* Read-only context for what Yes/No actually grades
                      against — never itself selectable, only the options
                      below take entries. */}
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

                  {/* Community split next — the aggregate social signal,
                      ahead of who specifically is in the pool. */}
                  {showDistribution && <CommunitySplit options={mergedOptions} />}

                  {/* Side by side once there's room for two real buttons
                      (matches the approved mockup's desktop layout), full
                      width stacked below that (mobile) — a plain
                      breakpoint is enough since this app is single-column
                      at every viewport, never a narrow column on a wide
                      screen. More than 2 options (legacy 3-way pools)
                      always stacks — three 56px+ buttons side by side
                      would be cramped, not a poll. */}
                  <div className={cn("grid gap-3", mergedOptions.length === 2 && "sm:grid-cols-2")}>
                    {mergedOptions.map((option, i) => (
                      <PoolChoiceButton
                        key={option.optionId}
                        label={option.label}
                        logoUrl={option.teamLogoUrl}
                        isCurrentUserChoice={option.isCurrentUserChoice}
                        isFirst={i === 0}
                        // Admins/super_admins coordinate pools, they don't
                        // play in them — create_pool_entry rejects this
                        // server-side too, but hiding the affordance here
                        // avoids a pointless round trip.
                        disabled={!isPreVote || viewer.isModerator}
                        onSelect={() => isPreVote && !viewer.isModerator && setSelectedOptionId(option.optionId)}
                      />
                    ))}
                  </div>
                </>
              )}

              <PoolStatusNotice notice={viewModel.notice} />
            </>
          )}

          {/* The one restrained supporting-info row — entered/pot/countdown,
              nothing else. Entry fee/platform fee deliberately don't show
              here at all: they belong to the moment of committing (the
              entry sheet below), not to browsing an unanswered card. */}
          <PoolSummary
            participantCount={viewModel.socialProof.participantCount}
            grossPool={mergedGrossPool}
            locksAt={viewModel.locksAt}
            isLocked={isLocked || isLive}
            isResolved={isResolved}
          />

          {/* Secondary row — social actions and the details link. Visually
              quiet and separated from the summary above with real space,
              so it reads as "more, if you want it" rather than competing
              with the prediction for attention. */}
          <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
            {!isDetailPage ? <PoolDetailsDisclosure poolId={viewModel.poolId} /> : <span />}
            <div className="flex items-center gap-0.5 text-text-muted">
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
        </>
      )}

      {selectedOption &&
        (!requiresPayment(viewModel) ? (
          <FreeEntryConfirmationSheet
            poolId={viewModel.poolId}
            optionId={selectedOption.optionId}
            optionLabel={selectedOption.label}
            ruleLabel={viewModel.ruleLabel}
            locksAt={viewModel.locksAt}
            onClose={() => setSelectedOptionId(null)}
            onSuccess={() => setSelectedOptionId(null)}
          />
        ) : balanceCents < viewModel.entryFee! ? (
          <TopUpAndJoinModal
            poolId={viewModel.poolId}
            optionId={selectedOption.optionId}
            optionLabel={selectedOption.label}
            entryFee={viewModel.entryFee!}
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
            entryFee={viewModel.entryFee!}
            houseFeeBasisPoints={viewModel.houseFeeBasisPoints}
            balanceCents={balanceCents}
            locksAt={viewModel.locksAt}
            estimatedPayout={showDistribution ? selectedOption.estimatedPayout : null}
            tiers={siblingTiers?.map((tier) => ({
              poolId: tier.poolId,
              entryFee: tier.entryFee!,
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
