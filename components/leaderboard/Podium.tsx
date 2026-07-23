import Link from "next/link";
import { Crown } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";

export type LeaderboardEntry = {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  correctCount: number;
  totalCount: number;
  rank: number;
};

// "25/124" reads very differently from "25/30" even though the raw correct
// count is identical — showing the denominator (and the rate it implies)
// is the whole point, not just the numerator. totalCount is settled
// (WON/LOST) picks only, so 0/0 means "hasn't had a pick resolve yet",
// not "0% accurate".
export function formatPickRecord(correctCount: number, totalCount: number): string {
  if (totalCount === 0) return "0/0";
  const percent = Math.round((correctCount / totalCount) * 100);
  return `${correctCount}/${totalCount} (${percent}%)`;
}

// Keyed by physical podium slot (0 = the tallest, center pedestal), not by
// `entry.rank` — rank() over() produces ties (two players can both be rank
// 2), and CSS `order` keyed to a possibly-duplicated rank value put two
// entries in the same slot before, bumping 1st place out to the side.
// `entries` is already sliced to the top 3 by rank ascending, so array
// position alone is enough to know who stands where.
const SLOTS = [
  {
    avatarSize: "md" as const,
    ring: "ring-medal-silver",
    platform: "h-10 bg-medal-silver/70",
    badge: "bg-medal-silver text-medal-silver-foreground",
  },
  {
    avatarSize: "xl" as const,
    ring: "ring-medal-gold",
    platform: "h-16 bg-medal-gold/80",
    badge: "bg-medal-gold text-medal-gold-foreground",
  },
  {
    avatarSize: "md" as const,
    ring: "ring-medal-bronze",
    platform: "h-8 bg-medal-bronze/70",
    badge: "bg-medal-bronze text-medal-bronze-foreground",
  },
];

export function Podium({
  entries,
  currentUserId,
}: {
  entries: LeaderboardEntry[];
  currentUserId: string;
}) {
  if (entries.length === 0) return null;

  // Physical left-to-right order: 2nd, 1st, 3rd — a podium, not a ranked
  // list. Missing entries (fewer than 3 players total) just leave that
  // pedestal empty rather than rendering a placeholder.
  const podiumOrder = [entries[1], entries[0], entries[2]];

  return (
    <div className="rounded-2xl border border-border-subtle bg-surface-primary p-4">
      <div className="flex items-end justify-center gap-3">
        {podiumOrder.map((entry, i) => {
          if (!entry) return <div key={`empty-${i}`} className="w-20" />;

          const slot = SLOTS[i];
          const isYou = entry.userId === currentUserId;

          const content = (
            <div className="flex w-20 flex-col items-center gap-1.5">
              {i === 1 && <Crown className="size-4 fill-medal-gold text-medal-gold" aria-hidden="true" />}
              <div className="relative">
                <Avatar
                  displayName={entry.displayName}
                  avatarUrl={entry.avatarUrl}
                  size={slot.avatarSize}
                  className={cn("ring-2 ring-offset-2 ring-offset-surface-primary", slot.ring)}
                />
                <span
                  className={cn(
                    "absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full text-[11px] font-bold",
                    slot.badge,
                  )}
                >
                  {entry.rank}
                </span>
              </div>
              <p
                className={cn(
                  "max-w-20 truncate text-xs font-semibold",
                  isYou ? "text-accent-primary" : "text-text-primary",
                )}
              >
                {entry.displayName}
              </p>
              <p className="text-[11px] text-text-muted">
                {formatPickRecord(entry.correctCount, entry.totalCount)}
              </p>
              <div className={cn("w-full rounded-t-lg", slot.platform)} />
            </div>
          );

          // resolvePublicProfile accepts either a username or a raw id —
          // most seed/demo accounts here have no username set, so falling
          // back to userId is what actually makes this link work for them.
          return (
            <Link key={entry.userId} href={`/profile/${entry.username ?? entry.userId}`}>
              {content}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
