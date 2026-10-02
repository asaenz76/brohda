"use client";

import { useState, useTransition } from "react";
import { callBSAction, acceptChallengeAction, declineChallengeAction } from "@/lib/actions/challenges";
import { Button } from "@/components/ui/button";

// Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges).
// The one interactive control for a single opposing participant row —
// which of Call BS / Pending / Accept-or-Decline / Accepted it renders is
// entirely decided server-side by MarketParticipants.tsx (§47: no
// financial controls, no stake fields, ever).

type ChallengeActionState =
  | { kind: "call_bs"; recipientPredictionId: string }
  | { kind: "outgoing_pending" }
  | { kind: "incoming_pending"; challengeId: string }
  | { kind: "accepted" }
  | { kind: "declined" }
  // Exclusivity addendum: a PENDING challenge this viewer was tracking
  // became EXPIRED without ever being declined or hitting cutoff from
  // THIS viewer's own action — most commonly because one of its two
  // participants accepted a different Call BS on this Market first. The
  // exact reason is never fabricated (EXPIRED alone doesn't distinguish
  // cutoff/edit-invalidation/displacement — see accept_call_bs()'s own
  // comment), so this one generic state covers all of them.
  | { kind: "unavailable" };

export function ChallengeAction({ marketId, state }: { marketId: string; state: ChallengeActionState }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resolvedState, setResolvedState] = useState(state);

  if (resolvedState.kind === "outgoing_pending") {
    return <span className="text-xs font-medium text-text-muted">Pending</span>;
  }

  if (resolvedState.kind === "accepted") {
    return <span className="text-xs font-medium text-text-secondary">Accepted</span>;
  }

  if (resolvedState.kind === "declined") {
    return <span className="text-xs font-medium text-text-muted">Declined</span>;
  }

  if (resolvedState.kind === "unavailable") {
    return <span className="text-xs font-medium text-text-muted">No longer available</span>;
  }

  if (resolvedState.kind === "call_bs") {
    const { recipientPredictionId } = resolvedState;
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          type="button"
          size="sm"
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
              setResolvedState({ kind: "outgoing_pending" });
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
  const { challengeId } = resolvedState;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
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
                  setResolvedState({ kind: "unavailable" });
                  return;
                }
                setError(result.error);
                return;
              }
              setResolvedState({ kind: "accepted" });
            });
          }}
        >
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await declineChallengeAction(challengeId, marketId);
              if (result.error) {
                if (result.challenge) {
                  setResolvedState({ kind: "unavailable" });
                  return;
                }
                setError(result.error);
                return;
              }
              setResolvedState({ kind: "declined" });
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
      <p className="text-[11px] text-text-muted">Accepting locks both predictions for this game.</p>
    </div>
  );
}
