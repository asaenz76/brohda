"use client";

import { useState, useTransition } from "react";
import { setPlatformPoolCapabilityAction } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";

interface PlatformPoolCapabilityToggleProps {
  capability: "paid" | "free";
  initialEnabled: boolean;
}

const COPY = {
  paid: {
    label: "Paid pools",
    onDescription: "Open — new paid entries are accepted.",
    offDescription:
      "Off — no new paid entries will be accepted, effective immediately, including on pools that are already open. Pools already open, locked, or in review continue to their normal conclusion: existing entries, grading, settlement, refunds, and reversals are unaffected.",
    confirmMessage:
      'Turn off paid pools? No new paid entries will be accepted, effective immediately — including on pools that are already open. Pools already open, locked, or in review will complete normally; nothing in flight is affected.',
  },
  free: {
    label: "Free pools",
    onDescription: "Open — new free predictions are accepted.",
    offDescription:
      "Off — no new free predictions will be accepted, effective immediately, including on predictions already in progress. Existing free predictions continue grading normally.",
    confirmMessage:
      "Turn off free pools? No new free predictions will be accepted, effective immediately — including on predictions already in progress. Existing free predictions will keep grading normally.",
  },
} as const;

// Mirrors RegistrationToggle's exact shape (controlled boolean, optimistic
// local state, useTransition, server-action call, error display on
// failure) — same pattern, extended to a capability that can also require
// confirmation before disabling (FREE_MODE_ARCHITECTURE_PROPOSAL.md §5.3):
// turning either capability off is the consequential direction, since it
// takes effect on every in-flight confirmation sheet immediately.
export function PlatformPoolCapabilityToggle({
  capability,
  initialEnabled,
}: PlatformPoolCapabilityToggleProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const copy = COPY[capability];

  function handleToggle() {
    if (enabled && !window.confirm(copy.confirmMessage)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await setPlatformPoolCapabilityAction(capability, !enabled);
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
          <p className="text-sm font-medium text-text-primary">{copy.label}</p>
          <p className="text-xs text-text-muted">{enabled ? copy.onDescription : copy.offDescription}</p>
        </div>
        <Button type="button" variant="outline" disabled={isPending} onClick={handleToggle}>
          {isPending ? "Saving…" : enabled ? "Disable" : "Enable"}
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
