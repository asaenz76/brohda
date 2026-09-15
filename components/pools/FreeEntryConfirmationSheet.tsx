"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { enterPoolAction, type EnterPoolState } from "@/lib/actions/entries";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { LocalDateTime } from "@/components/LocalDateTime";
import { RulePill } from "./RulePill";
import { SlideToConfirm } from "./SlideToConfirm";

interface FreeEntryConfirmationSheetProps {
  poolId: string;
  optionId: string;
  optionLabel: string;
  ruleLabel: string;
  locksAt: string;
  onClose: () => void;
  onSuccess: () => void;
}

const initialState: EnterPoolState = { error: null, success: false };

// FREE-mode counterpart to EntryConfirmationSheet — deliberately much
// smaller. No entry fee, pot, estimated return, wallet balance, or top-up
// path: FREE_MODE_ARCHITECTURE_PROPOSAL.md §10's whole point is "Pick →
// Confirm → You're in" with zero financial friction, not a version of the
// paid sheet with the numbers hidden. The form never includes an
// amountCents field at all — enterPoolAction treats an absent field as
// null, which create_pool_entry requires for a FREE entry (a non-null
// amount, including 0, is rejected outright).
export function FreeEntryConfirmationSheet({
  poolId,
  optionId,
  optionLabel,
  ruleLabel,
  locksAt,
  onClose,
  onSuccess,
}: FreeEntryConfirmationSheetProps) {
  const [state, formAction, pending] = useActionState(enterPoolAction, initialState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const sheetRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) onSuccess();
  }, [state.success, onSuccess]);

  useFocusTrap(sheetRef, onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm your prediction"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[720px] space-y-4 rounded-t-2xl bg-surface-primary p-5 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-subtle" aria-hidden="true" />

        <div>
          <p className="text-xs text-text-muted">Your pick</p>
          <p className="text-lg font-semibold text-text-primary">{optionLabel}</p>
        </div>

        <RulePill label={ruleLabel} />

        <p className="text-xs text-text-muted">
          Locks{" "}
          <LocalDateTime
            iso={locksAt}
            options={{
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            }}
          />
        </p>

        <form ref={formRef} action={formAction}>
          <input type="hidden" name="poolId" value={poolId} />
          <input type="hidden" name="optionId" value={optionId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <SlideToConfirm pending={pending} onConfirm={() => formRef.current?.requestSubmit()} />
        </form>

        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </div>
  );
}
