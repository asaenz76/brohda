"use client";

import { useActionState, useState } from "react";
import {
  abortReversalAction,
  requestReversalAction,
  type AbortReversalState,
  type RequestReversalState,
} from "@/lib/actions/reversal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const requestInitialState: RequestReversalState = { error: null };
const abortInitialState: AbortReversalState = { error: null };

interface ReversalRequestFormProps {
  poolId: string;
  defaultReason?: string;
  submitLabel?: string;
}

// Spec §17: one admin action ("request reversal with a reason") — the
// dry-run-then-execute-or-block decision happens entirely server-side in
// reverse_pool_settlement; this form just reflects whichever status the
// pool lands on afterward (the page re-renders around it).
export function ReversalRequestForm({
  poolId,
  defaultReason = "",
  submitLabel = "Request Reversal",
}: ReversalRequestFormProps) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(requestReversalAction, requestInitialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="poolId" value={poolId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="space-y-1.5">
        <Label htmlFor="reversal-reason">Reason (required)</Label>
        <Input id="reversal-reason" name="reason" defaultValue={defaultReason} required />
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Processing…" : submitLabel}
      </Button>
    </form>
  );
}

export function AbortReversalButton({ poolId }: { poolId: string }) {
  const [state, formAction, pending] = useActionState(abortReversalAction, abortInitialState);

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="poolId" value={poolId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Aborting…" : "Abort (Keep Settled)"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
