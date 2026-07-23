"use client";

import { useState, useTransition } from "react";
import { toggleFollowAction } from "@/lib/actions/follows";
import { Button } from "@/components/ui/button";

export function FollowButton({
  followeeId,
  initiallyFollowing,
}: {
  followeeId: string;
  initiallyFollowing: boolean;
}) {
  const [following, setFollowing] = useState(initiallyFollowing);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const nextFollowing = !following;
    setError(null);
    setFollowing(nextFollowing);

    startTransition(async () => {
      const result = await toggleFollowAction(followeeId, following);
      if (result.error) {
        setFollowing(following);
        setError(result.error);
        return;
      }
      setFollowing(result.following);
    });
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button
        type="button"
        variant={following ? "outline" : "default"}
        size="sm"
        disabled={isPending}
        onClick={handleClick}
      >
        {following ? "Following" : "Follow"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
