"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { revokeInvitationAction } from "@/lib/actions/invitations";
import { Button } from "@/components/ui/button";

export function RevokeInvitationButton({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRevoke() {
    setError(null);
    startTransition(async () => {
      const result = await revokeInvitationAction(invitationId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-1.5">
      <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleRevoke}>
        {isPending ? "Revoking…" : "Revoke"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
