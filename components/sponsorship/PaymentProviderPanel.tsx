"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LocalDateTime } from "@/components/LocalDateTime";
import { cancelPaymentAttemptAction, reconcilePaymentAttemptAction, reconcileRefundAction, refundThroughProviderAction, type AdminPaymentResult } from "@/lib/actions/sponsorship-payments";
import { formatCommercialAmount } from "@/lib/sponsorship/format";
import type { AdminPaymentAttempt } from "@/lib/payments/views";

const WHEN = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;
const LABEL: Record<string, string> = { CREATED: "Created", PENDING: "Pending", SUCCEEDED: "Paid", FAILED: "Failed", EXPIRED: "Expired", SUPERSEDED: "Superseded", CANCELLED: "Cancelled", DUPLICATE_PAYMENT: "Duplicate payment — needs review", MISMATCH: "Amount mismatch — needs review", UNAPPLIED: "Received but not applied — needs review" };

// Super Admin's payment detail: every online payment attempt — provider, TEST/LIVE, amount, status, provider reference, when it was created/paid/refunded and last heard
// from — with Reconcile and the provider refund. The manual "mark payment received" path is unchanged and separate. No secrets and no card data exist here to show.
export function PaymentProviderPanel({ sponsorshipId, attempts, paymentStatus }: { sponsorshipId: string; attempts: AdminPaymentAttempt[]; paymentStatus: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<AdminPaymentResult | null>(null);
  const go = (fn: () => Promise<AdminPaymentResult>) =>
    startTransition(async () => {
      const r = await fn();
      setNote(r);
      router.refresh();
    });
  if (attempts.length === 0) return null;
  return (
    <section aria-label="Online payments" data-slot="payment-provider-panel" className="space-y-2 rounded-lg border border-border-subtle p-3">
      <h2 className="text-sm font-semibold text-text-primary">Online payments</h2>
      <ul className="space-y-3">
        {attempts.map((a) => (
          <li key={a.id} data-attempt-id={a.id} className="space-y-1 text-sm text-text-secondary">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text-primary">{a.providerLabel}</span>
              <span data-slot="payment-environment" className={a.environment === "TEST" ? "rounded-full bg-warning-muted/20 px-2 py-0.5 text-xs font-semibold text-warning-muted" : "rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-text-primary"}>
                {a.environment === "TEST" ? "TEST" : "LIVE"}
              </span>
              <span data-slot="attempt-status">{LABEL[a.status] ?? a.status}</span>
              <span>{formatCommercialAmount(a.amountCents, a.currency)}</span>
            </p>
            <p className="text-xs text-text-muted">
              Provider reference: {a.providerPaymentRef ?? a.providerSessionId ?? "—"} · created <LocalDateTime iso={a.createdAt} options={WHEN} />
              {a.paidAt && <> · paid <LocalDateTime iso={a.paidAt} options={WHEN} /></>}
              {a.failedAt && <> · failed <LocalDateTime iso={a.failedAt} options={WHEN} /></>}
              {a.refundedAt && <> · refunded <LocalDateTime iso={a.refundedAt} options={WHEN} /></>}
              {a.lastProviderEventAt && <> · last provider update <LocalDateTime iso={a.lastProviderEventAt} options={WHEN} /></>}
              {a.providerStatus ? ` · provider status: ${a.providerStatus}` : ""}
            </p>
            {a.environment === "TEST" && <p className="text-xs font-medium text-warning-muted">Test payment — no real money moved; do not count it as revenue.</p>}
            {a.refunds.map((r) => (
              <p key={r.id} className="text-xs text-text-muted" data-slot="provider-refund">
                Refund {r.status.toLowerCase()}{r.providerRefundId ? ` · ${r.providerRefundId}` : ""}{r.failureCode ? ` · ${r.failureCode}` : ""}
                {r.status === "PENDING" && (
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => go(() => reconcileRefundAction(sponsorshipId, r.id))}>
                    Check refund
                  </Button>
                )}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              {a.canReconcile && (a.providerSessionId || a.providerPaymentRef) && (
                <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => reconcilePaymentAttemptAction(sponsorshipId, a.id))}>
                  Reconcile with provider
                </Button>
              )}
              {a.canRefund && a.status === "SUCCEEDED" && (paymentStatus === "PAID" || paymentStatus === "REFUND_PENDING") && !a.refunds.some((r) => ["REQUESTED", "PENDING", "SUCCEEDED"].includes(r.status)) && (
                <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => refundThroughProviderAction(sponsorshipId, a.id))}>
                  Refund through the provider
                </Button>
              )}
              {["CREATED", "PENDING"].includes(a.status) && (
                <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => cancelPaymentAttemptAction(sponsorshipId, a.id))}>
                  Cancel this open payment
                </Button>
              )}
            </div>
            {!a.canReconcile && <p className="text-xs text-text-muted">{a.providerLabel} isn&apos;t installed or can&apos;t be checked online in this deployment — reconcile and refund it manually.</p>}
          </li>
        ))}
      </ul>
      {note && (
        <p role={note.success ? "status" : "alert"} className={note.success ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
          {note.error ?? note.message}
        </p>
      )}
      <p className="text-xs text-text-muted">Refunding is Brohda&apos;s decision under the refund policy; the provider only carries it out. Nothing is marked refunded until the provider confirms.</p>
    </section>
  );
}
