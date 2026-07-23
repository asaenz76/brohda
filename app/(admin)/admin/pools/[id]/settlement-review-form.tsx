"use client";

import { useActionState, useState } from "react";
import {
  confirmPoolRefundAction,
  confirmSettlementAction,
  type ConfirmPoolRefundState,
  type ConfirmSettlementState,
} from "@/lib/actions/settlements";
import { Button } from "@/components/ui/button";

const settlementInitialState: ConfirmSettlementState = { error: null };
const refundInitialState: ConfirmPoolRefundState = { error: null };

interface SettlementReviewFormProps {
  poolId: string;
  gradingVersion: number;
  outcome: "NORMAL" | "NO_WINNING_ENTRIES_REFUND" | "ALL_ENTRIES_WINNING_REFUND";
  requiresManualVerification: boolean;
  options: Array<{ id: string; label: string }>;
  /** Set only when a winner has already been determined despite the
   *  zero-entries/all-entries refund outcome — currently just a COMBO pool
   *  graded via its leg checkboxes with nobody entered. Distinguishes "the
   *  correct answer is known, there's just nobody to pay" from a genuine
   *  refund of real money back to real entrants, so the copy/button below
   *  doesn't call the former a "refund" when nothing is actually moving. */
  gradedWinningOptionLabel?: string | null;
}

export function SettlementReviewForm({
  poolId,
  gradingVersion,
  outcome,
  requiresManualVerification,
  options,
  gradedWinningOptionLabel = null,
}: SettlementReviewFormProps) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [settlementState, settlementFormAction, settlementPending] = useActionState(
    confirmSettlementAction,
    settlementInitialState,
  );
  const [refundState, refundFormAction, refundPending] = useActionState(
    confirmPoolRefundAction,
    refundInitialState,
  );
  const [winningOptionId, setWinningOptionId] = useState("");

  if (outcome !== "NORMAL") {
    const voidReason = outcome === "NO_WINNING_ENTRIES_REFUND" ? "NO_WINNING_ENTRIES" : "ALL_ENTRIES_WINNING";
    // Nobody entered this pool at all, but the admin's own grading (a
    // COMBO's leg checkboxes) already determined the correct side — there's
    // no real money to refund, so this isn't really a "refund" at all, just
    // recording the graded result and closing the pool out.
    const isGradedWithNoEntries = gradedWinningOptionLabel != null;

    return (
      <form action={refundFormAction} className="space-y-3">
        <input type="hidden" name="poolId" value={poolId} />
        <input type="hidden" name="gradingVersion" value={gradingVersion} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <input type="hidden" name="voidReason" value={voidReason} />

        <p className="rounded-lg bg-warning-muted/10 px-3 py-2 text-sm text-text-primary">
          {isGradedWithNoEntries
            ? `"${gradedWinningOptionLabel}" was the graded result, but nobody entered this pool — there's nothing to refund. Confirming just closes it out.`
            : outcome === "NO_WINNING_ENTRIES_REFUND"
              ? "No valid entry selected the winning option. Proposing a full refund — no coordinator fee taken."
              : "Every valid entry selected the winning option. Proposing a full refund — no coordinator fee taken."}
        </p>

        {refundState.error && (
          <p role="alert" className="text-sm text-danger">
            {refundState.error}
          </p>
        )}

        <Button type="submit" disabled={refundPending}>
          {refundPending ? "Grading…" : isGradedWithNoEntries ? "Grade Pool" : "Confirm Refund"}
        </Button>
      </form>
    );
  }

  return (
    <form action={settlementFormAction} className="space-y-3">
      <input type="hidden" name="poolId" value={poolId} />
      <input type="hidden" name="gradingVersion" value={gradingVersion} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {requiresManualVerification && (
        <div className="space-y-1.5">
          <p className="rounded-lg bg-warning-muted/10 px-3 py-2 text-sm text-text-primary">
            The provider&rsquo;s result couldn&rsquo;t be automatically interpreted. Pick the
            winning option to continue.
          </p>
          <select
            name="winningOptionId"
            required
            value={winningOptionId}
            onChange={(e) => setWinningOptionId(e.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="" disabled>
              Select the winning option…
            </option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {settlementState.error && (
        <p role="alert" className="text-sm text-danger">
          {settlementState.error}
        </p>
      )}

      <Button
        type="submit"
        disabled={settlementPending || (requiresManualVerification && !winningOptionId)}
      >
        {settlementPending ? "Settling…" : "Confirm Settlement"}
      </Button>
    </form>
  );
}
