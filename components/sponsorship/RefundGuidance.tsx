import { LocalDateTime } from "@/components/LocalDateTime";
import { applicableRefundReasons, caseForReason, REFUND_CASES, REFUND_POLICY_VERSION, type RefundEvaluation } from "@/lib/sponsorship/refund-policy";
import { evaluateSponsorshipRefundEligibility, getCancellationRecord } from "@/lib/sponsorship/refund-evaluation";
import { PAYMENT_STATUS_LABEL } from "@/lib/sponsorship/format";
import type { SponsorshipRecord } from "@/lib/sponsorship/repository";

const WHEN = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" } as const;

// Super Admin only. Shows what the refund policy says about THIS sponsorship so nobody has to work out the cutoff by hand: whether it is refund-eligible, why, the
// kickoff and the cutoff it was measured against, when it was cancelled (the frozen decision), the payment state, and the actual refund state. It is information,
// never an action — a refund is recorded only by the explicit "Mark refund pending / Mark refunded" buttons, and suspending never refunds.
export async function RefundGuidance({ s }: { s: SponsorshipRecord }) {
  const record = await getCancellationRecord(s.id);
  const reasons = record ? [] : applicableRefundReasons({ lifecycle: s.lifecycle, reviewStatus: s.reviewStatus, paymentStatus: s.paymentStatus, startsAt: s.startsAt, fixtureStatus: s.game?.internalStatus ?? null });
  const evaluations: RefundEvaluation[] = await Promise.all(reasons.map((r) => evaluateSponsorshipRefundEligibility(s.id, r)));
  const refundState = s.paymentStatus === "REFUND_PENDING" || s.paymentStatus === "REFUNDED" ? PAYMENT_STATUS_LABEL[s.paymentStatus] : "No refund recorded";
  return (
    <section aria-label="Refund guidance" data-slot="refund-guidance" className="space-y-2 rounded-lg border border-border-subtle p-3">
      <h2 className="text-sm font-semibold text-text-primary">Refund eligibility</h2>
      <p className="text-xs text-text-muted">
        Refund policy {REFUND_POLICY_VERSION}. Eligible is not refunded: a refund is recorded only by the refund actions below, and suspending never refunds anything. Payment: {PAYMENT_STATUS_LABEL[s.paymentStatus]} · Refund: {refundState}.
      </p>
      {record ? (
        <div data-slot="cancellation-record" className="space-y-0.5 text-sm text-text-secondary">
          <p>
            <span className="font-medium text-text-primary">{record.refundEligible ? "Refund eligible" : "Not refund eligible"}</span> — {record.reasonCode.replace(/_/g, " ").toLowerCase()}.{" "}
            {!record.moneyReceived && "No payment had been received."}
          </p>
          <p>
            Cancelled by {record.initiator === "SPONSOR" ? "the Sponsor" : "Brohda"} <LocalDateTime iso={record.cancelledAt} options={WHEN} /> · Game kickoff then <LocalDateTime iso={record.kickoffAt} options={WHEN} /> · refund cutoff (
            {record.cutoffHours}h before) <LocalDateTime iso={record.cutoffAt} options={WHEN} />. This decision is frozen: a later reschedule does not change it.
          </p>
        </div>
      ) : evaluations.length === 0 ? (
        <p className="text-sm text-text-secondary">No payment has been received for this sponsorship, so there is nothing to refund.</p>
      ) : (
        <ul className="space-y-2 text-sm text-text-secondary">
          {evaluations.map((e) => {
            const id = caseForReason(e.reason, { reviewStatus: s.reviewStatus });
            return (
              <li key={e.reason} data-reason={e.reason}>
                <p>
                  <span className="font-medium text-text-primary">Case {id} — {REFUND_CASES[id].title}:</span> {e.eligible ? "refund eligible" : "not refund eligible"} ({e.reasonCode.replace(/_/g, " ").toLowerCase()}).
                </p>
                <p className="text-xs text-text-muted">
                  Kickoff <LocalDateTime iso={e.kickoffAt} options={WHEN} /> · cutoff ({e.cutoffHours}h before) <LocalDateTime iso={e.cutoffAt} options={WHEN} />
                  {e.requiresChoice ? ` · Super Admin choice: ${e.options.map((o) => o.replace(/_/g, " ").toLowerCase()).join(" / ")}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {(s.game?.internalStatus === "POSTPONED" || s.game?.internalStatus === "CANCELLED") && (
        <p data-slot="postponed-path" className="rounded-md bg-secondary p-2 text-xs text-text-secondary">
          This Game is {s.game.internalStatus.toLowerCase()}. Offer the Sponsor an explicit choice — nothing is decided for them: <strong>preserve / reschedule</strong> (it stays on this Game Post; adjust the campaign window if the Game moves), <strong>replace</strong> (cancel with cause “Game cannot deliver”, then assign a replacement Game from Inventory), or <strong>refund</strong> (the refund actions below).
        </p>
      )}
    </section>
  );
}
