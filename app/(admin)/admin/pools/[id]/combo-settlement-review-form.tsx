"use client";

import { useActionState, useState } from "react";
import {
  confirmComboSettlementAction,
  type ConfirmComboSettlementState,
} from "@/lib/actions/pool-combo";
import { formatCents } from "@/lib/utils/money";
import { Button } from "@/components/ui/button";

const initialState: ConfirmComboSettlementState = { error: null };

interface ComboSettlementReviewFormProps {
  poolId: string;
  gradingVersion: number;
  /** True if any leg was marked "did not play" — an absolute override, void
   *  regardless of everything else below. */
  didNotPlay: boolean;
  /** Null only if grading hasn't actually stamped a winner yet (e.g. the
   *  pool was graded via the generic "Grade manually" override instead of
   *  the leg checkboxes) — page.tsx doesn't render this component in that
   *  case, this is just a defensive fallback. */
  winningOptionLabel: string | null;
  winningEntryCount: number | null;
  totalEntries: number;
  grossPool: number;
  houseFeeBps: number;
}

/**
 * The confirmation step Gemini's review flagged as missing: previously
 * ComboLegGradingForm graded and settled in one click with no preview.
 * Grading now stops at READY_FOR_REVIEW (gradeComboLegsAction) and this
 * form shows exactly what confirming will do — computed the same way
 * confirm_pool_settlement computes it — before the admin commits to it.
 * Re-derives everything server-side on submit rather than trusting these
 * numbers (see confirmComboSettlementAction), so a stale preview can't
 * cause a wrong payout — it can only show a wrong preview, which the admin
 * would notice and refresh.
 */
export function ComboSettlementReviewForm({
  poolId,
  gradingVersion,
  didNotPlay,
  winningOptionLabel,
  winningEntryCount,
  totalEntries,
  grossPool,
  houseFeeBps,
}: ComboSettlementReviewFormProps) {
  const [state, formAction, pending] = useActionState(confirmComboSettlementAction, initialState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  let message: string;
  let buttonLabel: string;

  if (didNotPlay) {
    message =
      "A featured condition was marked “did not play.” Confirming will void this pool and refund every entry in full — no coordinator fee taken, no matter how the other conditions graded.";
    buttonLabel = "Confirm Void";
  } else if (winningOptionLabel == null) {
    message = "This pool hasn't been graded yet — go back and grade it first.";
    buttonLabel = "Confirm";
  } else if (totalEntries === 0) {
    message = `"${winningOptionLabel}" was the graded result, but nobody entered this pool — there's nothing to refund. Confirming just closes it out.`;
    buttonLabel = "Grade Pool";
  } else if (winningEntryCount === 0) {
    message = `"${winningOptionLabel}" won, but nobody picked it. Confirming will refund every entry in full — no coordinator fee taken.`;
    buttonLabel = "Confirm Refund";
  } else if (winningEntryCount === totalEntries) {
    message = `"${winningOptionLabel}" won and every entry picked it — a push. Confirming will refund every entry in full, no coordinator fee taken.`;
    buttonLabel = "Confirm Refund";
  } else {
    const houseFee = Math.floor((grossPool * houseFeeBps) / 10000);
    const netPool = grossPool - houseFee;
    const payoutPerEntry = Math.floor(netPool / (winningEntryCount as number));
    message = `"${winningOptionLabel}" won. Confirming will pay ${formatCents(payoutPerEntry)} to each of ${winningEntryCount} winner(s) and collect ${formatCents(houseFee)} coordinator fee from a ${formatCents(grossPool)} pool.`;
    buttonLabel = "Confirm Settlement";
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="poolId" value={poolId} />
      <input type="hidden" name="gradingVersion" value={gradingVersion} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <p className="rounded-lg bg-warning-muted/10 px-3 py-2 text-sm text-text-primary">{message}</p>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending || winningOptionLabel == null}>
        {pending ? "Confirming…" : buttonLabel}
      </Button>
    </form>
  );
}
