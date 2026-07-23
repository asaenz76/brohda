"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { enterPoolAction, type EnterPoolState } from "@/lib/actions/entries";
import { formatCents } from "@/lib/utils/money";
import { LocalDateTime } from "@/components/LocalDateTime";
import { RulePill } from "./RulePill";
import { SlideToConfirm } from "./SlideToConfirm";

interface EntryConfirmationSheetProps {
  poolId: string;
  optionId: string;
  optionLabel: string;
  ruleLabel: string;
  entryFee: number;
  balanceCents: number;
  locksAt: string;
  onClose: () => void;
  onSuccess: () => void;
}

const initialState: EnterPoolState = { error: null, success: false };

// X.5.7/X.11: focus-trapped bottom sheet. Escape or a backdrop click
// dismisses it; on success the entry is submitted with a stable
// idempotency key generated once per sheet open.
export function EntryConfirmationSheet({
  poolId,
  optionId,
  optionLabel,
  ruleLabel,
  entryFee,
  balanceCents,
  locksAt,
  onClose,
  onSuccess,
}: EntryConfirmationSheetProps) {
  const [state, formAction, pending] = useActionState(enterPoolAction, initialState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const sheetRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) onSuccess();
  }, [state.success, onSuccess]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;

      const focusables = sheetRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const balanceAfter = balanceCents - entryFee;

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
        aria-label="Confirm your entry"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[720px] space-y-4 rounded-t-2xl bg-surface-primary p-5 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-subtle" aria-hidden="true" />

        <div>
          <p className="text-xs text-text-muted">Your choice</p>
          <p className="text-lg font-semibold text-text-primary">{optionLabel}</p>
        </div>

        <RulePill label={ruleLabel} />

        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-text-secondary">Entry Fee × 1</dt>
            <dd className="text-text-primary">{formatCents(entryFee)}</dd>
          </div>
          <div className="flex justify-between font-medium">
            <dt className="text-text-secondary">Total</dt>
            <dd className="text-text-primary">{formatCents(entryFee)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-secondary">Balance after entry</dt>
            <dd className="text-text-primary">{formatCents(balanceAfter)}</dd>
          </div>
        </dl>

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
          <input type="hidden" name="amountCents" value={entryFee} />
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
