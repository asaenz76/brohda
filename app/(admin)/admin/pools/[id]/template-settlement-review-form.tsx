"use client";

import { useActionState, useState } from "react";
import {
  confirmTemplateSettlementAction,
  type ConfirmTemplateSettlementState,
} from "@/lib/actions/pool-templates";
import { formatCents } from "@/lib/utils/money";
import { Button } from "@/components/ui/button";

const initialState: ConfirmTemplateSettlementState = { error: null };

interface TemplateSettlementReviewFormProps {
  poolId: string;
  gradingVersion: number;
  winningOptionLabel: string;
  gradingReason: string;
  winningEntryCount: number;
  totalEntries: number;
  grossPool: number;
  houseFeeBps: number;
}

/**
 * Read-only "already graded, just confirm" screen — mirrors
 * ComboSettlementReviewForm's exact pattern, since gradeTemplatePool has
 * already determined the winner from the template's own gradingRule (no
 * dropdown needed, unlike the generic SettlementReviewForm). Re-derives
 * everything server-side on submit (confirmTemplateSettlementAction), so a
 * stale preview can only show a wrong preview, never cause a wrong payout.
 */
export function TemplateSettlementReviewForm({
  poolId,
  gradingVersion,
  winningOptionLabel,
  gradingReason,
  winningEntryCount,
  totalEntries,
  grossPool,
  houseFeeBps,
}: TemplateSettlementReviewFormProps) {
  const [state, formAction, pending] = useActionState(confirmTemplateSettlementAction, initialState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  let message: string;
  let buttonLabel: string;

  if (totalEntries === 0) {
    message = `"${winningOptionLabel}" was the graded result, but nobody entered this pool — there's nothing to refund. Confirming just closes it out.`;
    buttonLabel = "Grade Pool";
  } else if (winningEntryCount === 0) {
    message = `"${winningOptionLabel}" won, but nobody picked it. Confirming will refund every entry in full — no platform fee taken.`;
    buttonLabel = "Confirm Refund";
  } else if (winningEntryCount === totalEntries) {
    message = `"${winningOptionLabel}" won and every entry picked it — a push. Confirming will refund every entry in full, no platform fee taken.`;
    buttonLabel = "Confirm Refund";
  } else {
    const houseFee = Math.floor((grossPool * houseFeeBps) / 10000);
    const netPool = grossPool - houseFee;
    const payoutPerEntry = Math.floor(netPool / winningEntryCount);
    message = `"${winningOptionLabel}" won. Confirming will pay ${formatCents(payoutPerEntry)} to each of ${winningEntryCount} winner(s) and collect ${formatCents(houseFee)} platform fee from a ${formatCents(grossPool)} pool.`;
    buttonLabel = "Confirm Settlement";
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="poolId" value={poolId} />
      <input type="hidden" name="gradingVersion" value={gradingVersion} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div className="space-y-1 rounded-lg bg-warning-muted/10 px-3 py-2">
        <p className="text-sm text-text-primary">{message}</p>
        <p className="text-xs text-text-muted">Auto-graded: {gradingReason}</p>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? "Confirming…" : buttonLabel}
      </Button>
    </form>
  );
}
