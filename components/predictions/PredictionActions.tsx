"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { submitPredictionAction } from "@/lib/actions/predictions";
import type { Choice } from "@/lib/prediction-markets/selection-labels";

// Milestone 3's original prediction-submission UI (roadmap STEP 9),
// extended by Milestone R5 (docs/BROHDA_2_0_MILESTONE_MAP.md, Pick
// Editing + Locking) to also support changing an existing, still-editable
// Pick — the same component now serves both "make your first pick" and
// "change your pick" (§25, §34): the buttons stay interactive after a
// successful submission instead of being replaced by static confirmation
// text, until the Pick becomes locked.
//
// Consumer language only — "Make your prediction", the visible team / line
// / Over-Under choices, "You picked" — never Buy/Sell/Trade/Order/Contract/Shares/Position/
// Wallet/Stake/Bet slip, and never a financial-return figure or an amount
// input (this is a belief, not a stake).
//
// Accessibility (roadmap STEP 27): plain <button> elements (native
// keyboard support), the confirmed/disabled/locked states are communicated
// in text — never color alone — and a disabled control always states why
// via `disabledReason` rather than just going inert.

export function PredictionActions({
  marketId,
  disabledReason,
  currentSelection = null,
  choices,
}: {
  marketId: string;
  disabledReason: string | null;
  /** Milestone R5: pass the existing Pick's selection to render this as an editable "change your pick" control instead of a first-time one. */
  currentSelection?: "YES" | "NO" | null;
  /**
   * The two choices in DISPLAY order (lib/prediction-markets/selection-labels.ts). Each carries the canonical outcome it stands for:
   * the wire representation is still "YES"/"NO" (submitPredictionAction receives exactly that), only what is shown changes. Selected state
   * is read from the canonical outcome, never from a label.
   */
  choices: [Choice, Choice];
}) {
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [selection, setSelection] = useState<"YES" | "NO" | null>(currentSelection);
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<{ selectedOutcome: "YES" | "NO" } | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(nextSelection: "YES" | "NO") {
    if (nextSelection === selection || pending || locked) return;
    setPending(true);
    setError(null);
    const result = await submitPredictionAction({ marketId, selectedOutcome: nextSelection, idempotencyKey });
    setPending(false);
    if (result.success && result.confirmation) {
      setSelection(result.confirmation.selectedOutcome);
      setConfirmation(result.confirmation);
      // A fresh key for any FUTURE change — this one has already been
      // consumed, and idempotency keys must never be reused across two
      // genuinely different requests.
      setIdempotencyKey(crypto.randomUUID());
    } else if (result.locked) {
      setLocked(true);
      setError(result.error);
    } else {
      setError(result.error ?? "That prediction couldn't be submitted.");
    }
  }

  if (locked) {
    return (
      <p role="status" className="text-sm font-medium text-text-muted">
        {error ?? "Picks are locked for this game."}
      </p>
    );
  }

  const isDisabled = pending || disabledReason !== null;

  return (
    <div className="space-y-2" data-testid="prediction-actions">
      <p className="text-sm font-semibold text-text-primary">{selection ? "Change your prediction" : "Make your prediction"}</p>
      {/*
        Phase C (Brohda 2.0 redesign, spec §39) fix: at 375px, two buttons
        side by side with long semantic labels ("Home Test NFL do not
        win") overflowed the card rather than wrapping — Button's own base
        class is `whitespace-nowrap`, and a plain `flex gap-3` row has
        nothing to fall back to once both labels' natural widths exceed
        the container. Stacking full-width below `sm` and reverting to an
        inline row (auto width) at `sm`+ guarantees no horizontal overflow
        at any viewport regardless of label length, without truncating or
        wrapping text inside the button itself.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
        {choices.map((choice) => (
          <Button
            key={choice.outcome}
            type="button"
            variant={selection === choice.outcome ? "default" : "outline"}
            size="lg"
            disabled={isDisabled}
            onClick={() => handleSubmit(choice.outcome)}
            aria-label={choice.accessibleName}
            aria-pressed={selection === choice.outcome}
            className="h-auto min-h-9 w-full whitespace-normal text-balance py-2 sm:w-auto sm:max-w-full"
          >
            {choice.label}
          </Button>
        ))}
      </div>
      {confirmation && (
        <p role="status" className="text-sm font-semibold text-text-primary">
          You picked {choices.find((c) => c.outcome === confirmation.selectedOutcome)?.label}.
        </p>
      )}
      {disabledReason && <p className="text-xs text-text-muted">{disabledReason}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
