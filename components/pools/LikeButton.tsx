"use client";

import { useState, useTransition } from "react";
import { Heart } from "lucide-react";
import { toggleLikeAction } from "@/lib/actions/likes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LikeButton({
  poolId,
  initiallyLiked,
  initialCount,
}: {
  poolId: string;
  initiallyLiked: boolean;
  initialCount: number;
}) {
  const [liked, setLiked] = useState(initiallyLiked);
  const [count, setCount] = useState(initialCount);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const wasLiked = liked;
    const nextLiked = !wasLiked;
    setLiked(nextLiked);
    setCount((c) => c + (nextLiked ? 1 : -1));

    startTransition(async () => {
      const result = await toggleLikeAction(poolId, wasLiked);
      if (result.error) {
        setLiked(wasLiked);
        setCount((c) => c + (wasLiked ? 1 : -1));
        return;
      }
      setLiked(result.liked);
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isPending}
      onClick={handleClick}
      aria-label={liked ? "Unlike" : "Like"}
      aria-pressed={liked}
      className="px-1.5 text-text-muted"
    >
      <Heart
        className={cn("size-5", liked && "fill-danger text-danger")}
        aria-hidden="true"
      />
      {count > 0 && <span className="text-xs font-medium">{count}</span>}
    </Button>
  );
}
