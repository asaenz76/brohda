import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_NODES = 10;

// Connected-node progress bar — pure presentation over the two integers
// already on user_profiles, no new data.
export function StreakWidget({
  currentStreak,
  bestStreak,
}: {
  currentStreak: number;
  bestStreak: number;
}) {
  const filledNodes = Math.min(currentStreak, MAX_NODES);
  const overflow = currentStreak - MAX_NODES;

  return (
    <div className="space-y-3 rounded-2xl border border-border-subtle bg-surface-primary p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">
          {currentStreak > 0 ? "You're on fire!" : "Keep your streak alive!"}
        </p>
      </div>
      <p className="text-xs text-text-muted">
        {currentStreak > 0
          ? `${currentStreak} correct prediction${currentStreak === 1 ? "" : "s"} in a row`
          : "Get your next pick right to start a streak."}
      </p>

      <div className="flex items-center gap-1" aria-hidden="true">
        {Array.from({ length: MAX_NODES }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "flex size-5 items-center justify-center rounded-full",
              i < filledNodes ? "bg-streak text-white" : "bg-surface-secondary text-transparent",
            )}
          >
            <Check className="size-3" />
          </div>
        ))}
        {overflow > 0 && <span className="ml-1 text-xs font-semibold text-streak">+{overflow}</span>}
      </div>

      <p className="text-xs text-text-muted">Best streak: {bestStreak}</p>
    </div>
  );
}
