import Link from "next/link";
import type { ResultNextStepsData } from "@/lib/predictions/result-next-steps";

/**
 * M7 — under a result: where it left your Record, where you stand this week (when the weekly leaderboard is on), and the way to your next Pick. Plain text, real numbers, no pressure: a Pick that is still waiting for its
 * result is NOT counted toward the weekly minimum (only decided Picks are), and this says "decided" so a Member is never told they have five when they have none.
 */
export function ResultNextSteps({ data }: { data: ResultNextStepsData }) {
  const { record, weekly } = data;
  return (
    <div className="space-y-2 rounded-lg border border-border-subtle p-3" data-slot="result-next-steps">
      <p className="text-sm text-text-primary" data-slot="result-record">
        Your Record is <span className="font-semibold tabular-nums">{record.correct}–{record.incorrect}</span>.{" "}
        <Link href="/profile" className="underline underline-offset-4 hover:text-text-primary">
          See your Record
        </Link>
      </p>
      {weekly && (
        <p className="text-sm text-text-secondary" data-slot="result-weekly">
          {weekly.ranked && weekly.rank !== null ? (
            <>You&apos;re #{weekly.rank} on this week&apos;s leaderboard.</>
          ) : (
            <>
              {weekly.decided} of {weekly.minDecided} decided {weekly.minDecided === 1 ? "Pick" : "Picks"} this week to qualify for the leaderboard.
            </>
          )}{" "}
          <Link href="/leaderboard" className="underline underline-offset-4 hover:text-text-primary">
            Weekly leaderboard
          </Link>
        </p>
      )}
      <p className="text-sm">
        <Link href="/feed" className="font-medium text-accent-primary underline underline-offset-4" data-slot="result-next-game">
          Pick another game
        </Link>
      </p>
    </div>
  );
}
