"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attachConfidenceAction } from "@/lib/actions/confidence-stakes";
import { Button } from "@/components/ui/button";
import { confidenceLabel, formatConfidence, ladderFlames } from "@/lib/confidence/format";

/**
 * "How confident are you?" — the optional Confidence control on a Member's OWN Pick. Nothing is attached by merely choosing: the Member picks an amount from the configured ladder, sees exactly what will happen,
 * and confirms. Confirming reserves the Confidence and locks the Pick in one step. Choices above what the Member has available are disabled with the plain reason; there is no way to get more Confidence from here.
 */
export function ConfidenceBacking({ predictionId, selectionLabel, available, allowedStakes }: { predictionId: string; selectionLabel?: string; available: number; allowedStakes: number[] }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef(crypto.randomUUID());
  const affordable = allowedStakes.filter((n) => n <= available);

  function confirm() {
    if (chosen === null) return;
    setMessage(null);
    startTransition(async () => {
      const result = await attachConfidenceAction({ predictionId, amount: chosen, idempotencyKey: key.current });
      if (result.ok) {
        setDone(result.amount ?? chosen);
        setMessage({ ok: true, text: result.message });
        router.refresh();
      } else {
        // A failed attempt may be retried with a fresh key; a successful one never is.
        key.current = crypto.randomUUID();
        setMessage({ ok: false, text: result.message });
        setChosen(null);
        if (result.outcome !== "insufficient" && result.outcome !== "invalid_amount") router.refresh();
      }
    });
  }

  if (done !== null) {
    return (
      <p role="status" className="text-sm font-semibold text-text-primary" data-slot="confidence-backed">
        {formatConfidence(done)} Confidence · Locked
      </p>
    );
  }

  return (
    <div className="space-y-2" data-slot="confidence-backing">
      <p className="text-sm font-semibold text-text-primary">How confident are you?</p>
      <p className="text-xs text-text-muted">Optional. You have {formatConfidence(available)} available.</p>
      <div role="group" aria-label="How confident are you?" className="flex flex-wrap gap-2">
        {allowedStakes.map((n) => {
          const disabled = n > available || pending;
          return (
            <Button
              key={n}
              type="button"
              size="lg"
              className="min-h-10 min-w-11"
              variant={chosen === n ? "default" : "outline"}
              disabled={disabled}
              aria-pressed={chosen === n}
              aria-label={confidenceLabel(n)}
              data-slot="confidence-choice"
              data-amount={n}
              onClick={() => {
                setMessage(null);
                setChosen(n);
              }}
            >
              <span aria-hidden="true">{ladderFlames(n)}</span>
            </Button>
          );
        })}
      </div>
      {affordable.length === 0 && (
        <p className="text-xs text-text-secondary" data-slot="confidence-insufficient">
          You only have {formatConfidence(available)} available — not enough for any of these. You can still make your pick without Confidence.
        </p>
      )}
      {chosen !== null && (
        <div role="alertdialog" aria-label="Confirm Confidence" className="space-y-2 rounded-md border border-border-subtle p-3" data-slot="confidence-confirm">
          <p className="text-sm text-text-primary">You&apos;re putting {formatConfidence(chosen)} behind {selectionLabel ? <>your pick: <span className="font-semibold">{selectionLabel}</span></> : "this pick"}. Once confirmed, you can&apos;t change it.</p>
          <div className="flex gap-2">
            <Button type="button" size="lg" disabled={pending} onClick={confirm} data-slot="confidence-confirm-button">
              Confirm {formatConfidence(chosen)}
            </Button>
            <Button type="button" variant="outline" size="lg" disabled={pending} onClick={() => setChosen(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-xs font-medium text-text-primary" : "text-xs text-text-secondary"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
