import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { accuracyPercent, picksNeededLabel, qualificationRule, timeLeftLabel, weekRangeLabel, weeklyRecord } from "@/lib/leaderboard/format";
import type { LeaderboardEntry, LeaderboardViewer, WeeklyLeaderboard } from "@/lib/leaderboard/types";

// Brohda 2.1 M6 — the weekly leaderboard, readable in five seconds: who is #1, where you stand, your record, and what you still need to qualify. Raw record first, accuracy beside it, every figure text (never
// colour alone). Real outcomes only: no points, no badges, no prizes. Presentational: the page decides who may see it and passes what it fetched.

function YourStanding({ viewer, minDecided, totalRanked }: { viewer: LeaderboardViewer; minDecided: number; totalRanked: number }) {
  if (!viewer.eligible) {
    return (
      <Card>
        <CardContent className="space-y-1 pt-4" data-slot="leaderboard-me" data-state="not-ranked-account">
          <h2 className="text-sm font-semibold text-text-primary">Your standing</h2>
          <p className="text-sm text-text-secondary">Staff and deactivated accounts aren&apos;t ranked.</p>
        </CardContent>
      </Card>
    );
  }
  const record = weeklyRecord(viewer.correct, viewer.incorrect);
  if (viewer.ranked && viewer.rank !== null) {
    return (
      <Card>
        <CardContent className="space-y-1 pt-4" data-slot="leaderboard-me" data-state="ranked">
          <h2 className="text-sm font-semibold text-text-primary">Your standing</h2>
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-2xl font-semibold tabular-nums text-text-primary">#{viewer.rank}</span>
            <span className="text-base font-semibold tabular-nums text-text-primary">{record}</span>
            {viewer.accuracy !== null && <span className="text-sm tabular-nums text-text-secondary">{accuracyPercent(viewer.accuracy)}</span>}
            <span className="text-xs text-text-muted">of {totalRanked} ranked · qualified</span>
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="space-y-1.5 pt-4" data-slot="leaderboard-me" data-state="unqualified">
        <h2 className="text-sm font-semibold text-text-primary">Your standing</h2>
        <p className="text-base font-semibold text-text-primary">
          <span className="tabular-nums">
            {viewer.decided} of {minDecided}
          </span>{" "}
          {minDecided === 1 ? "Pick" : "Picks"} needed to qualify
        </p>
        <p className="text-sm text-text-secondary">
          {picksNeededLabel(viewer.needed)}.{viewer.decided > 0 && <> This week: <span className="tabular-nums">{record}</span>.</>} Not ranked yet.
        </p>
        <Link href="/feed" className="inline-block text-sm underline underline-offset-4 hover:text-text-primary">
          Make a Pick
        </Link>
      </CardContent>
    </Card>
  );
}

function Row({ entry, isViewer }: { entry: LeaderboardEntry; isViewer: boolean }) {
  const name = (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar displayName={entry.displayName} avatarUrl={entry.avatarUrl} size="md" />
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium text-text-primary">{entry.displayName}</span>
        {entry.username && <span className="block truncate text-xs text-text-muted">@{entry.username}</span>}
      </span>
    </span>
  );
  const href = isViewer ? "/profile" : entry.username ? `/profile/${entry.username}` : null;
  // The viewer's own row sits on a darker highlight, where the usual secondary grey falls under the 4.5:1 AA contrast; their figures use the primary colour instead.
  const muted = isViewer ? "text-text-primary" : "text-text-secondary";
  return (
    <li
      data-slot="leaderboard-row"
      data-rank={entry.rank}
      data-viewer={isViewer ? "true" : undefined}
      className={cn("flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0", isViewer && "bg-surface-secondary")}
    >
      <span className={cn("w-10 shrink-0 text-right tabular-nums", entry.rank <= 3 ? "text-lg font-semibold text-text-primary" : cn("text-base", muted))}>
        <span className="sr-only">Rank </span>#{entry.rank}
      </span>
      <div className="min-w-0 flex-1">
        {href ? (
          <Link href={href} className="block rounded-md outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-primary">
            {name}
          </Link>
        ) : (
          name
        )}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-base font-semibold tabular-nums text-text-primary">
          {weeklyRecord(entry.correct, entry.incorrect)}
          <span className={cn("ml-2 text-sm font-normal", muted)}>{accuracyPercent(entry.accuracy)}</span>
        </p>
        {(entry.tied || isViewer) && (
          <p className="text-xs text-text-muted">
            {isViewer && "You"}
            {isViewer && entry.tied && " · "}
            {entry.tied && "Tied"}
          </p>
        )}
      </div>
    </li>
  );
}

export function WeeklyLeaderboardView({ board, viewerUserId, now }: { board: WeeklyLeaderboard; viewerUserId: string; now: Date }) {
  const viewerInList = board.entries.some((e) => e.userId === viewerUserId);
  return (
    <div className="space-y-4" data-slot="weekly-leaderboard">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text-primary">Weekly leaderboard</h2>
        <p className="text-sm text-text-secondary" data-slot="leaderboard-week">
          {weekRangeLabel(board.weekStart, board.weekEnd)} · {timeLeftLabel(board.weekEnd, now)} · resets Monday 12:00 AM CST
        </p>
        <p className="text-sm text-text-secondary" data-slot="leaderboard-rule">
          {qualificationRule(board.minDecided)}
        </p>
      </div>

      {board.viewer && <YourStanding viewer={board.viewer} minDecided={board.minDecided} totalRanked={board.totalRanked} />}

      {board.entries.length === 0 ? (
        <Card>
          <CardContent className="space-y-1 pt-4" data-slot="leaderboard-empty">
            <p className="text-sm font-medium text-text-primary">No one has qualified yet this week.</p>
            <p className="text-sm text-text-secondary">The first Member to make {board.minDecided} decided {board.minDecided === 1 ? "Pick" : "Picks"} takes #1.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <ol aria-label={`Weekly leaderboard, top ${board.entries.length}`} data-slot="leaderboard-list">
            {board.entries.map((entry) => (
              <Row key={entry.userId} entry={entry} isViewer={entry.userId === viewerUserId} />
            ))}
          </ol>
        </Card>
      )}

      {board.viewer?.eligible && board.viewer.ranked && board.viewer.rank !== null && !viewerInList && (
        <p className="text-sm text-text-secondary" data-slot="leaderboard-outside">
          You&apos;re #{board.viewer.rank} of {board.totalRanked} ranked this week, below the top {board.entries.length} shown.
        </p>
      )}

      <p className="text-xs text-text-muted">Only graded Picks on Games this week count. Pending and void Picks don&apos;t.</p>
    </div>
  );
}
