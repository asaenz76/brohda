import { startSponsorPaymentAction } from "@/lib/actions/sponsorship-payments";
import { Button } from "@/components/ui/button";
import { formatCommercialAmount, paymentHeadline, paymentStateLabel } from "@/lib/sponsorship/format";
import { legalRequirementCopy } from "@/lib/sponsor/legal-copy";
import type { PaymentEligibility } from "@/lib/sponsorship/payment-eligibility";

const NOTICE: Record<string, string> = {
  invalid: "We couldn't find that sponsorship.",
  unavailable: "Online payment isn't available right now.",
  not_payable: "This sponsorship can't be paid right now.",
  already_paid: "This sponsorship is already paid.",
  not_authorized: "We couldn't find that sponsorship.",
  provider_unavailable: "We couldn't start the payment. Please try again in a moment.",
  legal_acceptance_required: "Please accept the current Sponsor Terms and the campaign agreement before paying.",
  in_progress_other_provider: "A payment you started earlier is still open. Please finish it, or wait for it to expire, then try again.",
  starting: "Your payment is starting. Refresh this page in a moment.",
  left: "You left the payment page before it finished. Nothing is marked paid unless it shows as received here.",
  unknown: "Something went wrong. Try again.",
};

// A Sponsor's payment section, shown for every submitted sponsorship: the frozen amount and currency, where payment stands, and — only when starting a payment would actually be
// accepted — Pay now. The amount shown is what the server will charge (it reads the same record); there is no amount field anywhere. When a payment is still owed and the owner
// has provided manual instructions (Settings → Sponsorship) they are offered beside it, never instead of it. The provider is never named.
export function SponsorPaymentPanel({
  sponsorshipId,
  priceCents,
  currency,
  lifecycle,
  reviewStatus,
  paymentStatus,
  latestAttemptStatus,
  eligibility,
  manualInstructions = null,
  idempotencyKey,
  notice,
}: {
  sponsorshipId: string;
  priceCents: number | null;
  currency: string | null;
  lifecycle: string;
  reviewStatus: string;
  paymentStatus: string;
  latestAttemptStatus: string | null;
  eligibility: PaymentEligibility;
  manualInstructions?: string | null;
  idempotencyKey: string;
  notice: string | null;
}) {
  const openAttempt = latestAttemptStatus === "PENDING" || latestAttemptStatus === "CREATED";
  return (
    <section aria-label="Payment" data-slot="sponsor-payment" className="space-y-2 rounded-lg border border-border-subtle p-3">
      <h2 className="text-sm font-semibold text-text-primary">Payment</h2>
      <p className="text-sm text-text-secondary">
        Amount: <span className="font-medium text-text-primary" data-slot="payment-amount">{formatCommercialAmount(priceCents, currency)}</span>
      </p>
      <p className="text-sm text-text-secondary">
        Currency: <span className="font-medium text-text-primary" data-slot="payment-currency">{currency ?? "—"}</span>
      </p>
      <p className="text-sm text-text-secondary">
        Status: <span className="font-medium text-text-primary" data-slot="payment-state">{paymentStateLabel(paymentStatus, openAttempt)}</span>
      </p>
      <p role="status" data-slot="payment-status" className="text-sm font-medium text-text-primary">
        {paymentHeadline({ paymentStatus, lifecycle, reviewStatus, openAttempt })}
      </p>
      {notice && NOTICE[notice] && (
        <p role="alert" className="text-sm font-medium text-warning-muted">
          {NOTICE[notice]}
        </p>
      )}
      {eligibility.state === "LEGAL_BLOCKED" && (
        <p role="status" data-slot="legal-block" className="text-sm font-medium text-text-primary">
          {legalRequirementCopy(eligibility.missing)}
        </p>
      )}
      {eligibility.state === "ONLINE_UNAVAILABLE" && (
        <p role="status" data-slot="online-unavailable" className="text-sm text-text-secondary">
          Online payment isn&apos;t available right now.
        </p>
      )}
      {eligibility.state === "PAY_NOW" && (
        <form action={startSponsorPaymentAction} className="space-y-1">
          <input type="hidden" name="sponsorshipId" value={sponsorshipId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <Button type="submit">Pay now</Button>
          <p className="text-xs text-text-muted">You&apos;ll complete the payment on a secure page and come back here. Payment alone doesn&apos;t approve your sponsorship — Brohda still reviews it.</p>
        </form>
      )}
      {manualInstructions && (
        <details data-slot="manual-instructions" className="rounded-md border border-border-subtle p-2 text-sm">
          <summary className="cursor-pointer font-medium text-text-primary">View manual payment instructions</summary>
          <p className="mt-2 whitespace-pre-line text-text-secondary">{manualInstructions}</p>
          <p className="mt-2 text-xs text-text-muted">Brohda confirms a manual payment by hand once it is received.</p>
        </details>
      )}
    </section>
  );
}
