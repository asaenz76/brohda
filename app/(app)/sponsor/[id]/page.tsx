import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { getPaymentEventsForSponsorship, getSponsorshipForUser } from "@/lib/sponsorship/repository";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { formatCommercialAmount, PAYMENT_STATUS_LABEL, sponsorCanEdit, sponsorStatusCopy } from "@/lib/sponsorship/format";
import { SponsorshipEditor, type EditorValues } from "./sponsorship-editor";

// One sponsorship, for a member of the sponsor that owns it (anyone else gets not-found, indistinguishable from a missing one). The sponsor sees status,
// the price Brohda set, and payment state — it can edit while editable, submit, and cancel before money. It can never approve, price, mark paid or activate.
export default async function SponsorshipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const s = await getSponsorshipForUser(user.id, id);
  if (!s) notFound();
  const [enabled, config, events] = await Promise.all([isSponsorshipEnabled(), getSponsorshipConfig(), getPaymentEventsForSponsorship(id)]);
  const copy = sponsorStatusCopy(s);
  const editable = enabled && sponsorCanEdit(s);
  const initial: EditorValues = {
    campaignName: s.campaignName,
    presentedBy: s.presentedBy ?? "",
    tagline: s.tagline ?? "",
    ctaText: s.ctaText ?? "",
    destinationUrl: s.destinationUrl ?? "",
    hasPromotion: s.hasPromotion,
    promotionTitle: s.promotionTitle ?? "",
    promotionDescription: s.promotionDescription ?? "",
    prizeDescription: s.prizeDescription ?? "",
    officialRulesUrl: s.officialRulesUrl ?? "",
    promotionDestinationUrl: s.promotionDestinationUrl ?? "",
    promotionFulfillmentName: s.promotionFulfillmentName ?? "",
    promotionEligibilitySummary: s.promotionEligibilitySummary ?? "",
    promotionStartsAt: s.promotionStartsAt ?? "",
    promotionEndsAt: s.promotionEndsAt ?? "",
  };

  return (
    <div className="space-y-3">
      <ColumnHeader title="Sponsorship" backHref="/sponsor" />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-1">
            <p className="text-base font-semibold text-text-primary">{s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName}` : s.campaignName}</p>
            <p className="text-xs text-text-muted">
              {s.game?.competitionName ? `${s.game.competitionName} · ` : ""}
              {s.game && <LocalDateTime iso={s.game.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}
              {" · "}Market: {s.marketCode === "GLOBAL" ? "Global" : s.marketCode}
            </p>
          </div>

          <div role="status" className="space-y-1 rounded-lg bg-secondary p-3">
            <p className="text-sm font-semibold text-text-primary">{copy.label}</p>
            <p className="text-sm text-text-secondary">{copy.detail}</p>
            {s.reviewNote && s.reviewStatus === "CHANGES_REQUESTED" && <p className="text-sm text-text-primary">Brohda&apos;s note: {s.reviewNote}</p>}
            {s.rejectionReason && s.lifecycle === "REJECTED" && <p className="text-sm text-text-primary">Reason: {s.rejectionReason}</p>}
            {s.suspensionReason && s.lifecycle === "SUSPENDED" && <p className="text-sm text-text-primary">Reason: {s.suspensionReason}</p>}
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">Price</dt>
            <dd className="text-text-primary">
              {s.priceCents === null ? "Set by Brohda when you submit" : formatCommercialAmount(s.priceCents, s.currency)}
              <span className="block text-xs text-text-muted">Set by Brohda — it can&apos;t be changed here.</span>
            </dd>
            <dt className="text-text-muted">Payment</dt>
            <dd className="text-text-primary">{PAYMENT_STATUS_LABEL[s.paymentStatus]}</dd>
            <dt className="text-text-muted">Campaign window</dt>
            <dd className="text-text-primary">
              <LocalDateTime iso={s.startsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> – <LocalDateTime iso={s.endsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
            </dd>
          </dl>

          {s.lifecycle === "SUBMITTED" && s.paymentStatus !== "PAID" && config.paymentInstructions && (
            <div className="space-y-1 rounded-lg border border-border-subtle p-3">
              <p className="text-sm font-medium text-text-primary">How to pay</p>
              <p className="whitespace-pre-line text-sm text-text-secondary">{config.paymentInstructions}</p>
              <p className="text-xs text-text-muted">Brohda confirms payment manually. Payment doesn&apos;t guarantee approval.</p>
            </div>
          )}

          {events.length > 0 && (
            <ul className="space-y-0.5 text-xs text-text-muted" aria-label="Payment history">
              {events.map((e, i) => (
                <li key={i}>
                  <LocalDateTime iso={e.createdAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> — {e.eventType.replace("_", " ").toLowerCase()}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {editable ? (
        <Card>
          <CardContent className="pt-6">
            <SponsorshipEditor sponsorshipId={s.id} sponsorId={s.sponsorId} initial={initial} logoUrl={s.logoUrl} logoMaxKb={Math.round(config.logoMaxBytes / 1024)} canCancel={s.paymentStatus !== "PAID"} />
          </CardContent>
        </Card>
      ) : (
        !enabled && <p className="text-sm text-text-secondary">Sponsored Game Posts aren&apos;t open right now, so this can&apos;t be edited or submitted.</p>
      )}
    </div>
  );
}
