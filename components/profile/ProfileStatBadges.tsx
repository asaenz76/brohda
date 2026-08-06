import { Flame, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPickRecord } from "@/components/leaderboard/Podium";

// Instagram/Duolingo-style stat chips — the emotionally resonant numbers,
// promoted ahead of the plain numeric Picks/Followers/Following row below
// them. Same underlying numbers the leaderboard already shows
// (get_profile_stats mirrors get_leaderboard's all-time formula exactly),
// just surfaced as a badge instead of a table row. The streak chip always
// renders (a cold streak is still a stat worth showing, same as Duolingo
// displaying "0"); the win-rate chip only
// appears once there's at least one settled pick — a rate over zero picks
// isn't a stat, it's noise.
export function ProfileStatBadges({
  correctCount,
  totalCount,
  currentStreak,
}: {
  correctCount: number;
  totalCount: number;
  currentStreak: number;
}) {
  const isOnStreak = currentStreak > 0;

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold",
          isOnStreak ? "bg-streak/15 text-streak" : "bg-surface-secondary text-text-muted",
        )}
      >
        <Flame className={cn("size-3.5", isOnStreak && "fill-streak")} aria-hidden="true" />
        {currentStreak} streak
      </span>

      {totalCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-accent-primary/15 px-2.5 py-1 text-sm font-semibold text-accent-primary">
          <Target className="size-3.5" aria-hidden="true" />
          {formatPickRecord(correctCount, totalCount)}
        </span>
      )}
    </div>
  );
}
