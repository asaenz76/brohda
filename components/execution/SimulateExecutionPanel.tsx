"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestQuoteAction, confirmSimulationAction, type RequestQuoteState } from "@/lib/actions/execution";

// Milestone 5's only consumer execution UI (roadmap-adjacent STEP 15/16).
// Visually and structurally distinct from Prediction (components/predictions/) —
// this never touches Prediction state, and a user may simulate execution
// without it changing their Prediction history. Every screen states
// plainly that this is simulated and moves no money — never presented as
// a real trade.

type Quote = NonNullable<RequestQuoteState["quote"]>;
type Phase = "idle" | "quoted" | "filled" | "rejected";

function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function SimulateExecutionPanel({ marketId }: { marketId: string }) {
  const [side, setSide] = useState<"YES" | "NO" | null>(null);
  const [amountInput, setAmountInput] = useState("10.00");
  const [phase, setPhase] = useState<Phase>("idle");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [rejectionMessage, setRejectionMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function handleGetQuote() {
    if (!side) return;
    const dollars = Number.parseFloat(amountInput);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await requestQuoteAction({ marketId, selectedSide: side, requestedAmountCents: Math.round(dollars * 100) });
    setPending(false);
    if (result.success && result.quote) {
      setQuote(result.quote);
      setPhase("quoted");
    } else {
      setError(result.error ?? "That quote couldn't be created.");
    }
  }

  async function handleConfirm() {
    if (!quote) return;
    setPending(true);
    setError(null);
    const result = await confirmSimulationAction({ quoteId: quote.id, idempotencyKey });
    setPending(false);
    if (result.success && result.result) {
      if (result.result.lifecycleState === "SIMULATED_FILLED") {
        setPhase("filled");
      } else {
        setRejectionMessage(result.error);
        setPhase("rejected");
      }
    } else {
      setError(result.error ?? "That simulation couldn't be confirmed.");
    }
  }

  function reset() {
    setSide(null);
    setPhase("idle");
    setQuote(null);
    setRejectionMessage(null);
    setError(null);
  }

  return (
    <div className="space-y-3 rounded-lg border-2 border-dashed border-border-subtle p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Simulation — practice execution, no money will move</p>

      {phase === "idle" && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-text-primary">Try a simulated execution</p>
          <div className="flex gap-2">
            <Button type="button" variant={side === "YES" ? "default" : "outline"} size="sm" onClick={() => setSide("YES")}>
              YES
            </Button>
            <Button type="button" variant={side === "NO" ? "default" : "outline"} size="sm" onClick={() => setSide("NO")}>
              NO
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="execution-amount" className="text-sm text-text-secondary">
              Amount ($)
            </label>
            <Input
              id="execution-amount"
              type="number"
              min="0"
              step="0.01"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className="w-28"
            />
          </div>
          <Button type="button" size="sm" disabled={!side || pending} onClick={handleGetQuote}>
            Get simulated quote
          </Button>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}

      {phase === "quoted" && quote && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-text-primary">Review your simulated {quote.selectedSide} prediction</p>
          <p className="text-sm text-text-secondary">Amount: ${centsToDisplay(quote.requestedAmountCents)}</p>
          <p className="text-sm text-text-secondary">Current chance: {Math.round(quote.currentPrice * 100)}%</p>
          <p className="text-sm text-text-secondary">Effective simulated price: {Math.round(quote.effectivePrice * 100)}%</p>
          <p className="text-sm text-text-secondary">Estimated simulated return: ${centsToDisplay(quote.estimatedGrossReturnCents)}</p>
          <p className="text-sm text-text-secondary">Estimated simulated fees: ${centsToDisplay(quote.totalFeeEstimateCents)}</p>
          {quote.estimatedSlippageBps > 0 && (
            <p className="text-xs text-text-muted">Estimated simulated price impact: {(quote.estimatedSlippageBps / 100).toFixed(2)}%</p>
          )}
          <p className="text-xs text-text-muted">Quote expires at {new Date(quote.expiresAt).toLocaleTimeString()}.</p>
          <p className="text-xs font-medium text-text-muted">This is a simulation. No real money moves and no real order is placed.</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={handleConfirm}>
              Confirm simulation
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              Cancel
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}

      {phase === "filled" && quote && (
        <div className="space-y-2">
          <p role="status" className="text-sm font-semibold text-text-primary">
            Simulated {quote.selectedSide} prediction recorded
          </p>
          <p className="text-xs text-text-muted">This was a simulation. No real money moved and no real order was placed.</p>
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Simulate another
          </Button>
        </div>
      )}

      {phase === "rejected" && (
        <div className="space-y-2">
          <p role="status" className="text-sm font-semibold text-text-primary">
            Simulation not confirmed
          </p>
          <p className="text-xs text-text-muted">{rejectionMessage}</p>
          <Button type="button" size="sm" onClick={reset}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
