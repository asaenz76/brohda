import { candidateRefundCases, REFUND_CASES, REFUND_POLICY_STATUS } from "@/lib/sponsorship/refund-policy";
import type { SponsorshipRecord } from "@/lib/sponsorship/repository";

// Guidance beside the refund actions (Super Admin only): which refund case(s) the campaign looks like, and the proposed treatment. It is information, never an
// action — a refund is recorded only by the explicit "Mark refund pending / Mark refunded" buttons, and suspending never refunds.
export function RefundGuidance({ s }: { s: SponsorshipRecord }) {
  const cases = candidateRefundCases({ lifecycle: s.lifecycle, reviewStatus: s.reviewStatus, paymentStatus: s.paymentStatus, startsAt: s.startsAt, fixtureStatus: s.game?.internalStatus ?? null });
  return (
    <section aria-label="Refund guidance" data-slot="refund-guidance" className="space-y-1 rounded-lg border border-border-subtle p-3">
      <h2 className="text-sm font-semibold text-text-primary">Refund guidance</h2>
      <p className="text-xs text-text-muted">
        Policy status: {REFUND_POLICY_STATUS}. Suspending a campaign or a Sponsor account never refunds anything; a refund is only ever recorded by the explicit refund actions below.
      </p>
      {cases.length === 0 ? (
        <p className="text-sm text-text-secondary">No payment has been received for this sponsorship, so there is nothing to refund.</p>
      ) : (
        <ul className="space-y-1 text-sm text-text-secondary">
          {cases.map((id) => (
            <li key={id}>
              <span className="font-medium text-text-primary">Case {id} — {REFUND_CASES[id].title}.</span> Proposed: {REFUND_CASES[id].proposed}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
