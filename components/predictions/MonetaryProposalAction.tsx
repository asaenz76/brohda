"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  proposeMoneyAction,
  acceptMonetaryProposalAction,
  declineMonetaryProposalAction,
  withdrawMonetaryProposalAction,
} from "@/lib/actions/monetary-proposals";
import { formatCents, parseDollarsToCents } from "@/lib/utils/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Milestone R9. The one interactive control for a single opposing
// participant row's money state — mirrors components/predictions/
// ChallengeAction.tsx's own shape exactly: which of composer / pending /
// accept-or-decline / committed it renders is entirely decided
// server-side by MarketParticipants.tsx. Deliberately minimal per the
// task's own "implement only enough to prove the flow" UI-scope guidance —
// no odds/spread controls (equal-stake only, §19).
//
// Milestone R10 (§55) adds the three terminal settlement states below —
// minimal, viewer-relative ("Won"/"Lost"/"Void"), never storing a
// participant-relative status on the Position itself (the backend stays
// bilateral; only this presentation layer picks a perspective).

type MonetaryProposalActionState =
  | { kind: "put_money_on_it"; recipientPredictionId: string }
  | { kind: "outgoing_pending"; proposalId: string; stake: number }
  | { kind: "incoming_pending_funded"; proposalId: string; stake: number }
  | { kind: "incoming_pending_unfunded"; proposalId: string; stake: number }
  | { kind: "committed"; stake: number }
  | { kind: "settled_win"; amount: number }
  | { kind: "settled_loss"; amount: number }
  | { kind: "settled_void" };

export function MonetaryProposalAction({ marketId, state }: { marketId: string; state: MonetaryProposalActionState }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resolvedState, setResolvedState] = useState(state);
  const [amountInput, setAmountInput] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);

  if (resolvedState.kind === "outgoing_pending") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-muted">{formatCents(resolvedState.stake)} pending</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isPending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await withdrawMonetaryProposalAction(resolvedState.proposalId, marketId);
                if (result.error) {
                  setError(result.error);
                  return;
                }
                setResolvedState({ kind: "put_money_on_it", recipientPredictionId: "" });
              });
            }}
          >
            Withdraw
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (resolvedState.kind === "committed") {
    return <span className="text-xs font-medium text-text-secondary">{formatCents(resolvedState.stake)} on the line</span>;
  }

  if (resolvedState.kind === "settled_win") {
    // text-credit/text-debit are this codebase's own dedicated wallet-
    // ledger-direction tokens (app/globals.css) — a settlement win/loss is
    // exactly that, a credit/debit, kept deliberately separate from the
    // legacy pools product's own pool-win/pool-loss tokens.
    return <span className="text-xs font-medium text-credit">Won {formatCents(resolvedState.amount)}</span>;
  }

  if (resolvedState.kind === "settled_loss") {
    return <span className="text-xs font-medium text-debit">Lost {formatCents(resolvedState.amount)}</span>;
  }

  if (resolvedState.kind === "settled_void") {
    return <span className="text-xs font-medium text-text-muted">Void — hold released</span>;
  }

  if (resolvedState.kind === "incoming_pending_unfunded") {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="text-xs text-text-muted">
          {formatCents(resolvedState.stake)} proposed — not enough available balance.{" "}
          <Link href="/wallet" className="underline">
            Fund your wallet
          </Link>{" "}
          to accept.
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await declineMonetaryProposalAction(resolvedState.proposalId, marketId);
              if (result.error) {
                setError(result.error);
                return;
              }
              setResolvedState({ kind: "put_money_on_it", recipientPredictionId: "" });
            });
          }}
        >
          Decline
        </Button>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (resolvedState.kind === "incoming_pending_funded") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-muted">{formatCents(resolvedState.stake)}</span>
          <Button
            type="button"
            size="sm"
            disabled={isPending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await acceptMonetaryProposalAction(resolvedState.proposalId, marketId);
                if (result.error) {
                  setError(result.error);
                  return;
                }
                setResolvedState({ kind: "committed", stake: resolvedState.stake });
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
                const result = await declineMonetaryProposalAction(resolvedState.proposalId, marketId);
                if (result.error) {
                  setError(result.error);
                  return;
                }
                setResolvedState({ kind: "put_money_on_it", recipientPredictionId: "" });
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
      </div>
    );
  }

  // put_money_on_it
  const { recipientPredictionId } = resolvedState;
  if (!composerOpen) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setComposerOpen(true)}>
        Put money on it
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="decimal"
          placeholder="Amount"
          className="w-24"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          disabled={isPending}
        />
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setError(null);
            const stake = parseDollarsToCents(amountInput);
            if (stake === null) {
              setError("Enter a valid dollar amount.");
              return;
            }
            startTransition(async () => {
              const result = await proposeMoneyAction(recipientPredictionId, stake, marketId);
              if (result.error) {
                setError(result.error);
                return;
              }
              setResolvedState({ kind: "outgoing_pending", proposalId: result.proposal!.id, stake: result.proposal!.stake });
            });
          }}
        >
          Send
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={() => setComposerOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
