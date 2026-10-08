"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  approveSponsorshipAction,
  cancelSponsorshipByAdminAction,
  markSponsorshipPaidAction,
  recordPaymentEventAction,
  rejectSponsorshipAction,
  requestSponsorshipChangesAction,
  setSponsorshipPriceAction,
  suspendSponsorshipAction,
  unsuspendSponsorshipAction,
  type AdminSponsorshipResult,
} from "@/lib/actions/admin-sponsorship";

interface Props {
  id: string;
  revision: number;
  lifecycle: string;
  reviewStatus: string;
  paymentStatus: string;
  priceCents: number | null;
  currency: string | null;
  markPaidKey: string;
  paymentEventKey: string;
}

export function AdminSponsorshipActions({ id, revision, lifecycle, reviewStatus, paymentStatus, priceCents, currency, markPaidKey, paymentEventKey }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<AdminSponsorshipResult | null>(null);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [price, setPrice] = useState(priceCents === null ? "" : (priceCents / 100).toFixed(2));

  const go = (fn: () => Promise<AdminSponsorshipResult>) =>
    startTransition(async () => {
      const r = await fn();
      setResult(r);
      if (r.success) router.refresh();
    });

  const submitted = lifecycle === "SUBMITTED";
  const canPrice = ["DRAFT", "SUBMITTED"].includes(lifecycle) && ["UNPAID", "PENDING", "FAILED"].includes(paymentStatus);
  const live = lifecycle === "SCHEDULED" || lifecycle === "LIVE";

  return (
    <section aria-label="Actions" className="space-y-3 rounded-lg border border-border-subtle p-3">
      <h2 className="text-sm font-semibold text-text-primary">Actions</h2>

      {canPrice && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-text-muted">
            Price ({currency ?? "—"})
            <Input className="mt-1 w-32" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <Button type="button" variant="outline" disabled={pending || price.trim() === "" || !(Number(price) >= 0)} onClick={() => go(() => setSponsorshipPriceAction(id, Math.round(Number(price) * 100)))}>
            Set price
          </Button>
          <p className="text-xs text-text-muted">Only you can set the price. Leave it unset to use the inventory price at submission; a price you set here is kept. Changing the price of an approved, unpaid sponsorship voids its approval.</p>
        </div>
      )}

      {submitted && paymentStatus !== "PAID" && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-text-muted">
            Payment reference
            <Input className="mt-1 w-56" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
          <Button type="button" disabled={pending} onClick={() => go(() => markSponsorshipPaidAction(id, reference, "", markPaidKey))}>
            Mark payment received
          </Button>
          <p className="text-xs text-text-muted">Recorded with your name and time. Payment alone never publishes.</p>
        </div>
      )}

      {submitted && reviewStatus === "PENDING" && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={pending} onClick={() => go(() => approveSponsorshipAction(id, revision))}>
            Approve
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-xs text-text-muted">
          Reason / note (required for reject, request changes, suspend, cancel, refund notes)
          <Input className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          {submitted && reviewStatus === "PENDING" && (
            <>
              <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => requestSponsorshipChangesAction(id, reason))}>
                Request changes
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => rejectSponsorshipAction(id, reason))}>
                Reject
              </Button>
            </>
          )}
          {live && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => suspendSponsorshipAction(id, reason))}>
              Suspend
            </Button>
          )}
          {lifecycle === "SUSPENDED" && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => unsuspendSponsorshipAction(id))}>
              Unsuspend
            </Button>
          )}
          {!["COMPLETED", "REJECTED", "CANCELLED"].includes(lifecycle) && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => cancelSponsorshipByAdminAction(id, reason))}>
              Cancel sponsorship
            </Button>
          )}
        </div>
      </div>

      {(paymentStatus === "PAID" || paymentStatus === "REFUND_PENDING" || paymentStatus === "PENDING") && (
        <div className="flex flex-wrap gap-2">
          {paymentStatus === "PENDING" && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => recordPaymentEventAction(id, "FAILED", reference, reason, paymentEventKey))}>
              Mark payment failed
            </Button>
          )}
          {paymentStatus === "PAID" && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => recordPaymentEventAction(id, "REFUND_PENDING", reference, reason, paymentEventKey))}>
              Mark refund pending (ends the campaign)
            </Button>
          )}
          {(paymentStatus === "PAID" || paymentStatus === "REFUND_PENDING") && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => go(() => recordPaymentEventAction(id, "REFUNDED", reference, reason, paymentEventKey))}>
              Mark refunded
            </Button>
          )}
        </div>
      )}

      {result && (
        <p role={result.success ? "status" : "alert"} className={result.success ? "text-sm font-medium text-text-primary" : "text-sm font-medium text-warning-muted"}>
          {result.success ? "Done." : result.error}
        </p>
      )}
    </section>
  );
}
