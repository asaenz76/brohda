interface PoolFinalScoreProps {
  homeTeamName: string;
  homeTeamLogoUrl: string | null;
  awayTeamName: string;
  awayTeamLogoUrl: string | null;
  homeScore: number | null;
  awayScore: number | null;
}

// Settled-state replacement for MatchIdentity — same big-crest visual
// weight as the open card, with the final score standing where "VS" used
// to sit. No internal "FINAL" label: the PoolStatus pill above already
// says that, repeating it here would be the same fact twice. Neutral
// coloring throughout (no win/loss tint): this component only reports
// what happened on the field, never who won the *pool* — that's
// PoolResult/PoolStatusNotice's job.
export function PoolFinalScore({
  homeTeamName,
  homeTeamLogoUrl,
  awayTeamName,
  awayTeamLogoUrl,
  homeScore,
  awayScore,
}: PoolFinalScoreProps) {
  return (
    <div className="flex items-center justify-center gap-4 sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
        {homeTeamLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={homeTeamLogoUrl} alt="" className="size-16 shrink-0 rounded-full object-contain sm:size-20" />
        ) : (
          <span className="size-16 shrink-0 rounded-full bg-surface-elevated sm:size-20" aria-hidden="true" />
        )}
        <span className="truncate text-base font-bold text-text-primary sm:text-lg">{homeTeamName}</span>
      </div>
      <span
        className="shrink-0 text-3xl font-bold text-text-primary sm:text-4xl"
        aria-label={`Final score ${homeScore ?? 0} to ${awayScore ?? 0}`}
      >
        {homeScore ?? 0}–{awayScore ?? 0}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
        {awayTeamLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={awayTeamLogoUrl} alt="" className="size-16 shrink-0 rounded-full object-contain sm:size-20" />
        ) : (
          <span className="size-16 shrink-0 rounded-full bg-surface-elevated sm:size-20" aria-hidden="true" />
        )}
        <span className="truncate text-base font-bold text-text-primary sm:text-lg">{awayTeamName}</span>
      </div>
    </div>
  );
}
