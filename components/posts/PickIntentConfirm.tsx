"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setPickAction } from "@/lib/actions/predictions";

/**
 * M7 — the side a visitor tapped before signing up, handed back as a question, not an action: "You chose X. Confirm your pick." Nothing was saved while they were signed out, and nothing is saved until they press the
 * button here — the Pick itself goes through the same server action as every other Pick (setPickAction: auth, eligibility, lock and rate limits unchanged). The other side is one tap away in the composer below.
 */
export function PickIntentConfirm({ marketId, outcome, label, postId }: { marketId: string; outcome: "YES" | "NO"; label: string; postId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (saving) return;
    setSaving(true);
    setError(null);
    let result: Awaited<ReturnType<typeof setPickAction>>;
    try {
      result = await setPickAction({ marketId, selectedOutcome: outcome, idempotencyKey: crypto.randomUUID() });
    } catch {
      result = { success: false, error: "That pick couldn't be saved. Nothing changed — try again.", outcome: "error", closed: false, selection: null, cancelledChallenges: 0 };
    }
    setSaving(false);
    if (result.success) {
      // Drop the hint from the address, then re-read the Post: the composer below now shows the Pick.
      startTransition(() => {
        router.replace(`/post/${postId}`);
        router.refresh();
      });
      return;
    }
    setError(result.error ?? "That pick couldn't be saved.");
  }

  return (
    <div className="space-y-2 rounded-lg border-2 border-text-primary bg-secondary p-3" data-slot="pick-intent" role="group" aria-label="Confirm your pick">
      <p className="text-sm font-semibold text-text-primary">You chose {label}.</p>
      <p className="text-xs text-text-muted">Confirm it to make your pick, or choose the other side below.</p>
      <Button type="button" size="lg" onClick={confirm} disabled={saving || pending} data-slot="pick-intent-confirm" className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto">
        {saving ? "Saving…" : `Confirm your pick: ${label}`}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
