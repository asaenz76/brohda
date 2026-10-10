"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LocalDateTime } from "@/components/LocalDateTime";
import { cancelSponsorshipAction } from "@/lib/actions/sponsorship";

// What a Sponsor sees BEFORE cancelling a submitted sponsorship: the refund rule, the exact deadline (calculated on the server from the Game's scheduled
// start; shown in the reader's own time zone), whether cancelling now is refund-eligible, and an explicit confirmation. Plain words, no pressure.
export function CancelSponsorshipPanel({ sponsorshipId, ruleCopy, cutoffAtIso, kickoffIso, headline, detail, moneyReceived, refundEligible }: { sponsorshipId: string; ruleCopy: string; cutoffAtIso: string; kickoffIso: string; headline: string; detail: string; moneyReceived: boolean; refundEligible: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const WHEN = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const;

  return (
    <section aria-label="Cancel this sponsorship" data-slot="cancel-sponsorship" className="space-y-3 rounded-lg border border-border-subtle p-3">
      <h2 className="text-sm font-semibold text-text-primary">Cancelling</h2>
      <p className="text-sm text-text-secondary">{ruleCopy}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-text-muted">Game kickoff</dt>
        <dd className="text-text-primary"><LocalDateTime iso={kickoffIso} options={WHEN} /></dd>
        <dt className="text-text-muted">Refund cancellation deadline</dt>
        <dd className="text-text-primary" data-slot="refund-deadline"><LocalDateTime iso={cutoffAtIso} options={WHEN} /></dd>
      </dl>
      <p role="status" data-slot="cancel-consequence" className="text-sm font-medium text-text-primary">
        {headline}
      </p>
      <p className="text-sm text-text-secondary">{detail}</p>
      {!open ? (
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          Cancel sponsorship…
        </Button>
      ) : (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-text-secondary">
            <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              {moneyReceived && !refundEligible
                ? "I understand this cancellation is not eligible for a refund and the payment is non-refundable."
                : moneyReceived
                  ? "I understand this cancellation is currently refund-eligible, and that the refund is processed separately by Brohda."
                  : "I want to cancel this sponsorship."}
            </span>
          </label>
          {error && <p role="alert" className="text-sm font-medium text-warning-muted">{error}</p>}
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={!confirmed || pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await cancelSponsorshipAction(sponsorshipId, refundEligible);
                  if (r.success) router.refresh();
                  else {
                    setError(r.error ?? "Could not cancel.");
                    setConfirmed(false);
                    router.refresh();
                  }
                })
              }
            >
              Confirm cancellation
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => { setOpen(false); setConfirmed(false); }}>
              Keep my sponsorship
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
