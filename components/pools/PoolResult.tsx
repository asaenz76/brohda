import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import { PoolQuestion } from "@/components/pools/PoolQuestion";
import { PoolFinalScore } from "@/components/pools/PoolFinalScore";
import { PoolStatusNotice } from "@/components/pools/PoolStatusNotice";

// The settled-state treatment: question (for context — the real, frozen
// question text, never a fabricated past-tense rewrite), final score,
// your pick, won/lost outcome, payout if applicable — deliberately NOT
// the open-pool interface (CommunitySplit + choice buttons). A resolved
// pool has nothing left to decide, so it shouldn't look like it does;
// progressive disclosure means this state gets simpler than OPEN, not the
// same information restored with buttons disabled.
export function PoolResult({ viewModel }: { viewModel: SocialPoolCardViewModel }) {
  const { fixture, currentUser, options, notice } = viewModel;
  const selectedOption = options.find((o) => o.optionId === currentUser.selectedOptionId);

  return (
    <div className="space-y-6">
      <PoolQuestion question={viewModel.question} ruleLabel={viewModel.ruleLabel} />
      {fixture.homeTeamName && (
        <PoolFinalScore
          homeTeamName={fixture.homeTeamName}
          homeTeamLogoUrl={fixture.homeTeamLogoUrl}
          awayTeamName={fixture.awayTeamName}
          awayTeamLogoUrl={fixture.awayTeamLogoUrl}
          homeScore={fixture.homeScore}
          awayScore={fixture.awayScore}
        />
      )}
      <div className="space-y-2">
        {currentUser.hasEntered && selectedOption && (
          <p className="text-center text-sm text-text-secondary">
            Your pick: <span className="font-semibold text-text-primary">{selectedOption.label}</span>
          </p>
        )}
        <PoolStatusNotice notice={notice} />
      </div>
    </div>
  );
}
