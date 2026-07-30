"use client";

import { useState, useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export interface FollowedItemRowProps {
  id: string;
  name: string;
  logoUrl: string | null;
  emailEnabled: boolean;
  onToggleEmail: (id: string, emailEnabled: boolean) => Promise<{ error: string | null }>;
  onUnfollow: (id: string, isCurrentlyFollowing: boolean) => Promise<{ error: string | null; following: boolean }>;
}

// Shared row shape for both the followed-teams and followed-leagues lists —
// logo/name, a per-item email switch (payment-methods-settings.tsx's
// optimistic-toggle shape), and an unfollow button. Removed from the list
// entirely once unfollowed, rather than staying with a stale disabled row.
export function FollowedItemRow({ id, name, logoUrl, emailEnabled, onToggleEmail, onUnfollow }: FollowedItemRowProps) {
  const [enabled, setEnabled] = useState(emailEnabled);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (removed) return null;

  function handleToggleEmail() {
    const wasEnabled = enabled;
    setEnabled(!wasEnabled);
    setError(null);
    startTransition(async () => {
      const result = await onToggleEmail(id, !wasEnabled);
      if (result.error) {
        setEnabled(wasEnabled);
        setError(result.error);
      }
    });
  }

  function handleUnfollow() {
    setError(null);
    startTransition(async () => {
      const result = await onUnfollow(id, true);
      if (result.error) {
        setError(result.error);
        return;
      }
      setRemoved(true);
    });
  }

  return (
    <li className="space-y-2 rounded-xl border border-border-subtle p-3">
      <div className="flex items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="size-8 rounded-full object-contain" />
        ) : (
          <span className="size-8 rounded-full bg-surface-elevated" aria-hidden="true" />
        )}
        <p className="flex-1 text-sm font-medium text-text-primary">{name}</p>
        <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={handleUnfollow}>
          Unfollow
        </Button>
      </div>
      <div className="flex items-center justify-between gap-4 pl-11">
        <p className="text-xs text-text-secondary">Email me about new pools</p>
        <Switch checked={enabled} onCheckedChange={handleToggleEmail} disabled={isPending} />
      </div>
      {error && <p className="pl-11 text-xs text-danger">{error}</p>}
    </li>
  );
}
