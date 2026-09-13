"use client";

import { MessageCircle, Heart } from "lucide-react";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import { cn } from "@/lib/utils";
import { LeagueIdentity } from "@/components/pools/LeagueIdentity";
import { PoolStatus } from "@/components/pools/PoolStatus";
import { MatchIdentity } from "@/components/pools/MatchIdentity";
import { PoolQuestion } from "@/components/pools/PoolQuestion";
import { PoolChoiceButton } from "@/components/pools/PoolChoiceButton";
import { CommunitySplit } from "@/components/pools/CommunitySplit";
import { PoolSummary } from "@/components/pools/PoolSummary";

// A read-only preview of the real SocialPoolCard, built from the exact same
// view-model + presentational sub-components the logged-in Feed renders —
// so what a visitor sees pre-login is genuinely the product, not a
// recreation of it. No entry sheet, no like/comment actions, no realtime
// subscription: nothing here is clickable, matching a marketing page's
// "look, don't touch" expectation. Geometry mirrors SocialPoolCard exactly
// (same spacing/sizing decisions) — this is a marketing surface, not a
// separate design.
export function PoolPreviewCard({ viewModel }: { viewModel: SocialPoolCardViewModel }) {
  const isPreVote = viewModel.status === "OPEN_PRE_VOTE";
  const isPostVote = viewModel.status === "OPEN_POST_VOTE";
  const showDistribution = isPreVote || isPostVote;

  return (
    <article className="space-y-6 rounded-[24px] border-2 border-text-primary bg-surface-primary p-7 shadow-[6px_6px_0_0_var(--text-primary)] sm:p-8">
      <div className="flex items-start justify-between gap-2">
        <LeagueIdentity
          competitionName={viewModel.fixture.competitionName}
          competitionCountry={viewModel.fixture.competitionCountry}
          competitionLogoUrl={viewModel.fixture.competitionLogoUrl}
          poolType={viewModel.poolType}
        />
        <PoolStatus status={viewModel.status} />
      </div>

      {/* Question leads — matches SocialPoolCard's hierarchy. */}
      <PoolQuestion question={viewModel.question} ruleLabel={viewModel.ruleLabel} />

      {viewModel.title && (
        <p className="text-center text-sm font-medium text-text-secondary">{viewModel.title}</p>
      )}

      {viewModel.fixture.homeTeamName && <MatchIdentity fixture={viewModel.fixture} />}

      {/* Community split next — matches SocialPoolCard's hierarchy. */}
      {showDistribution && <CommunitySplit options={viewModel.options} />}

      <div className={cn("grid gap-3", viewModel.options.length === 2 && "sm:grid-cols-2")}>
        {viewModel.options.map((option, i) => (
          <PoolChoiceButton
            key={option.optionId}
            label={option.label}
            logoUrl={option.teamLogoUrl}
            isCurrentUserChoice={false}
            isFirst={i === 0}
            disabled
            onSelect={() => {}}
          />
        ))}
      </div>

      <PoolSummary
        participantCount={viewModel.socialProof.participantCount}
        grossPool={viewModel.grossPool}
        locksAt={viewModel.locksAt}
        isLocked={false}
        isResolved={false}
      />

      <div className="flex items-center justify-end gap-3 border-t border-border-subtle pt-3 text-text-muted">
        <span className="flex items-center gap-1 text-sm font-medium">
          <Heart className="size-4" aria-hidden="true" />
          {viewModel.likeCount}
        </span>
        <span className="flex items-center gap-1 text-sm font-medium">
          <MessageCircle className="size-4" aria-hidden="true" />
          {viewModel.commentCount}
        </span>
      </div>
    </article>
  );
}
