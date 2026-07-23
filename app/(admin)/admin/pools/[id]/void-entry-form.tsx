"use client";

import { useActionState, useState } from "react";
import { voidEntryAction, type VoidEntryState } from "@/lib/actions/pools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: VoidEntryState = { error: null };

// Same inline-expand pattern as ToggleActiveForm/WalletAdjustmentForm —
// keyed by entry status in the parent so a successful void remounts this
// back to closed.
export function VoidEntryForm({ entryId }: { entryId: string }) {
  const [state, formAction, pending] = useActionState(voidEntryAction, initialState);
  const [open, setOpen] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Void
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Input name="reason" placeholder="Reason (required)" required className="h-8 w-40 text-xs" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Voiding…" : "Confirm"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
