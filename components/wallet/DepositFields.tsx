"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_REFERENCE_REQUIREMENT,
  PAYMENT_REFERENCE_LABEL,
  PAYMENT_REFERENCE_PLACEHOLDER,
  PAYMENT_REFERENCE_HELP,
  CRYPTO_TX_HASH_PATTERN,
  type PaymentMethod,
} from "@/lib/payment-methods/constants";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

// Shown once a real (non-Other) method is picked on a deposit form — tells
// the player where to send funds and lets them copy the destination
// straight into their banking/wallet app. Same defensive copy pattern as
// ShareSheet.tsx's copyLink(): clipboard writes can legitimately reject, so
// this never throws, just silently keeps the "Copy" label if it fails.
export function DestinationHint({ method }: { method: PaymentMethodRow }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!method.destination) return;
    try {
      await navigator.clipboard.writeText(method.destination);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed (permissions, unfocused tab, etc.) — the
      // destination text is still visible to copy manually, so this is a
      // silent no-op rather than an error state.
    }
  }

  if (!method.destination) {
    return (
      <p className="rounded-lg bg-surface-secondary p-3 text-sm text-text-secondary">
        Destination not configured yet — contact an admin.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg bg-surface-secondary p-3">
      <p className="text-sm text-text-secondary">
        Please send funds to{" "}
        <button
          type="button"
          onClick={handleCopy}
          // break-all: a wallet address/handle is one long unbroken token
          // with no natural wrap points — without it, this pushes the
          // sheet wider instead of wrapping (real failure caught testing
          // at 200% accessibility text size).
          className="inline-flex items-center gap-1 break-all font-semibold text-text-primary underline decoration-dotted underline-offset-2"
        >
          {method.destination}
          {copied ? <Check className="size-3.5 text-credit" /> : <Copy className="size-3.5" />}
        </button>
        {method.instructions ? ` ${method.instructions}` : ""}
      </p>
    </div>
  );
}

/**
 * The Method select shared by both deposit and withdrawal requests, plus
 * — for deposits only — the OTHER-method free-text "Specify" field, the
 * destination copy-hint, and the required Transaction #/ID input. Shared by
 * the main wallet page's Add Funds/Transfer Out form and TopUpAndJoinModal's
 * quick top-up form (always deposit-mode) so every deposit entry point
 * collects identical, admin-reviewable info instead of drifting apart.
 */
export function DepositFields({
  idPrefix,
  mode,
  paymentMethods,
  paymentMethod,
  onPaymentMethodChange,
}: {
  idPrefix: string;
  mode: "deposit" | "withdrawal";
  paymentMethods: PaymentMethodRow[];
  paymentMethod: PaymentMethod | "";
  onPaymentMethodChange: (method: PaymentMethod) => void;
}) {
  // Launch simplification defaults to exactly one enabled payment rail
  // (see supabase/migrations — payment_methods.enabled is the single
  // source of truth every caller of getPaymentMethods() already filters
  // by). With only one real choice, a dropdown is dead UI — show it as a
  // plain label instead, while keeping the full multi-method picker fully
  // intact for whenever a second rail is ever re-enabled.
  const onlyMethod = paymentMethods.length === 1 ? paymentMethods[0] : null;
  const selectedMethodRow = onlyMethod ?? paymentMethods.find((m) => m.method === paymentMethod) ?? null;
  // Drives the reference field's label/placeholder/requiredness below —
  // falls back to "optional" until a method is actually chosen, so the
  // field doesn't demand input before there's anything to be specific about.
  const effectiveMethod: PaymentMethod | null = selectedMethodRow?.method ?? (paymentMethod || null);
  const referenceRequirement = effectiveMethod ? PAYMENT_REFERENCE_REQUIREMENT[effectiveMethod] : "optional";

  // Both call sites (WalletRequestForm, TopUpAndJoinModal) own their own
  // paymentMethod state for other purposes (e.g. WITHDRAWAL_NOTE_COPY) —
  // sync it to the only real choice here, once, rather than duplicating
  // this effect in every caller.
  useEffect(() => {
    if (onlyMethod && paymentMethod !== onlyMethod.method) {
      onPaymentMethodChange(onlyMethod.method);
    }
  }, [onlyMethod, paymentMethod, onPaymentMethodChange]);

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-payment-method`}>Method</Label>
        {onlyMethod ? (
          <>
            <p id={`${idPrefix}-payment-method`} className="text-sm font-medium text-text-primary">
              {PAYMENT_METHOD_LABELS[onlyMethod.method]}
            </p>
            <input type="hidden" name="paymentMethod" value={onlyMethod.method} />
          </>
        ) : (
          <select
            id={`${idPrefix}-payment-method`}
            name="paymentMethod"
            className={SELECT_CLASS}
            value={paymentMethod}
            onChange={(e) => onPaymentMethodChange(e.target.value as PaymentMethod)}
            required
          >
            <option value="" disabled>
              Select a method…
            </option>
            {paymentMethods.map((m) => (
              <option key={m.method} value={m.method}>
                {PAYMENT_METHOD_LABELS[m.method]}
              </option>
            ))}
          </select>
        )}
      </div>

      {mode === "deposit" && paymentMethod === "OTHER" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-other-method`}>Specify</Label>
          <Textarea
            id={`${idPrefix}-other-method`}
            name="otherMethodNote"
            placeholder="How are you sending/receiving funds?"
            rows={2}
            required
          />
        </div>
      )}

      {/* OTHER is still just an enum value in payment_methods — an admin can
          (and here, does) configure a real destination/instructions for it
          same as any named method, so this must not skip OTHER. */}
      {mode === "deposit" && selectedMethodRow && <DestinationHint method={selectedMethodRow} />}

      {/* Method-aware, matching lib/validations/wallet.ts's superRefine
          exactly (same PAYMENT_REFERENCE_REQUIREMENT lookup and the same
          CRYPTO_TX_HASH_PATTERN as the HTML `pattern` attribute) — Brohda's
          review is entirely manual, so whatever's required here is
          genuinely the only evidence an admin has, not proof for its own
          sake. OTHER stays optional since it has no predictable receipt
          shape to require. */}
      {mode === "deposit" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-transaction-ref`}>
            {effectiveMethod ? PAYMENT_REFERENCE_LABEL[effectiveMethod] : "Payment reference"}
          </Label>
          <Input
            id={`${idPrefix}-transaction-ref`}
            name="transactionRef"
            placeholder={
              effectiveMethod
                ? PAYMENT_REFERENCE_PLACEHOLDER[effectiveMethod]
                : "e.g. a tx hash, confirmation number, or last 4 digits"
            }
            required={referenceRequirement !== "optional"}
            pattern={referenceRequirement === "crypto_hash" ? CRYPTO_TX_HASH_PATTERN : undefined}
          />
          {effectiveMethod && PAYMENT_REFERENCE_HELP[effectiveMethod] && (
            <p className="text-xs text-text-muted">{PAYMENT_REFERENCE_HELP[effectiveMethod]}</p>
          )}
        </div>
      )}
    </>
  );
}
