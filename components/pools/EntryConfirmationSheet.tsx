"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { enterPoolAction, type EnterPoolState } from "@/lib/actions/entries";
import { formatCents, formatBps } from "@/lib/utils/money";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { LocalDateTime } from "@/components/LocalDateTime";
import { RulePill } from "./RulePill";
import { SlideToConfirm } from "./SlideToConfirm";

interface EntryConfirmationSheetProps {
  poolId: string;
  optionId: string;
  optionLabel: string;
  ruleLabel: string;
  entryFee: number;
  houseFeeBasisPoints: number;
  balanceCents: number;
  locksAt: string;
  /** Sibling tiers of the same fee-tier group (see TieredPoolCard), sorted
   *  ascending by entryFee, including the tier this sheet was opened from.
   *  When there's more than one, the "Entry Fee" row becomes a dropdown so
   *  the user can pick a different amount without leaving the sheet —
   *  matched across tiers by option label, since each tier is a distinct
   *  pool with its own option rows (see 20260101000122). Omit for an
   *  ordinary, non-tiered pool. */
  tiers?: Array<{ poolId: string; entryFee: number; options: Array<{ optionId: string; label: string }> }>;
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
  houseFeeBasisPoints,
  balanceCents,
  locksAt,
  tiers,
  onClose,
  onSuccess,
}: EntryConfirmationSheetProps) {
  const [state, formAction, pending] = useActionState(enterPoolAction, initialState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const sheetRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [activeTierPoolId, setActiveTierPoolId] = useState(poolId);

  useEffect(() => {
    if (state.success) onSuccess();
  }, [state.success, onSuccess]);

  useFocusTrap(sheetRef, onClose);

  const hasTierChoice = (tiers?.length ?? 0) > 1;
  const activeTier = hasTierChoice ? tiers!.find((t) => t.poolId === activeTierPoolId) : null;
  const effectivePoolId = activeTier?.poolId ?? poolId;
  const effectiveEntryFee = activeTier?.entryFee ?? entryFee;
  const effectiveOptionId = activeTier
    ? (activeTier.options.find((o) => o.label === optionLabel)?.optionId ?? optionId)
    : optionId;
  const insufficientBalance = effectiveEntryFee > balanceCents;

  const balanceAfter = balanceCents - effectiveEntryFee;

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
          <div className="flex items-center justify-between">
            <dt className="text-text-secondary">Entry Fee × 1</dt>
            <dd className="text-text-primary">
              {hasTierChoice ? (
                <select
                  value={effectivePoolId}
                  onChange={(e) => setActiveTierPoolId(e.target.value)}
                  disabled={pending}
                  aria-label="Entry fee"
                  className="rounded-lg border border-border-subtle bg-surface-secondary px-2 py-1 text-sm font-medium text-text-primary"
                >
                  {tiers!.map((t) => (
                    <option key={t.poolId} value={t.poolId}>
                      {formatCents(t.entryFee)}
                    </option>
                  ))}
                </select>
              ) : (
                formatCents(effectiveEntryFee)
              )}
            </dd>
          </div>
          <div className="flex justify-between font-medium">
            <dt className="text-text-secondary">Total</dt>
            <dd className="text-text-primary">{formatCents(effectiveEntryFee)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-secondary">Balance after entry</dt>
            <dd className="text-text-primary">{formatCents(balanceAfter)}</dd>
          </div>
        </dl>

        {/* Restated right at the moment of commitment, not just on the feed
            card's small footer text — silence about money is the product's
            single biggest trust gap (see the wallet pending-state fix). */}
        <p className="text-xs text-text-muted">
          Platform Fee {formatBps(houseFeeBasisPoints)} — applies to winnings, not your entry.
        </p>

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
          <input type="hidden" name="poolId" value={effectivePoolId} />
          <input type="hidden" name="optionId" value={effectiveOptionId} />
          <input type="hidden" name="amountCents" value={effectiveEntryFee} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          {insufficientBalance ? (
            <div className="flex h-11 items-center justify-center rounded-full bg-surface-secondary text-sm text-text-muted">
              Insufficient balance for this tier
            </div>
          ) : (
            <SlideToConfirm pending={pending} onConfirm={() => formRef.current?.requestSubmit()} />
          )}
        </form>

        {insufficientBalance && (
          <p className="text-xs text-text-muted">
            Pick a lower entry fee above, or top up your balance first.
          </p>
        )}

        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </div>
    </div>
  );
}
