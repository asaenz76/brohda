import Link from "next/link";
import { Avatar } from "@/components/Avatar";

export type StoryEntry = {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
};

// Instagram-style bubble row: any followed user with new activity since
// the viewer's last visit — purple ring per the reference mockup, no
// distinction drawn here between "new entry" and "new pool published",
// both just read as "something happened".
export function StoriesRow({ entries }: { entries: StoryEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="flex gap-4 overflow-x-auto pb-1" aria-label="Stories">
      {entries.map((entry) => {
        const bubble = (
          <div className="flex shrink-0 flex-col items-center gap-1">
            <Avatar
              displayName={entry.displayName}
              avatarUrl={entry.avatarUrl}
              size="lg"
              className="ring-2 ring-accent-primary ring-offset-2 ring-offset-background"
            />
            <span className="max-w-16 truncate text-xs text-text-secondary">{entry.displayName}</span>
          </div>
        );

        return entry.username ? (
          <Link key={entry.userId} href={`/profile/${entry.username}`} className="shrink-0">
            {bubble}
          </Link>
        ) : (
          <div key={entry.userId} className="shrink-0">
            {bubble}
          </div>
        );
      })}
    </div>
  );
}
