import { refundPolicyDiffersFromApprovedTerms } from "@/lib/sponsor/commercial-legal-gate";
import { SPONSOR_TERMS_DOCUMENT } from "@/lib/sponsor/terms";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";

// Settings → Brohda → Sponsorship: the GLOBAL refund policy value. It is policy configuration, not review work. Shown read-only on purpose: the cutoff is part of what the Sponsor Terms
// say, so changing it is a policy decision (a new Terms version), made by an operator — not a switch in the UI. What THIS card is not: any single sponsorship's refund eligibility,
// which is decided from that sponsorship's own frozen policy and shown on the sponsorship's admin page.
export async function RefundPolicyCard() {
  const config = await getSponsorshipConfig().catch(() => null);
  const mismatch = config ? refundPolicyDiffersFromApprovedTerms(SPONSOR_TERMS_DOCUMENT, config.refundCutoffHours) : false;
  return (
    <section aria-label="Sponsorship refund policy" data-slot="refund-policy" className="space-y-1 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Sponsorship refund policy</h2>
      {config && (
        <p className="text-text-secondary">
          Refund cutoff for new campaigns: <span className="font-medium text-text-primary" data-slot="policy-refund-cutoff">{config.refundCutoffHours} hours before kickoff</span>
        </p>
      )}
      {mismatch && (
        <p role="alert" data-slot="policy-mismatch" className="text-xs font-medium text-warning-muted">
          The configured refund cutoff differs from the one the approved Sponsor Terms state. New Sponsor submissions are paused until a new Sponsor Terms version is approved.
        </p>
      )}
      <p className="text-xs text-text-muted">
        Global policy: a Sponsor cancelling at least this long before the Game starts is refund-eligible. Each sponsorship keeps the cutoff in force when it was submitted, and its own refund eligibility is shown on its page — not here.
      </p>
    </section>
  );
}
