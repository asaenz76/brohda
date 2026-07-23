interface LiveMatchStatusProps {
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number | null;
  awayScore: number | null;
  elapsedMinutes: number | null;
}

// X.5.13: informational only — never implies choices can still change.
export function LiveMatchStatus({
  homeTeamName,
  awayTeamName,
  homeScore,
  awayScore,
  elapsedMinutes,
}: LiveMatchStatusProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-2">
      {/* Dedicated live color, not danger — "the match is happening right
          now" isn't "you lost", even though both used to be the same red. */}
      <span className="flex items-center gap-1 text-xs font-semibold text-pool-live">
        <span className="size-1.5 animate-pulse rounded-full bg-pool-live" aria-hidden="true" />
        LIVE{elapsedMinutes != null ? ` · ${elapsedMinutes}'` : ""}
      </span>
      <span className="text-sm font-medium text-text-primary">
        {homeTeamName} {homeScore ?? 0}–{awayScore ?? 0} {awayTeamName}
      </span>
    </div>
  );
}
