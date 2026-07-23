"use client";

import { useActionState, useState } from "react";
import { depositAction, withdrawAction, type WalletAdjustmentState } from "@/lib/actions/wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: WalletAdjustmentState = { error: null };

/**
 * Give this a `key` tied to the user's balance from the parent list — same
 * reasoning as ToggleActiveForm: a successful deposit/withdrawal changes the
 * balance, which changes the key, which remounts this component back to its
 * closed state instead of needing an effect.
 */
export function WalletAdjustmentForm({ userId }: { userId: string }) {
  const [mode, setMode] = useState<"closed" | "deposit" | "withdraw">("closed");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(
    mode === "withdraw" ? withdrawAction : depositAction,
    initialState,
  );

  if (mode === "closed") {
    return (
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setMode("deposit")}>
          Deposit
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setMode("withdraw")}>
          Withdraw
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Input
        name="amount"
        placeholder="0.00"
        inputMode="decimal"
        required
        className="h-8 w-20 text-xs"
      />
      <Input name="reason" placeholder="Reason (required)" required className="h-8 w-36 text-xs" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : mode === "withdraw" ? "Withdraw" : "Deposit"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
