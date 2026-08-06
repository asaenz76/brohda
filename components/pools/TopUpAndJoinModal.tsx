"use client";

import { useActionState, useRef, useState } from "react";
import { submitWalletRequestAction, type WalletRequestState } from "@/lib/actions/wallet-requests";
import { formatCents } from "@/lib/utils/money";
import type { PaymentMethod } from "@/lib/payment-methods/constants";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { DepositFields } from "@/components/wallet/DepositFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface TopUpAndJoinModalProps {
  poolId: string;
  optionId: string;
  optionLabel: string;
  entryFee: number;
  balanceCents: number;
  paymentMethods: PaymentMethodRow[];
  onClose: () => void;
}

const initialState: WalletRequestState = { error: null, success: false, idempotencyKey: null };

// Shown instead of EntryConfirmationSheet when the wallet balance can't
// cover the entry fee — every deposit in this app is admin-approval-gated
// (no instant/auto-credit path), so this submits a normal pending deposit
// request that records which entry it's for. approveWalletRequestAction
// auto-completes that entry once an admin approves, so the player doesn't
// have to come back and join manually. Collects the exact same Method/
// destination-hint/Transaction #/ID fields as the main wallet page's Add
// Funds form (via the shared DepositFields component) so an admin reviewing
// a quick top-up has the same info to act on as any other deposit request.
export function TopUpAndJoinModal({
  poolId,
  optionId,
  optionLabel,
  entryFee,
  balanceCents,
  paymentMethods,
  onClose,
}: TopUpAndJoinModalProps) {
  const [state, formAction, pending] = useActionState(submitWalletRequestAction, initialState);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">("");
  const sheetRef = useRef<HTMLDivElement>(null);

  const justSubmitted = state.success && state.idempotencyKey === idempotencyKey;
  const shortfallCents = entryFee - balanceCents;

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
        aria-label="Top up your balance"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[720px] space-y-4 rounded-t-2xl bg-surface-primary p-5 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-subtle" aria-hidden="true" />

        {justSubmitted ? (
          <>
            <p className="text-sm font-semibold text-text-primary">Top-up requested</p>
            <p className="text-sm text-text-secondary">
              Once an admin approves it, you&apos;ll be automatically entered in{" "}
              <span className="font-medium text-text-primary">{optionLabel}</span>.
            </p>
            <Button type="button" className="w-full" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <div>
              <p className="text-xs text-text-muted">Your choice</p>
              <p className="text-lg font-semibold text-text-primary">{optionLabel}</p>
            </div>

            <p className="text-sm text-text-secondary">
              Short <span className="font-semibold text-text-primary">{formatCents(shortfallCents)}</span>{" "}
              for this pool.
            </p>

            {paymentMethods.length === 0 ? (
              <div className="space-y-2 rounded-xl border border-border-subtle p-4">
                <p className="text-sm font-medium text-text-primary">Add Funds</p>
                <p className="text-sm text-text-secondary">
                  No payment methods are available right now — contact an admin.
                </p>
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            ) : (
              <form action={formAction} className="space-y-3 rounded-xl border border-border-subtle p-4">
                <input type="hidden" name="type" value="deposit" />
                <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                <input type="hidden" name="intendedPoolId" value={poolId} />
                <input type="hidden" name="intendedOptionId" value={optionId} />
                <p className="text-sm font-medium text-text-primary">Add Funds</p>
                <div className="space-y-1.5">
                  <Label htmlFor="topup-amount">Amount ($)</Label>
                  <Input
                    id="topup-amount"
                    name="amount"
                    placeholder="0.00"
                    inputMode="decimal"
                    defaultValue={(shortfallCents / 100).toFixed(2)}
                    required
                    className="w-32"
                  />
                </div>

                <DepositFields
                  idPrefix="topup"
                  mode="deposit"
                  paymentMethods={paymentMethods}
                  paymentMethod={paymentMethod}
                  onPaymentMethodChange={setPaymentMethod}
                />

                <div className="space-y-1.5">
                  <Label htmlFor="topup-note">Note (optional)</Label>
                  <Input id="topup-note" name="note" placeholder="e.g. Venmo sent" className="w-full" />
                </div>
                <div className="flex items-center gap-2">
                  <Button type="submit" disabled={pending}>
                    {pending ? "Submitting…" : "Top Up & Join"}
                  </Button>
                  <Button type="button" variant="outline" onClick={onClose}>
                    Cancel
                  </Button>
                </div>
                {state.error && (
                  <p role="alert" className="text-sm text-danger">
                    {state.error}
                  </p>
                )}
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
