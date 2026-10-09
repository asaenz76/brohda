import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { requireSuperAdmin } from "@/lib/auth/session";
import { LocalDateTime } from "@/components/LocalDateTime";
import { getPaymentEventsForSponsorship, getSponsorshipForAdmin, listApprovalSnapshots, listSponsorshipAudit } from "@/lib/sponsorship/repository";
import { formatCommercialAmount, PAYMENT_STATUS_LABEL, sponsorStatusCopy } from "@/lib/sponsorship/format";
import { AdminSponsorshipActions } from "./admin-actions";
import { SponsorshipEditor, type EditorValues } from "@/components/sponsorship/SponsorshipEditor";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { sponsorCanEdit } from "@/lib/sponsorship/format";
import { SponsorshipNav } from "../sponsorship-nav";

function SponsorLogo({ url }: { url: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="Sponsor logo" className="size-10 rounded bg-white object-contain p-0.5" />;
}

const row = (label: string, value: React.ReactNode) => (
  <>
    <dt className="text-text-muted">{label}</dt>
    <dd className="min-w-0 break-words text-text-primary">{value ?? "—"}</dd>
  </>
);

export default async function AdminSponsorshipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  const s = await getSponsorshipForAdmin(id);
  if (!s) notFound();
  const [events, audit, approvals] = await Promise.all([getPaymentEventsForSponsorship(id), listSponsorshipAudit(id), listApprovalSnapshots(id)]);
  const copy = sponsorStatusCopy(s);
  const config = await getSponsorshipConfig();
  const editable = sponsorCanEdit(s);
  const initial: EditorValues = {
    campaignName: s.campaignName, presentedBy: s.presentedBy ?? "", tagline: s.tagline ?? "", ctaText: s.ctaText ?? "", destinationUrl: s.destinationUrl ?? "", hasPromotion: s.hasPromotion,
    promotionTitle: s.promotionTitle ?? "", promotionDescription: s.promotionDescription ?? "", prizeDescription: s.prizeDescription ?? "", officialRulesUrl: s.officialRulesUrl ?? "",
    promotionDestinationUrl: s.promotionDestinationUrl ?? "", promotionFulfillmentName: s.promotionFulfillmentName ?? "", promotionEligibilitySummary: s.promotionEligibilitySummary ?? "",
    promotionStartsAt: s.promotionStartsAt ?? "", promotionEndsAt: s.promotionEndsAt ?? "",
  };

  return (
    <div className="space-y-4">
      <SponsorshipNav active="/admin/sponsorship" />
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-text-primary">{s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName}` : s.campaignName}</h1>
        <Link href="/admin/sponsorship" className="text-sm text-accent-primary hover:underline">Back to queue</Link>
      </div>

      <div role="status" className="rounded-lg bg-secondary p-3 text-sm">
        <p className="font-semibold text-text-primary">{copy.label}</p>
        <p className="text-text-secondary">Lifecycle {s.lifecycle} · Review {s.reviewStatus} · Payment {s.paymentStatus} · Revision {s.revision}</p>
      </div>

      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 text-sm">
        {row("Sponsor", s.sponsorName)}
        {row("Game", s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName} (${s.game.competitionName ?? s.game.sport})` : null)}
        {row("Kickoff", s.game && <LocalDateTime iso={s.game.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />)}
        {row("Market / geography", s.marketCode)}
        {row("Agreed price", formatCommercialAmount(s.priceCents, s.currency))}
        {row("Payment", PAYMENT_STATUS_LABEL[s.paymentStatus])}
        {row("Campaign window", <><LocalDateTime iso={s.startsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> – <LocalDateTime iso={s.endsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></>)}
        {row("Submitted", s.submittedAt && <LocalDateTime iso={s.submittedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />)}
        {row("Campaign (private)", s.campaignName)}
        {row("Presented by", s.presentedBy)}
        {row("Logo", s.logoUrl ? <SponsorLogo url={s.logoUrl} /> : null)}
        {row("Short line", s.tagline)}
        {row("Call to action", s.ctaText)}
        {row("Destination", s.destinationUrl && <a href={s.destinationUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-primary hover:underline">{s.destinationUrl}</a>)}
      </dl>

      {s.hasPromotion && (
        <section aria-label="Promotion" className="space-y-1.5 rounded-lg border border-border-subtle p-3 text-sm">
          <h2 className="font-semibold text-text-primary">Sponsor-run promotion (review carefully — Brohda runs none of it)</h2>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5">
            {row("Title", s.promotionTitle)}
            {row("Description", s.promotionDescription)}
            {row("Prize", s.prizeDescription)}
            {row("Official rules", s.officialRulesUrl && <a href={s.officialRulesUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-primary hover:underline">{s.officialRulesUrl}</a>)}
            {row("Run by", s.promotionFulfillmentName)}
            {row("Eligibility", s.promotionEligibilitySummary)}
            {row("Promotion dates", s.promotionStartsAt || s.promotionEndsAt ? `${s.promotionStartsAt ?? "—"} → ${s.promotionEndsAt ?? "—"}` : null)}
          </dl>
        </section>
      )}

      {editable && (
        <section aria-label="Complete on the sponsor's behalf" className="space-y-3 rounded-lg border border-border-subtle p-3">
          <h2 className="text-sm font-semibold text-text-primary">{s.lifecycle === "DRAFT" ? "This is still a draft" : "Sent back for changes"}</h2>
          <p className="text-sm text-text-secondary">
            Payment can be recorded and the sponsorship approved only after it is <strong>submitted</strong> (that is when the price is fixed from the inventory and the Game is held).
            Complete the details below and submit it on the sponsor&apos;s behalf, or leave it for the sponsor to submit. Nothing is public until it is paid and approved.
          </p>
          <SponsorshipEditor mode="admin" sponsorshipId={s.id} sponsorId={s.sponsorId} initial={initial} logoUrl={s.logoUrl} logoMaxKb={Math.round(config.logoMaxBytes / 1024)} canCancel={false} />
        </section>
      )}

      <AdminSponsorshipActions
        id={s.id}
        revision={s.revision}
        lifecycle={s.lifecycle}
        reviewStatus={s.reviewStatus}
        paymentStatus={s.paymentStatus}
        priceCents={s.priceCents}
        currency={s.currency}
        markPaidKey={`mark-paid:${s.id}:${randomUUID()}`}
        paymentEventKey={`pay-event:${s.id}:${randomUUID()}`}
      />

      <section aria-label="Payment history" className="space-y-1">
        <h2 className="text-sm font-semibold text-text-primary">Payment history</h2>
        {events.length === 0 ? <p className="text-sm text-text-muted">None.</p> : (
          <ul className="space-y-0.5 text-sm text-text-secondary">
            {events.map((e, i) => (
              <li key={i}>
                <LocalDateTime iso={e.createdAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> · {e.eventType} · {formatCommercialAmount(e.amountCents, e.currency)} · {e.provider}
                {e.providerReference ? ` · ref ${e.providerReference}` : ""}{e.note ? ` · ${e.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Approved snapshots" className="space-y-1">
        <h2 className="text-sm font-semibold text-text-primary">What was approved</h2>
        {approvals.length === 0 ? <p className="text-sm text-text-muted">Nothing approved yet.</p> : approvals.map((a) => (
          <details key={a.revision} className="rounded-lg border border-border-subtle p-2 text-xs text-text-secondary">
            <summary className="cursor-pointer font-medium text-text-primary">Revision {a.revision} · <LocalDateTime iso={a.approved_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> · hash {a.content_hash.slice(0, 8)}</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(a.snapshot, null, 2)}</pre>
          </details>
        ))}
      </section>

      <section aria-label="Audit history" className="space-y-1">
        <h2 className="text-sm font-semibold text-text-primary">Audit history</h2>
        <ul className="space-y-0.5 text-sm text-text-secondary">
          {audit.map((a, i) => (
            <li key={i}>
              <LocalDateTime iso={a.createdAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> · {a.action.replace("sponsorship.", "")} · {a.actorName ?? "system"}{a.reason ? ` — ${a.reason}` : ""}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
