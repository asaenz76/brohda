"use client";

import { useState, useTransition } from "react";
import { setMemberBlockAction } from "@/lib/actions/member-block";
import { Button } from "@/components/ui/button";

/** Block / unblock on another Member's profile. Blocking asks first, because it changes what both Members can do with each other. */
export function BlockMemberButton({ memberId, memberName, initiallyBlocked }: { memberId: string; memberName: string; initiallyBlocked: boolean }) {
  const [blocked, setBlocked] = useState(initiallyBlocked);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(next: boolean) {
    setMessage(null);
    startTransition(async () => {
      const result = await setMemberBlockAction(memberId, next);
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) setBlocked(result.blocked);
      setConfirming(false);
    });
  }

  return (
    <div className="flex flex-col items-start gap-1" data-slot="block-member">
      {confirming ? (
        <div className="space-y-2" role="alertdialog" aria-label={`Block ${memberName}`}>
          <p className="max-w-xs text-xs text-text-secondary">
            Block {memberName}? Neither of you will be able to message, call BS on or reply to the other, and you won&apos;t see their comments. Everyone else still sees them.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => run(true)}>
              Block
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => (blocked ? run(false) : setConfirming(true))}>
          {blocked ? "Unblock" : "Block"}
        </Button>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "max-w-xs text-xs text-text-secondary" : "max-w-xs text-xs font-medium text-warning-muted"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
