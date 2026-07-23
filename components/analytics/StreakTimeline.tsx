import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { StreakSymbol } from "@/lib/analytics/streaks";
import { ChartEmptyState } from "./ChartEmptyState";

interface StreakTimelineProps {
  symbols: StreakSymbol[]; // most-recent-first
  currentStreak: number; // positive = winning streak, negative = losing streak
  longestWinStreak: number;
  longestLossStreak: number;
}

const SYMBOL_CLASSES: Record<StreakSymbol, string> = {
  W: "bg-pool-win/15 text-pool-win",
  L: "bg-pool-loss/15 text-pool-loss",
  V: "bg-surface-secondary text-text-muted",
};

export function StreakTimeline({ symbols, currentStreak, longestWinStreak, longestLossStreak }: StreakTimelineProps) {
  const chronological = [...symbols].reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Streak history</CardTitle>
        <CardDescription>
          {`Your last ${symbols.length} graded entries. Voids don’t break or extend a streak.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {symbols.length === 0 ? (
          <ChartEmptyState message="Enter more pools to unlock this graph." />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {chronological.map((symbol, index) => (
                <span
                  key={index}
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    SYMBOL_CLASSES[symbol],
                  )}
                >
                  {symbol}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-secondary">
              <span>
                Current streak:{" "}
                <strong className="text-text-primary">
                  {currentStreak > 0 ? `${currentStreak}W` : currentStreak < 0 ? `${-currentStreak}L` : "—"}
                </strong>
              </span>
              <span>
                Longest win streak: <strong className="text-text-primary">{longestWinStreak}</strong>
              </span>
              <span>
                Longest loss streak (last {symbols.length}):{" "}
                <strong className="text-text-primary">{longestLossStreak}</strong>
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
