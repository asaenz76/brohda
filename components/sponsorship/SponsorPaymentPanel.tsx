import { startSponsorPaymentAction } from "@/lib/actions/sponsorship-payments";
import { Button } from "@/components/ui/button";
import { formatCommercialAmount } from "@/lib/sponsorship/format";

const NOTICE: Record<string, string> = {
  invalid: "We couldn't find that sponsorship.",
  unavailable: "Online payment isn't available right now.",
  not_payable: "This sponsorship can't be paid right now.",
  already_paid: "This sponsorship is already paid.",
  not_authorized: "We couldn't find that sponsorship.",
  provider_unavailable: "We couldn't start the payment. Please try again in a moment.",
  starting: "Your payment is starting. Refresh this page in a moment.",
  unknown: "Something went wrong. Try again.",
};

// A Sponsor's payment section: the frozen amount, where payment stands, and — only when online payment is offered — the way to pay. The amount shown is what the
// server will charge (it reads the same record); there is no amount field anywhere. Manual payment instructions stay available beside it.
export function SponsorPaymentPanel({ sponsorshipId, priceCents, currency, latestAttemptStatus, paymentStatus, offered, idempotencyKey, notice }: { sponsorshipId: string; priceCents: number | null; currency: string | null; latestAttemptStatus: string | null; paymentStatus: string; offered: boolean; idempotencyKey: string; notice: string | null }) {
  const pending = latestAttemptStatus === "PENDING" || latestAttemptStatus === "CREATED";
  const headline = paymentStatus === "FAILED" ? "Payment failed — you can try again." : pending ? "Payment pending." : "Awaiting payment.";
  return (
    <section aria-label="Payment" data-slot="sponsor-payment" className="space-y-2 rounded-lg border border-border-subtle p-3">
      <h2 className="text-sm font-semibold text-text-primary">Payment</h2>
      <p className="text-sm text-text-secondary">
        Amount: <span className="font-medium text-text-primary">{formatCommercialAmount(priceCents, currency)}</span>
      </p>
      <p role="status" data-slot="payment-status" className="text-sm font-medium text-text-primary">
        {headline}
      </p>
      {notice && NOTICE[notice] && (
        <p role="alert" className="text-sm font-medium text-warning-muted">
          {NOTICE[notice]}
        </p>
      )}
      {offered && (
        <form action={startSponsorPaymentAction} className="space-y-1">
          <input type="hidden" name="sponsorshipId" value={sponsorshipId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <Button type="submit">Pay with ONVO</Button>
          <p className="text-xs text-text-muted">You&apos;ll complete the payment on a secure page and come back here. Payment alone doesn&apos;t approve your sponsorship — Brohda still reviews it.</p>
        </form>
      )}
    </section>
  );
}
