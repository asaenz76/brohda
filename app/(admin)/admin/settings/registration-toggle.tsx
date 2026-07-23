"use client";

import { useState, useTransition } from "react";
import { setRegistrationEnabledAction } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";

export function RegistrationToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const result = await setRegistrationEnabledAction(!enabled);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setEnabled(!enabled);
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Self-service registration</p>
          <p className="text-xs text-text-muted">
            {enabled
              ? "Open — anyone can create an account from /register."
              : "Closed — /register shows a \"currently closed\" message. New accounts still come from invitations."}
          </p>
        </div>
        <Button type="button" variant="outline" disabled={isPending} onClick={handleToggle}>
          {isPending ? "Saving…" : enabled ? "Disable" : "Enable"}
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
