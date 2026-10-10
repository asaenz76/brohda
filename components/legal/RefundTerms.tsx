// The refund terms, in ONE place, shared by the Sponsor Terms and the per-campaign agreement so they can never disagree. It states the owner-decided V1 refund
// rules (lib/sponsorship/refund-policy.ts is the machine-readable copy; the database function is the decision). The hour count is the configured cutoff — a
// changed cutoff is a changed term and needs a new Sponsor Terms version. DRAFT wording: written from the owner's decisions, pending approval with the rest of
// the document.
export function RefundTerms({ cutoffHours }: { cutoffHours: number | null }) {
  const cutoff = cutoffHours === null ? "the number of hours shown on the sponsorship" : `${cutoffHours} hour${cutoffHours === 1 ? "" : "s"}`;
  return (
    <>
      <p>Refunds follow this policy and are never automatic: Brohda decides, records and processes each one separately.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>If you cancel.</strong> You are eligible for a refund only if the cancellation is completed at least {cutoff} before the Game&apos;s scheduled start time. After that the payment is non-refundable, although you may still cancel. This does not depend on whether Brohda has approved the sponsorship yet. The reason for the deadline is that Brohda needs time to offer the Game to another Sponsor.
        </li>
        <li>
          <strong>If Brohda rejects a sponsorship you have paid for,</strong> you are eligible for a full refund.
        </li>
        <li>
          <strong>If Brohda cancels before delivery</strong> for a reason that is not your breach, or the Game is cancelled or cannot deliver the sponsorship, you may choose a full refund or replacement inventory agreed with Brohda. If a Game is only postponed, Brohda will offer you the choice to keep the sponsorship on the rescheduled Game, replace it, or be refunded.
        </li>
        <li>
          <strong>If a live campaign is suspended</strong> because of your breach, prohibited content, material misrepresentation or another cause on your side, there is no automatic refund. If Brohda suspends or ends it for a reason on Brohda&apos;s side, the undelivered portion is eligible for a refund.
        </li>
        <li>
          <strong>Once the campaign has run through its scheduled window,</strong> there is no refund unless Brohda materially failed to deliver the sponsorship. Brohda sells a labeled presence around a Game Post; it does not guarantee impressions, clicks, Picks, comments, conversions or sales, and low engagement is not a failure to deliver.
        </li>
        <li>Suspending a campaign or a Sponsor account is not a refund, and cancelling does not by itself refund anything.</li>
      </ul>
    </>
  );
}
