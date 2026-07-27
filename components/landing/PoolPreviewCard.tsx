"use client";

import { MessageCircle, Heart } from "lucide-react";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import { formatCents, formatBps } from "@/lib/utils/money";
import { PoolLeagueHeader } from "@/components/pools/PoolLeagueHeader";
import { MatchIdentity } from "@/components/pools/MatchIdentity";
import { RulePill } from "@/components/pools/RulePill";
import { PoolOptionButton } from "@/components/pools/PoolOptionButton";
import { PoolDistributionBar } from "@/components/pools/PoolDistributionBar";
import { AvatarStack } from "@/components/pools/AvatarStack";

// A read-only preview of the real SocialPoolCard, built from the exact same
// view-model + presentational sub-components the logged-in Feed renders —
// so what a visitor sees pre-login is genuinely the product, not a
// recreation of it. No entry sheet, no like/comment actions, no realtime
// subscription: nothing here is clickable, matching a marketing page's
// "look, don't touch" expectation.
export function PoolPreviewCard({ viewModel }: { viewModel: SocialPoolCardViewModel }) {
  const isPreVote = viewModel.status === "OPEN_PRE_VOTE";
  const isPostVote = viewModel.status === "OPEN_POST_VOTE";
  const showDistribution = isPreVote || isPostVote;

  return (
    <article className="space-y-3.5 rounded-2xl border border-border-subtle bg-surface-primary p-5">
      <PoolLeagueHeader
        competitionName={viewModel.fixture.competitionName}
        competitionCountry={viewModel.fixture.competitionCountry}
        competitionLogoUrl={viewModel.fixture.competitionLogoUrl}
        poolType={viewModel.poolType}
        visibility={viewModel.visibility}
        createdAt={viewModel.postedAt}
        locksAt={viewModel.locksAt}
        isLocked={false}
        isResolved={false}
      />

      {viewModel.fixture.homeTeamName && <MatchIdentity fixture={viewModel.fixture} />}
      {viewModel.title && (
        <p className="text-sm font-medium text-text-secondary">{viewModel.title}</p>
      )}

      <div>
        <h3 className="text-lg font-bold text-text-primary">{viewModel.question}</h3>
        <div className="mt-1.5">
          <RulePill label={viewModel.ruleLabel} />
        </div>
      </div>

      <div className="space-y-2">
        {viewModel.options.map((option) => (
          <PoolOptionButton
            key={option.optionId}
            label={option.label}
            logoUrl={option.teamLogoUrl}
            percentage={option.percentage}
            estimatedPayout={option.estimatedPayout}
            isCurrentUserChoice={false}
            disabled
            onSelect={() => {}}
          />
        ))}
      </div>

      {showDistribution && <PoolDistributionBar options={viewModel.options} />}

      <div className="flex items-center justify-between gap-2">
        <AvatarStack
          participants={viewModel.socialProof.visibleParticipants}
          totalCount={viewModel.socialProof.participantCount}
        />
        <div className="flex items-center gap-3 text-text-muted">
          <span className="flex items-center gap-1 text-xs font-medium">
            <Heart className="size-4" aria-hidden="true" />
            {viewModel.likeCount}
          </span>
          <span className="flex items-center gap-1 text-xs font-medium">
            <MessageCircle className="size-4" aria-hidden="true" />
            {viewModel.commentCount}
          </span>
        </div>
      </div>

      <p className="text-xs text-text-muted">
        Entry {formatCents(viewModel.entryFee)} · Platform Fee{" "}
        {formatBps(viewModel.houseFeeBasisPoints)}
        {showDistribution && (
          <>
            {" · Requires "}
            {viewModel.minTotalEntries}+ entries to run
          </>
        )}
      </p>
    </article>
  );
}
