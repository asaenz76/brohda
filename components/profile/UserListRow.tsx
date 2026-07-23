import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { FollowButton } from "./FollowButton";

export interface UserListEntry {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  isFollowing: boolean;
}

// One row in a followers/following list — mirrors search's player-result
// row (avatar + name/@username, id-fallback link since not every account
// has a username), plus a per-row FollowButton like Instagram's list,
// hidden for the viewer's own row (can't follow yourself).
export function UserListRow({ entry, viewerId }: { entry: UserListEntry; viewerId: string }) {
  const isSelf = entry.userId === viewerId;

  return (
    <li>
      <div className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-surface-secondary">
        <Link
          href={`/profile/${entry.username ?? entry.userId}`}
          className="flex flex-1 items-center gap-3"
        >
          <Avatar displayName={entry.displayName} avatarUrl={entry.avatarUrl} size="md" />
          <div>
            <p className="text-sm font-medium text-text-primary">{entry.displayName}</p>
            {entry.username && <p className="text-xs text-text-muted">@{entry.username}</p>}
          </div>
        </Link>
        {!isSelf && (
          <FollowButton followeeId={entry.userId} initiallyFollowing={entry.isFollowing} />
        )}
      </div>
    </li>
  );
}
