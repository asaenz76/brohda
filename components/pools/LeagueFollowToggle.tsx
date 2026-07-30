"use client";

import { useState, useTransition } from "react";
import { Star } from "lucide-react";
import { toggleLeagueFollowAction } from "@/lib/actions/league-follows";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LeagueFollowToggle({
  leagueId,
  leagueName,
  initiallyFollowing,
}: {
  leagueId: string;
  leagueName: string;
  initiallyFollowing: boolean;
}) {
  const [following, setFollowing] = useState(initiallyFollowing);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const wasFollowing = following;
    setFollowing(!wasFollowing);

    startTransition(async () => {
      const result = await toggleLeagueFollowAction(leagueId, wasFollowing);
      if (result.error) {
        setFollowing(wasFollowing);
        return;
      }
      setFollowing(result.following);
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={isPending}
      onClick={handleClick}
      aria-label={following ? `Unfollow ${leagueName}` : `Follow ${leagueName}`}
      aria-pressed={following}
      className="size-6 text-text-muted"
    >
      <Star className={cn("size-4", following && "fill-warning-muted text-warning-muted")} aria-hidden="true" />
    </Button>
  );
}
