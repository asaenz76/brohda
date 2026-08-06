"use client";

import { useState } from "react";
import { useActionState } from "react";
import { submitWalletRequestAction, type WalletRequestState } from "@/lib/actions/wallet-requests";
import type { PaymentMethod } from "@/lib/payment-methods/constants";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { DepositFields } from "@/components/wallet/DepositFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: WalletRequestState = { error: null, success: false, idempotencyKey: null };

// Withdrawal mode repurposes the Note field as the payout destination —
// dynamic copy per method so the player knows exactly what to type (their
// Venmo handle vs. a wallet address vs. a cashtag), and so the admin
// reviewing the request knows where to actually send the money.
const WITHDRAWAL_NOTE_COPY: Record<PaymentMethod | "", { label: string; placeholder: string }> = {
  "": { label: "Where should we send your funds?", placeholder: "Select a method first" },
  USDC: { label: "Wallet address & network", placeholder: "e.g. 0xAbc123... on ETH, Solana, etc." },
  USDT: { label: "Wallet address & network", placeholder: "e.g. 0xAbc123... on ETH, Solana, etc." },
  VENMO: { label: "Venmo username", placeholder: "e.g. @yourhandle" },
  CASHAPP: { label: "Cashtag", placeholder: "e.g. $yourhandle" },
  ZELLE: { label: "Zelle email or phone", placeholder: "e.g. you@example.com" },
  OTHER: { label: "Payment details", placeholder: "How should we send your funds?" },
};

export function WalletRequestForm({ paymentMethods }: { paymentMethods: PaymentMethodRow[] }) {
  const [mode, setMode] = useState<"closed" | "deposit" | "withdrawal">("closed");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">("");
  const [state, formAction, pending] = useActionState(submitWalletRequestAction, initialState);

  // Compared against the current idempotencyKey, not used bare — state
  // otherwise persists across closing/reopening this form for a new
  // request, so a stale `success: true` from a previous submission would
  // incorrectly render as "submitted" for an attempt that never happened.
  const justSubmitted = state.success && state.idempotencyKey === idempotencyKey;

  function reset() {
    setMode("closed");
    setIdempotencyKey(crypto.randomUUID());
    setPaymentMethod("");
  }

  if (mode === "closed") {
    return (
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => setMode("deposit")}>
          Add Funds
        </Button>
        <Button type="button" variant="outline" onClick={() => setMode("withdrawal")}>
          Transfer Out
        </Button>
      </div>
    );
  }

  if (justSubmitted) {
    return (
      <div className="space-y-2 rounded-xl border border-border-subtle p-4">
        <p className="text-sm font-medium text-text-primary">Request submitted.</p>
        <p className="text-sm text-text-secondary">Usually reviewed within a few hours.</p>
        <Button type="button" variant="outline" onClick={reset}>
          Make another request
        </Button>
      </div>
    );
  }

  if (paymentMethods.length === 0) {
    return (
      <div className="space-y-2 rounded-xl border border-border-subtle p-4">
        <p className="text-sm font-medium text-text-primary">
          {mode === "deposit" ? "Add Funds" : "Transfer Out"}
        </p>
        <p className="text-sm text-text-secondary">
          No payment methods are available right now — contact an admin.
        </p>
        <Button type="button" variant="outline" onClick={reset}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-xl border border-border-subtle p-4">
      <input type="hidden" name="type" value={mode} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <p className="text-sm font-medium text-text-primary">
        {mode === "deposit" ? "Add Funds" : "Transfer Out"}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="request-amount">Amount ($)</Label>
        <Input
          id="request-amount"
          name="amount"
          placeholder="0.00"
          inputMode="decimal"
          required
          className="w-32"
        />
      </div>

      <DepositFields
        idPrefix="request"
        mode={mode}
        paymentMethods={paymentMethods}
        paymentMethod={paymentMethod}
        onPaymentMethodChange={setPaymentMethod}
      />

      {mode === "withdrawal" ? (
        <div className="space-y-1.5">
          <Label htmlFor="request-note">{WITHDRAWAL_NOTE_COPY[paymentMethod].label}</Label>
          <Input
            id="request-note"
            name="note"
            placeholder={WITHDRAWAL_NOTE_COPY[paymentMethod].placeholder}
            required
            className="w-full"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="request-note">Note (optional)</Label>
          <Input id="request-note" name="note" placeholder="e.g. Venmo sent" className="w-full" />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Submit request"}
        </Button>
        <Button type="button" variant="outline" onClick={reset}>
          Cancel
        </Button>
      </div>
      {state.error && state.idempotencyKey === idempotencyKey && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
