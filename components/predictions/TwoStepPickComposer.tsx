"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { attachConfidenceAction, setPickAction } from "@/lib/actions/predictions";
import { confidenceLabel, formatConfidence, ladderFlames, type ConfidenceOffer } from "@/lib/confidence/format";
import type { PickStateName } from "@/lib/predictions/pick-state";
import type { Choice } from "@/lib/prediction-markets/selection-labels";

/**
 * The Brohda 2.1 two-step composer (shown only while optional Picks and the two-step UI flag are both on):
 *
 *   1. Choose a team. That alone makes your pick. You can switch teams until it locks (switching cancels any Call BS challenge that no longer applies, and the other Member is told).
 *   2. Optionally, "How confident are you?" Choosing a level locks your team and fixes the amount — immediately and for good. You never have to.
 *
 * A pick can also be locked by an accepted Call BS; the team stays as it is, and Confidence can still be added before the pick locks. The database decides every deadline, lock and balance; nothing here
 * does — the countdown below only closes the controls at the instant the database would refuse them. This is the M1 composer, not the M4 card redesign: the same two team choices, in the same style.
 */
export function TwoStepPickComposer({
  marketId,
  choices,
  offer,
  disabledReason,
  lockAt = null,
  initialSelection = null,
  pickState = null,
  canChangeTeam = true,
  canAttachConfidence = false,
  hideTitle = false,
  groupLabel,
}: {
  marketId: string;
  choices: [Choice, Choice];
  offer: ConfidenceOffer | null;
  disabledReason: string | null;
  lockAt?: string | null;
  initialSelection?: "YES" | "NO" | null;
  /** The Pick's derived state (lib/predictions/pick-state.ts), null when the Member has no Pick yet. */
  pickState?: PickStateName | null;
  canChangeTeam?: boolean;
  canAttachConfidence?: boolean;
  hideTitle?: boolean;
  groupLabel?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selection, setSelection] = useState<"YES" | "NO" | null>(initialSelection);
  const [hasPick, setHasPick] = useState<boolean>(initialSelection !== null);
  const [teamLocked, setTeamLocked] = useState<boolean>(initialSelection !== null && !canChangeTeam);
  const [saving, setSaving] = useState<"team" | number | null>(null);
  const [committed, setCommitted] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  // One key per Confidence attempt, kept across retries of that attempt (exactly-once). A team tap is a new attempt every time.
  const confidenceKey = useRef(crypto.randomUUID());
  const inFlight = useRef(false);

  useEffect(() => {
    if (!lockAt) return;
    const wait = new Date(lockAt).getTime() - Date.now();
    if (!Number.isFinite(wait) || wait > 2_000_000_000) return;
    const timer = setTimeout(() => {
      setClosed("Picks are locked for this game.");
      startTransition(() => router.refresh());
    }, Math.max(wait, 0));
    return () => clearTimeout(timer);
  }, [lockAt, router]);

  const hintId = `two-step-hint-${marketId}`;
  const statusId = `two-step-status-${marketId}`;
  const selectedLabel = choices.find((c) => c.outcome === selection)?.label;

  if (committed !== null) {
    return (
      <div className="space-y-1" data-slot="prediction-committed">
        <p className="text-sm font-semibold text-text-primary">You picked {selectedLabel}.</p>
        <p className="text-sm font-medium text-text-primary" data-slot="pick-confidence" aria-label={`${confidenceLabel(committed)}, locked`}>
          <span aria-hidden="true">{formatConfidence(committed)} Confidence · Locked</span>
        </p>
        <p className="text-xs text-text-muted">Your team and your Confidence are locked.</p>
      </div>
    );
  }
  if (closed) {
    return (
      <p role="status" className="text-sm font-medium text-text-muted">
        {selectedLabel ? `You picked ${selectedLabel} — ${closed}` : closed}
      </p>
    );
  }

  const balance = available ?? offer?.available ?? 0;
  const stakes = offer?.allowedStakes ?? [];
  const smallest = stakes[0] ?? 1;
  const cannotAfford = offer !== null && balance < smallest;
  const unavailable = offer === null;
  const blocked = disabledReason !== null;
  const canAttach = hasPick && !unavailable && (canAttachConfidence || initialSelection === null);

  async function chooseTeam(outcome: "YES" | "NO") {
    if (inFlight.current || teamLocked || outcome === selection) return;
    inFlight.current = true;
    setSaving("team");
    setError(null);
    setNotice(null);
    let result: Awaited<ReturnType<typeof setPickAction>>;
    try {
      result = await setPickAction({ marketId, selectedOutcome: outcome, idempotencyKey: crypto.randomUUID() });
    } catch {
      result = { success: false, error: "That pick couldn't be saved. Nothing changed — try again.", outcome: "error", closed: false, selection: null, cancelledChallenges: 0 };
    }
    inFlight.current = false;
    setSaving(null);
    if (result.success && result.selection) {
      setSelection(result.selection);
      setHasPick(true);
      if (result.cancelledChallenges > 0) setNotice(result.cancelledChallenges === 1 ? "Your change cancelled a Call BS challenge." : `Your change cancelled ${result.cancelledChallenges} Call BS challenges.`);
      startTransition(() => router.refresh());
      return;
    }
    if (result.selection) setSelection(result.selection);
    if (result.closed) {
      if (result.outcome === "pick_locked") setTeamLocked(true);
      else setClosed(result.error ?? "Picks are locked for this game.");
      startTransition(() => router.refresh());
      if (result.outcome === "pick_locked") setError(result.error ?? "Your pick is locked.");
      return;
    }
    setError(result.error ?? "That pick couldn't be saved.");
  }

  async function chooseConfidence(amount: number) {
    if (!hasPick || inFlight.current) return;
    inFlight.current = true;
    setSaving(amount);
    setError(null);
    let result: Awaited<ReturnType<typeof attachConfidenceAction>>;
    try {
      result = await attachConfidenceAction({ marketId, amount, idempotencyKey: confidenceKey.current });
    } catch {
      result = { success: false, error: "That Confidence couldn't be saved. Nothing changed — try again.", outcome: "error", closed: false, committed: null };
    }
    inFlight.current = false;
    setSaving(null);
    if (result.success && result.committed) {
      setCommitted(result.committed.amount);
      startTransition(() => router.refresh());
      return;
    }
    if (result.closed) {
      setClosed(result.error ?? "Picks are locked for this game.");
      startTransition(() => router.refresh());
      return;
    }
    if (typeof result.available === "number") setAvailable(result.available);
    setError(result.error ?? "That Confidence couldn't be saved.");
  }

  const callBsLocked = pickState === "LOCKED_CALL_BS" || (teamLocked && hasPick);
  return (
    <div className="space-y-3" data-testid="prediction-actions" data-slot="two-step-composer" role={groupLabel ? "group" : undefined} aria-label={groupLabel} aria-busy={saving !== null}>
      {!hideTitle && <p className="text-sm font-semibold text-text-primary">{hasPick ? "Your pick" : "Make your pick"}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3" data-slot="team-choices">
        {choices.map((choice) => (
          <Button
            key={choice.outcome}
            type="button"
            variant={selection === choice.outcome ? "default" : "outline"}
            size="lg"
            disabled={blocked || saving !== null || teamLocked}
            onClick={() => chooseTeam(choice.outcome)}
            aria-label={choice.accessibleName}
            aria-pressed={selection === choice.outcome}
            data-slot="team-choice"
            data-outcome={choice.outcome}
            className="h-auto min-h-9 w-full whitespace-normal text-balance py-2 sm:w-auto sm:max-w-full"
          >
            {choice.label}
          </Button>
        ))}
      </div>
      {hasPick && !callBsLocked && (
        // M7: say plainly that the Pick is made and what it means, before anything else about it (the next lines are about changing it or adding Confidence).
        <p className="text-sm font-medium text-text-primary" data-slot="pick-made" role="status">
          Pick made. It counts toward your Record when the game ends.
        </p>
      )}
      <p id={hintId} className="text-xs text-text-muted" data-slot="team-hint">
        {!hasPick ? "Choose a team to make your pick." : callBsLocked ? "Your team is locked by an accepted Call BS." : "You can change your pick until it locks."}
      </p>

      {hasPick && !unavailable && (
        <div className="space-y-2" data-slot="confidence-composer">
          <p className="text-sm font-semibold text-text-primary">
            How confident are you? <span className="font-normal text-text-muted">(optional)</span>
          </p>
          {canAttach ? (
            cannotAfford ? (
              <p className="text-xs text-text-secondary" data-slot="need-confidence">
                You don&apos;t have enough Confidence to add some right now.{" "}
                {offer?.canClaim && (
                  <Link href="/profile" className="font-medium text-accent-primary underline">
                    Claim your Daily Confidence
                  </Link>
                )}
              </p>
            ) : (
              <p className="text-xs text-text-muted">You have {formatConfidence(balance)} available. Choosing a level locks your team and your Confidence for good.</p>
            )
          ) : (
            <p className="text-xs text-text-muted">Confidence can&apos;t be added to this pick anymore.</p>
          )}
          {canAttach && (
            <div role="group" aria-label={groupLabel ? `How confident are you? ${groupLabel}` : "How confident are you?"} aria-describedby={hintId} className="flex flex-wrap gap-2">
              {stakes.map((n) => {
                const disabled = blocked || cannotAfford || n > balance || saving !== null;
                return (
                  <Button
                    key={n}
                    type="button"
                    size="lg"
                    className="min-h-10 min-w-11"
                    variant={saving === n ? "default" : "outline"}
                    disabled={disabled}
                    aria-label={confidenceLabel(n)}
                    aria-describedby={saving !== null ? statusId : undefined}
                    data-slot="confidence-choice"
                    data-amount={n}
                    onClick={() => chooseConfidence(n)}
                  >
                    <span aria-hidden="true">{ladderFlames(n)}</span>
                  </Button>
                );
              })}
            </div>
          )}
          <p id={statusId} aria-live="polite" className="text-xs text-text-muted" data-slot="composer-status">
            {saving === "team" ? "Saving your pick…" : typeof saving === "number" ? `Saving your ${formatConfidence(saving)} Confidence…` : ""}
          </p>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-text-secondary" data-slot="cancelled-notice">
          {notice}
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
