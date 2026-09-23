"use client";

import { useState, useTransition } from "react";
import { followCommunityAction, unfollowCommunityAction } from "@/lib/actions/communities";
import { Button } from "@/components/ui/button";

export function CommunityFollowButton({ communityId, initiallyFollowing }: { communityId: string; initiallyFollowing: boolean }) {
  const [following, setFollowing] = useState(initiallyFollowing);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const nextFollowing = !following;
    setError(null);
    setFollowing(nextFollowing);

    startTransition(async () => {
      const result = nextFollowing ? await followCommunityAction(communityId) : await unfollowCommunityAction(communityId);
      if (result.error) {
        setFollowing(!nextFollowing);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" variant={following ? "outline" : "default"} size="sm" disabled={isPending} onClick={handleClick}>
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
