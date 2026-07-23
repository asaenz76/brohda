import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { formatPickRecord, type LeaderboardEntry } from "./Podium";

// Same medal colors as the Podium's gold/silver/bronze, keyed by array
// position (entries is already sorted best-first) — a quick visual anchor
// tying the top of this full list back to who's standing on the podium
// above it, without having to cross-reference badge numbers.
const PODIUM_BORDER_COLORS = ["border-l-amber-400", "border-l-zinc-300", "border-l-orange-400"];

export function RankedList({
  entries,
  currentUserId,
}: {
  entries: LeaderboardEntry[];
  currentUserId: string;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border-subtle bg-surface-primary">
      <div className="flex items-center justify-between px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
        <span>Player</span>
        <span>Correct picks</span>
      </div>
      <ul className="divide-y divide-border-subtle px-1 pb-1">
        {entries.map((entry, index) => {
          const isYou = entry.userId === currentUserId;
          const rowClassName = cn(
            "flex items-center gap-3 border-l-4 px-2 py-2.5",
            PODIUM_BORDER_COLORS[index] ?? "border-l-transparent",
            isYou && "bg-accent-primary/10",
          );
          const content = (
            <>
              <span className="w-6 text-center text-sm font-semibold text-text-muted">{entry.rank}</span>
              <Avatar displayName={entry.displayName} avatarUrl={entry.avatarUrl} size="sm" />
              <span className="flex flex-1 items-center gap-1.5 truncate">
                <p
                  className={cn(
                    "truncate text-sm font-medium",
                    isYou ? "text-accent-primary" : "text-text-primary",
                  )}
                >
                  {entry.displayName}
                </p>
                {isYou && (
                  <span className="shrink-0 rounded-full bg-accent-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent-primary">
                    You
                  </span>
                )}
              </span>
              <p className="text-sm font-semibold text-text-secondary">
                {formatPickRecord(entry.correctCount, entry.totalCount)}
              </p>
            </>
          );

          // resolvePublicProfile accepts either a username or a raw id —
          // most seed/demo accounts here have no username set, so falling
          // back to userId is what actually makes this link work for them.
          return (
            <li key={entry.userId}>
              <Link href={`/profile/${entry.username ?? entry.userId}`} className={cn(rowClassName, "rounded-xl")}>
                {content}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
