"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { submitPredictionAction } from "@/lib/actions/predictions";

// Milestone 3's only prediction-submission UI (roadmap STEP 9). Consumer
// language only — "Make your prediction", "YES"/"NO", "You predicted" —
// never Buy/Sell/Trade/Order/Contract/Shares/Position/Wallet/Stake/Bet
// slip, and never a financial-return figure or an amount input (this is a
// belief, not a stake).
//
// Accessibility (roadmap STEP 27): plain <button> elements (native
// keyboard support), the confirmed/disabled states are communicated in
// text — never color alone — and a disabled control always states why via
// `disabledReason` rather than just going inert.

export function PredictionActions({ marketId, disabledReason }: { marketId: string; disabledReason: string | null }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<{ selectedOutcome: "YES" | "NO"; probabilityPercent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(selectedOutcome: "YES" | "NO") {
    setPending(true);
    setError(null);
    const result = await submitPredictionAction({ marketId, selectedOutcome, idempotencyKey });
    setPending(false);
    if (result.success && result.confirmation) {
      setConfirmation(result.confirmation);
    } else {
      setError(result.error ?? "That prediction couldn't be submitted.");
    }
  }

  if (confirmation) {
    return (
      <p role="status" className="text-sm font-semibold text-text-primary">
        You predicted {confirmation.selectedOutcome} at {confirmation.probabilityPercent}%.
      </p>
    );
  }

  const isDisabled = pending || disabledReason !== null;

  return (
    <div className="space-y-2" data-testid="prediction-actions">
      <p className="text-sm font-semibold text-text-primary">Make your prediction</p>
      <div className="flex gap-3">
        <Button
          type="button"
          variant="default"
          size="lg"
          disabled={isDisabled}
          onClick={() => handleSubmit("YES")}
          aria-label="Predict YES"
        >
          YES
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={isDisabled}
          onClick={() => handleSubmit("NO")}
          aria-label="Predict NO"
        >
          NO
        </Button>
      </div>
      {disabledReason && <p className="text-xs text-text-muted">{disabledReason}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
