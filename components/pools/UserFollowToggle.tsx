"use client";

import { useState, useTransition } from "react";
import { toggleFollowAction } from "@/lib/actions/follows";
import { cn } from "@/lib/utils";

// Compact, inline variant of profile/FollowButton — same optimistic
// flip-then-roll-back-on-error pattern, sized to sit next to a name in a
// comment row rather than as a standalone page action.
export function UserFollowToggle({
  userId,
  displayName,
  initiallyFollowing,
}: {
  userId: string;
  displayName: string;
  initiallyFollowing: boolean;
}) {
  const [following, setFollowing] = useState(initiallyFollowing);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const wasFollowing = following;
    setFollowing(!wasFollowing);

    startTransition(async () => {
      const result = await toggleFollowAction(userId, wasFollowing);
      if (result.error) {
        setFollowing(wasFollowing);
        return;
      }
      setFollowing(result.following);
    });
  }

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={handleClick}
      aria-label={following ? `Unfollow ${displayName}` : `Follow ${displayName}`}
      aria-pressed={following}
      className={cn(
        "text-xs font-medium hover:underline",
        following ? "text-text-muted" : "text-accent-primary-label",
      )}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
