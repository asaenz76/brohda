import Link from "next/link";
import { Trophy } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { getPredictionLeaderboard } from "@/lib/reputation/repository";
import type { LeaderboardPeriod } from "@/lib/reputation/types";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { Avatar } from "@/components/Avatar";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PeriodFilter } from "./period-filter";

// Milestone R11 (docs/BROHDA_2_0_MILESTONE_MAP.md, Reputation +
// Leaderboards), §29-33, §84-87. A separate route from the pre-existing
// legacy pool leaderboard (/leaderboard) — never hijacked, never merged
// (§93). Deliberately its own small presentation (not RankedList/Podium,
// which are shaped around the legacy pool's own correctCount/totalCount
// ratio) since this domain's record shape (correct/incorrect/void/
// decided/accuracy) is genuinely different.
const PAGE_SIZE = 50;

function isPeriod(value: string | undefined): value is LeaderboardPeriod {
  return value === "ALL_TIME" || value === "WEEK" || value === "MONTH";
}

export default async function PredictionLeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; page?: string }>;
}) {
  const { period: periodParam, page: pageParam } = await searchParams;
  const period: LeaderboardPeriod = isPeriod(periodParam) ? periodParam : "ALL_TIME";
  const page = Math.max(1, Number(pageParam) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const user = await requireUser();
  const { entries, totalEligible } = await getPredictionLeaderboard(period, PAGE_SIZE, offset);

  const hasNextPage = offset + entries.length < totalEligible;
  const hasPrevPage = page > 1;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Prediction Leaderboard</h1>

      <p className="text-xs text-text-muted">
        Ranked by prediction accuracy —{" "}
        <Link href="/leaderboard" className="text-accent-primary hover:underline">
          view the Pools leaderboard
        </Link>
      </p>

      <PeriodFilter />

      {entries.length === 0 ? (
        <EmptyFeedState
          icon={Trophy}
          title="No rankings yet"
          description="Once enough predictions have been graded, rankings will show up here."
        />
      ) : (
        <>
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li
                key={entry.userId}
                id={`row-${entry.userId}`}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 ${entry.userId === user.id ? "bg-accent-primary-subtle" : ""}`}
              >
                <span className="w-8 shrink-0 text-right text-sm font-semibold text-text-muted">#{entry.rank}</span>
                <Link href={`/profile/${entry.username ?? entry.userId}`} className="flex min-w-0 flex-1 items-center gap-2">
                  <Avatar displayName={entry.displayName} avatarUrl={entry.avatarUrl} size="sm" />
                  <span className="truncate text-sm font-medium text-text-primary">{entry.displayName}</span>
                </Link>
                <span className="shrink-0 text-sm text-text-secondary">
                  {entry.correct}–{entry.incorrect}
                  {entry.void > 0 && <span className="text-text-muted"> · {entry.void} void</span>}
                </span>
                <span className="w-16 shrink-0 text-right text-sm font-semibold text-text-primary">{(entry.accuracy * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>

          {(hasPrevPage || hasNextPage) && (
            <div className="flex items-center justify-between gap-2">
              {hasPrevPage ? (
                <Link href={`/leaderboard/predictions?period=${period}&page=${page - 1}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                  Previous
                </Link>
              ) : (
                <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-50")} aria-disabled="true">
                  Previous
                </span>
              )}
              {hasNextPage ? (
                <Link href={`/leaderboard/predictions?period=${period}&page=${page + 1}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                  Next
                </Link>
              ) : (
                <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-50")} aria-disabled="true">
                  Next
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
