"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  proposeMoneyAction,
  acceptMonetaryProposalAction,
  declineMonetaryProposalAction,
  withdrawMonetaryProposalAction,
} from "@/lib/actions/monetary-proposals";
import { formatBpsAsPercent, formatCents, parseDollarsToCents } from "@/lib/utils/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MonetaryActionState } from "@/lib/monetary/action-state";

// Milestone R9. The one interactive control for a single opposing
// participant row's money state — mirrors components/predictions/
// ChallengeAction.tsx: which of composer / pending / accept-or-decline /
// committed it renders is decided server-side (lib/monetary/action-state.ts,
// via MarketParticipants.tsx). Equal-stake only (§19).
//
// Milestone R10 (§55) adds the three terminal settlement states — minimal,
// viewer-relative ("Won"/"Lost"/"Void"), never storing a participant-
// relative status on the Position itself.
//
// Monetary hardening: this is real money, so nothing here is a casual
// social tap. Sending states up front that the amount is held immediately;
// accepting takes an explicit confirmation naming the stake, the opponent,
// both picks and the consequence; and the row follows the server-rendered
// state (it used to freeze its first render in useState, so it could keep
// offering Accept on a proposal that had since expired).

export interface MonetaryActionContext {
  opponentName: string;
  /** Semantic side labels ("Eagles win"), never the raw YES/NO enum. */
  yourPickLabel: string;
  theirPickLabel: string;
  /** Current platform fee in basis points — presentation only; the Position snapshots its own at acceptance. */
  feeBps: number;
  /** The viewer's spendable balance right now (total minus holds). */
  availableCents: number;
}

type LocalOutcome =
  | { kind: "outgoing_pending"; proposalId: string; stake: number }
  | { kind: "committed"; stake: number }
  | { kind: "declined" }
  | { kind: "withdrawn" };

export function MonetaryProposalAction({ marketId, state, context }: { marketId: string; state: MonetaryActionState; context: MonetaryActionContext }) {
  const { opponentName, yourPickLabel, theirPickLabel, feeBps, availableCents } = context;
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [localOutcome, setLocalOutcome] = useState<LocalOutcome | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const amountId = useId();
  const helpId = useId();

  // The server's verdict wins once it is terminal for this pair; otherwise
  // what this viewer just did stays on screen until the server catches up.
  const serverIsTerminal = state.kind === "committed" || state.kind === "expired" || state.kind.startsWith("settled_");
  const current: MonetaryActionState | LocalOutcome = serverIsTerminal ? state : (localOutcome ?? state);

  // Actions replace the buttons they were triggered from; move focus to the
  // status text that replaces them (a role="status" node) so keyboard focus
  // is not dropped to <body>. Server-driven changes never steal focus.
  const statusRef = useRef<HTMLSpanElement>(null);
  const focusStatusNext = useRef(false);
  useEffect(() => {
    if (focusStatusNext.current && statusRef.current) {
      statusRef.current.focus();
      focusStatusNext.current = false;
    }
  }, [localOutcome]);

  function settle(next: LocalOutcome) {
    focusStatusNext.current = true;
    setConfirming(false);
    setLocalOutcome(next);
  }

  const statusClass = "rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const status = (className: string, text: string) => (
    <span ref={statusRef} tabIndex={-1} role="status" className={`${statusClass} ${className}`}>
      {text}
    </span>
  );
  const alertLine = error && (
    <p role="alert" className="text-xs text-danger">
      {error}
    </p>
  );
  const feeNote = feeBps > 0 ? `, minus a ${formatBpsAsPercent(feeBps)} fee` : "";

  if (current.kind === "outgoing_pending") {
    const { proposalId, stake } = current;
    return (
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <div className="flex flex-wrap items-center gap-2">
          <span ref={statusRef} tabIndex={-1} role="status" className={`${statusClass} text-text-muted`}>
            {formatCents(stake)} pending — held until {opponentName} answers
          </span>
          <Button
            type="button"
            size="lg"
            variant="ghost"
            disabled={isPending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await withdrawMonetaryProposalAction(proposalId, marketId);
                if (result.error) {
                  setError(result.error);
                  return;
                }
                settle({ kind: "withdrawn" });
              });
            }}
          >
            Withdraw
          </Button>
        </div>
        {alertLine}
      </div>
    );
  }

  if (current.kind === "committed") return <span className="text-xs font-medium text-text-secondary">{formatCents(current.stake)} on the line</span>;
  // Won/Lost carry their sign in words, not only in colour.
  if (current.kind === "settled_win") return <span className="text-xs font-medium text-credit">Won {formatCents(current.amount)}</span>;
  if (current.kind === "settled_loss") return <span className="text-xs font-medium text-debit">Lost {formatCents(current.amount)}</span>;
  if (current.kind === "settled_void") return <span className="text-xs font-medium text-text-muted">Void — hold released</span>;
  if (current.kind === "expired") return <span className="text-xs font-medium text-text-muted">{formatCents(current.stake)} proposal expired — any hold is released</span>;
  if (current.kind === "declined") return status("text-text-muted", "Declined — nothing was held");
  if (current.kind === "withdrawn") return status("text-text-muted", "Withdrawn — your hold was released");

  if (current.kind === "incoming_pending_unfunded") {
    const { proposalId, stake } = current;
    const shortfall = Math.max(stake - availableCents, 0);
    return (
      <div className="flex max-w-[20rem] flex-col items-start gap-1 sm:items-end sm:text-right">
        <p className="text-xs text-text-secondary">
          <span className="font-medium text-text-primary">
            {opponentName} put {formatCents(stake)} on it.
          </span>{" "}
          You have {formatCents(availableCents)} available — not enough available balance. Add at least {formatCents(shortfall)}.{" "}
          <Link href="/wallet" className="underline">
            Fund your wallet
          </Link>
          , then come back and tap Accept — funding never accepts it for you.
        </p>
        <Button
          type="button"
          size="lg"
          variant="ghost"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await declineMonetaryProposalAction(proposalId, marketId);
              if (result.error) {
                setError(result.error);
                return;
              }
              settle({ kind: "declined" });
            });
          }}
        >
          Decline
        </Button>
        {alertLine}
      </div>
    );
  }

  if (current.kind === "incoming_pending_funded") {
    const { proposalId, stake } = current;
    if (confirming) {
      return (
        <div role="group" aria-label={`Confirm ${formatCents(stake)} against ${opponentName}`} className="flex max-w-[20rem] flex-col items-start gap-2 rounded-lg border border-border-strong p-3 sm:items-end sm:text-right">
          <p className="text-sm font-medium text-text-primary">
            Accept {formatCents(stake)} against {opponentName}?
          </p>
          <p className="text-xs text-text-secondary">
            You picked {yourPickLabel}. {opponentName} picked {theirPickLabel}.
          </p>
          <p className="text-xs text-text-secondary">
            This is real money. {formatCents(stake)} of your balance is held as soon as you confirm. If you win, you get {formatCents(stake)} from {opponentName}
            {feeNote}. If you lose, you pay {formatCents(stake)}. It can&apos;t be undone.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="lg"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await acceptMonetaryProposalAction(proposalId, marketId);
                  if (result.error) {
                    setConfirming(false);
                    setError(result.error);
                    return;
                  }
                  settle({ kind: "committed", stake });
                });
              }}
            >
              Confirm — put {formatCents(stake)} on it
            </Button>
            <Button type="button" size="lg" variant="ghost" disabled={isPending} onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
          {alertLine}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <p className="text-xs text-text-secondary">
          <span className="font-medium text-text-primary">
            {opponentName} put {formatCents(stake)} on it.
          </span>{" "}
          Matching it holds {formatCents(stake)} of your balance.
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="lg"
            disabled={isPending}
            onClick={() => {
              setError(null);
              setConfirming(true);
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
                const result = await declineMonetaryProposalAction(proposalId, marketId);
                if (result.error) {
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
        {alertLine}
      </div>
    );
  }

  // put_money_on_it
  const { recipientPredictionId } = current;
  if (!composerOpen) {
    return (
      <Button type="button" size="lg" variant="outline" onClick={() => setComposerOpen(true)}>
        Put money on it
      </Button>
    );
  }

  const parsedStake = parseDollarsToCents(amountInput);
  const overBalance = parsedStake !== null && parsedStake > availableCents;
  return (
    <div className="flex max-w-[20rem] flex-col items-start gap-2 sm:items-end sm:text-right">
      <label htmlFor={amountId} className="text-xs font-medium text-text-primary">
        Amount to put on it (USD)
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={amountId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="Amount"
          aria-describedby={helpId}
          aria-invalid={overBalance || undefined}
          className="h-9 w-28"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          disabled={isPending}
        />
        <Button
          type="button"
          size="lg"
          disabled={isPending || overBalance}
          onClick={() => {
            setError(null);
            if (parsedStake === null) {
              setError("Enter a valid dollar amount.");
              return;
            }
            startTransition(async () => {
              const result = await proposeMoneyAction(recipientPredictionId, parsedStake, marketId);
              if (result.error) {
                setError(result.error);
                return;
              }
              settle({ kind: "outgoing_pending", proposalId: result.proposal!.id, stake: result.proposal!.stake });
            });
          }}
        >
          {parsedStake !== null && !overBalance ? `Send ${formatCents(parsedStake)}` : "Send"}
        </Button>
        <Button type="button" size="lg" variant="ghost" disabled={isPending} onClick={() => setComposerOpen(false)}>
          Cancel
        </Button>
      </div>
      <p id={helpId} className="text-xs text-text-secondary">
        {overBalance
          ? `That's more than the ${formatCents(availableCents)} you have available.`
          : `You have ${formatCents(availableCents)} available. Sending holds this amount from your balance until ${opponentName} accepts or declines, or you withdraw. If they accept and you lose, you pay it.`}
      </p>
      {alertLine}
    </div>
  );
}
