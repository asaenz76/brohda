"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { commitPredictionAction } from "@/lib/actions/predictions";
import { confidenceLabel, formatConfidence, ladderFlames, type ConfidenceOffer } from "@/lib/confidence/format";
import type { Choice } from "@/lib/prediction-markets/selection-labels";

/**
 * The prediction composer. A prediction is a side AND the Confidence behind it, so nothing exists until both are chosen:
 *
 *   choose a side (local, switch freely)  →  choose Confidence  =  the prediction is made.
 *
 * Tapping a side only changes what is highlighted here — the server never hears about it. Tapping a Confidence level IS the commitment (there is no separate confirm): one database transaction creates the Pick, its stake and
 * the reserve and locks it, or creates nothing. While that runs the levels are disabled and a subtle "Saving…" shows (so a double tap can't make two); the idempotency key makes even a repeat exactly-once. A rejection
 * puts the composer back with the side still chosen; success replaces it with the committed, locked prediction. The database stays the authority on everything (deadline, ladder, balance); nothing here decides eligibility.
 *
 * `legacyOpenPick`: a Pick made before Confidence became part of every prediction that is still open and unbacked. Its side is pre-selected and the Member completes it by choosing a level; it stays a legacy record until then.
 */
export function PredictionComposer({
  marketId,
  choices,
  offer,
  disabledReason,
  initialSelection = null,
  legacyOpenPick = false,
  hideTitle = false,
  groupLabel,
}: {
  marketId: string;
  /** The two choices in DISPLAY order, each carrying the canonical outcome it stands for. Selection is read from the canonical outcome, never from a label. */
  choices: [Choice, Choice];
  /** The ladder and the viewer's available Confidence; null when predictions are unavailable. */
  offer: ConfidenceOffer | null;
  /** Market-level reason a prediction can't be made right now (stale numbers, closed…), or null. */
  disabledReason: string | null;
  initialSelection?: "YES" | "NO" | null;
  legacyOpenPick?: boolean;
  /** A Market shown among others is introduced by the group's single "Make your prediction" title, so it does not repeat its own. */
  hideTitle?: boolean;
  /** The Market's heading ("Game Total 224", "Spread"), naming the group for assistive technology. */
  groupLabel?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selection, setSelection] = useState<"YES" | "NO" | null>(initialSelection);
  const [committing, setCommitting] = useState<number | null>(null);
  const [committed, setCommitted] = useState<{ outcome: "YES" | "NO"; amount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  // One key per composer, kept across retries of the same attempt: the database makes it exactly-once, so a lost response followed by another tap never creates a second prediction.
  const key = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const hintId = `composer-hint-${marketId}`;
  const statusId = `composer-status-${marketId}`;

  if (committed) {
    return (
      <div className="space-y-1" data-slot="prediction-committed">
        <p className="text-sm font-semibold text-text-primary">You picked {choices.find((c) => c.outcome === committed.outcome)?.label}.</p>
        <p className="text-sm font-medium text-text-primary" data-slot="pick-confidence" aria-label={`${confidenceLabel(committed.amount)}, locked`}>
          <span aria-hidden="true">{formatConfidence(committed.amount)} Confidence · Locked</span>
        </p>
      </div>
    );
  }
  if (closed) {
    return (
      <p role="status" className="text-sm font-medium text-text-muted">
        {closed}
      </p>
    );
  }

  const balance = available ?? offer?.available ?? 0;
  const stakes = offer?.allowedStakes ?? [];
  const smallest = stakes[0] ?? 1;
  const cannotAfford = offer !== null && balance < smallest;
  const unavailable = offer === null;
  const blocked = disabledReason !== null || unavailable;

  async function commit(amount: number) {
    if (!selection || inFlight.current) return; // never twice, never without a side
    inFlight.current = true;
    setCommitting(amount);
    setError(null);
    let result: Awaited<ReturnType<typeof commitPredictionAction>>;
    try {
      result = await commitPredictionAction({ marketId, selectedOutcome: selection, amount, idempotencyKey: key.current });
    } catch {
      result = { success: false, error: "That prediction couldn't be submitted. Nothing was saved — try again.", outcome: "error", closed: false, committed: null };
    }
    inFlight.current = false;
    setCommitting(null);
    if (result.success && result.committed) {
      setCommitted({ outcome: result.committed.selectedOutcome, amount: result.committed.amount });
      // The shell balance, the sentiment (revealed only now) and the lock state are re-read in the background; the committed state is already on screen.
      startTransition(() => router.refresh());
      return;
    }
    if (result.closed) {
      setClosed(result.error ?? "Picks are locked for this game.");
      startTransition(() => router.refresh());
      return;
    }
    if (typeof result.available === "number") setAvailable(result.available);
    setError(result.error ?? "That prediction couldn't be submitted.");
  }

  return (
    <div className="space-y-3" data-testid="prediction-actions" role={groupLabel ? "group" : undefined} aria-label={groupLabel} aria-busy={committing !== null}>
      {!hideTitle && <p className="text-sm font-semibold text-text-primary">Make your prediction</p>}
      {legacyOpenPick && (
        <p className="text-xs text-text-secondary" data-slot="legacy-open-pick">
          Your earlier pick isn&apos;t final yet. Choose how confident you are to make it a prediction.
        </p>
      )}
      {/*
        Phase C (Brohda 2.0 redesign, spec §39) fix: at 375px, two buttons side by side with long semantic labels overflowed the card — stacking full-width below `sm` and an inline row (auto width) at `sm`+
        guarantees no horizontal overflow at any viewport regardless of label length, without truncating text inside the button.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
        {choices.map((choice) => (
          <Button
            key={choice.outcome}
            type="button"
            variant={selection === choice.outcome ? "default" : "outline"}
            size="lg"
            disabled={blocked || committing !== null}
            onClick={() => setSelection(choice.outcome)}
            aria-label={choice.accessibleName}
            aria-pressed={selection === choice.outcome}
            className="h-auto min-h-9 w-full whitespace-normal text-balance py-2 sm:w-auto sm:max-w-full"
          >
            {choice.label}
          </Button>
        ))}
      </div>

      {unavailable ? (
        <p className="text-xs text-text-muted" role="status">
          Predictions are paused right now.
        </p>
      ) : (
        <div className="space-y-2" data-slot="confidence-composer">
          <p className="text-sm font-semibold text-text-primary">How confident are you?</p>
          {cannotAfford ? (
            <p className="text-xs text-text-secondary" data-slot="need-confidence">
              You need Confidence to make a prediction.{" "}
              {offer?.canClaim && (
                <Link href="/profile" className="font-medium text-accent-primary underline">
                  Claim your Daily Confidence
                </Link>
              )}
            </p>
          ) : (
            <p id={hintId} className="text-xs text-text-muted">
              {selection ? <>You have {formatConfidence(balance)} available. Choosing a level makes your prediction final.</> : <>Choose a side first, then how confident you are. You have {formatConfidence(balance)} available.</>}
            </p>
          )}
          <div role="group" aria-label={groupLabel ? `How confident are you? ${groupLabel}` : "How confident are you?"} aria-describedby={hintId} className="flex flex-wrap gap-2">
            {stakes.map((n) => {
              const disabled = blocked || cannotAfford || !selection || n > balance || committing !== null;
              return (
                <Button
                  key={n}
                  type="button"
                  size="lg"
                  className="min-h-10 min-w-11"
                  variant={committing === n ? "default" : "outline"}
                  disabled={disabled}
                  aria-label={confidenceLabel(n)}
                  aria-describedby={committing !== null ? statusId : undefined}
                  data-slot="confidence-choice"
                  data-amount={n}
                  onClick={() => commit(n)}
                >
                  <span aria-hidden="true">{ladderFlames(n)}</span>
                </Button>
              );
            })}
          </div>
          <p id={statusId} aria-live="polite" className="text-xs text-text-muted" data-slot="composer-status">
            {committing !== null ? `Saving your ${formatConfidence(committing)} prediction…` : ""}
          </p>
        </div>
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
