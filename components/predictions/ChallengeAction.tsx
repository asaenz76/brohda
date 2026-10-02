"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { callBSAction, acceptChallengeAction, declineChallengeAction } from "@/lib/actions/challenges";
import { Button } from "@/components/ui/button";
import type { ChallengeActionState } from "@/lib/challenges/action-state";

// Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges).
// The one interactive control for a single opposing participant row —
// which of Call BS / Pending / Accept-or-Decline / Accepted it renders is
// entirely decided server-side (lib/challenges/action-state.ts, via
// MarketParticipants.tsx) (§47: no financial controls, no stake fields,
// ever).

type StatusKind = "outgoing_pending" | "accepted" | "declined" | "unavailable" | "in_call_bs";

const STATUS: Record<StatusKind, { label: string; className: string }> = {
  outgoing_pending: { label: "Pending", className: "text-text-muted" },
  accepted: { label: "Accepted", className: "text-text-secondary" },
  declined: { label: "Declined", className: "text-text-muted" },
  unavailable: { label: "No longer available", className: "text-text-muted" },
  in_call_bs: { label: "In a Call BS", className: "text-text-muted" },
};

export function ChallengeAction({ marketId, state }: { marketId: string; state: ChallengeActionState }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // What THIS viewer just did on this row (Call BS / Accept / Decline),
  // kept locally so the row reads "Accepted"/"Declined" the instant the
  // action returns and keeps doing so after the server re-renders.
  // Everything else follows the server-rendered `state` prop, so a SIBLING
  // row updates itself when another row's Accept expires it — seeding
  // useState from the prop would freeze every row at its first render and
  // leave a displaced row offering Accept/Decline until a manual reload.
  const [localOutcome, setLocalOutcome] = useState<ChallengeActionState | null>(null);
  // The server's verdict always wins once it is terminal for the pair.
  const current = state.kind === "accepted" || state.kind === "unavailable" ? state : (localOutcome ?? state);

  // Accept/Decline/Call BS unmount the buttons they were triggered from,
  // which would otherwise drop keyboard focus to <body>. After a user
  // action, move focus to the status text that replaces them (it is a
  // role="status" node, so it is also read out). Server-driven changes to a
  // sibling row never steal focus.
  const statusRef = useRef<HTMLSpanElement>(null);
  const focusStatusNext = useRef(false);
  useEffect(() => {
    if (focusStatusNext.current && statusRef.current) {
      statusRef.current.focus();
      focusStatusNext.current = false;
    }
  }, [localOutcome]);

  function settle(next: ChallengeActionState) {
    focusStatusNext.current = true;
    setLocalOutcome(next);
  }

  if (current.kind === "outgoing_pending" || current.kind === "accepted" || current.kind === "declined" || current.kind === "unavailable" || current.kind === "in_call_bs") {
    const { label, className } = STATUS[current.kind];
    return (
      <span
        ref={statusRef}
        tabIndex={-1}
        role="status"
        className={`rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      >
        {label}
      </span>
    );
  }

  if (current.kind === "call_bs") {
    const { recipientPredictionId } = current;
    return (
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <Button
          type="button"
          size="lg"
          variant="outline"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await callBSAction(recipientPredictionId, marketId);
              if (result.error) {
                setError(result.error);
                return;
              }
              settle({ kind: "outgoing_pending" });
            });
          }}
        >
          Call BS
        </Button>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  // incoming_pending
  const { challengeId } = current;
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="lg"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await acceptChallengeAction(challengeId, marketId);
              if (result.error) {
                // A non-null challenge means the server actually evaluated
                // this specific row and found it no longer acceptable
                // (displaced by another Accept, past cutoff, invalidated,
                // or an account became ineligible) — the row's state
                // genuinely changed, so stop offering Accept/Decline
                // rather than leaving a stale, retry-doomed control.
                // A null challenge means a real client/permission error
                // (e.g. a malformed id) with nothing to transition to.
                if (result.challenge) {
                  settle({ kind: "unavailable" });
                  return;
                }
                setError(result.error);
                return;
              }
              settle({ kind: "accepted" });
            });
          }}
        >
          Accept
        </Button>
        <Button
          type="button"
          size="lg"
          variant="ghost"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await declineChallengeAction(challengeId, marketId);
              if (result.error) {
                if (result.challenge) {
                  settle({ kind: "unavailable" });
                  return;
                }
                setError(result.error);
                return;
              }
              settle({ kind: "declined" });
            });
          }}
        >
          Decline
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <p className="max-w-[18rem] text-xs text-text-secondary sm:text-right">Accepting locks both predictions for this game.</p>
    </div>
  );
}
