import { DraftBanner } from "@/components/legal/DraftBanner";
import { MediaAgreementTerms } from "@/components/legal/MediaAgreementTerms";
import { LocalDateTime } from "@/components/LocalDateTime";
import { MEDIA_AGREEMENT_DOCUMENT } from "@/lib/sponsor/terms";
import { formatCommercialAmount, PAYMENT_STATUS_LABEL } from "@/lib/sponsorship/format";
import type { AgreementAcceptance, SponsorshipRecord } from "@/lib/sponsorship/repository";

// The campaign-specific Media and Advertising Agreement: the SCHEDULE is generated from the canonical sponsorship record (so there is exactly one copy of
// the commercial facts), shown beside the standing terms and the record of any acceptance. Shown only to the Sponsor that owns the campaign and to Super
// Admin — callers authorize before rendering it. The text is a DRAFT until counsel approves it (lib/sponsor/terms.ts).
export function AgreementPanel({ s, acceptances, bySuperAdmin = false }: { s: SponsorshipRecord; acceptances: AgreementAcceptance[]; bySuperAdmin?: boolean }) {
  const doc = MEDIA_AGREEMENT_DOCUMENT;
  const rows: Array<[string, React.ReactNode]> = [
    ["Sponsor", s.sponsorName ?? "—"],
    ["Game", s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName}` : "—"],
    ["Market (geography)", s.marketCode === "GLOBAL" ? "Global" : s.marketCode],
    [
      "Campaign window",
      <>
        <LocalDateTime iso={s.startsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> – <LocalDateTime iso={s.endsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
      </>,
    ],
    ["Agreed price", formatCommercialAmount(s.priceCents, s.currency)],
    ["Payment", PAYMENT_STATUS_LABEL[s.paymentStatus] ?? s.paymentStatus],
    ["Presented by", s.presentedBy ?? "—"],
    ["Call-to-action", s.ctaText ? `${s.ctaText}${s.destinationUrl ? ` → ${s.destinationUrl}` : ""}` : s.destinationUrl ?? "—"],
    ["Sponsor-run promotion", s.hasPromotion ? `${s.promotionTitle ?? "Promotion"} — run by ${s.promotionFulfillmentName ?? "the sponsor"}; rules: ${s.officialRulesUrl ?? "—"}` : "None"],
  ];
  return (
    <details className="rounded-lg border border-border-subtle p-3" data-slot="media-agreement">
      <summary className="cursor-pointer text-sm font-semibold text-text-primary">{doc.title}</summary>
      <div className="mt-3 space-y-4">
        {doc.status === "DRAFT" && <DraftBanner what="agreement" />}
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="text-sm text-text-secondary">
          <MediaAgreementTerms />
        </div>
        <div className="text-sm" data-slot="agreement-acceptance">
          <h3 className="font-semibold text-text-primary">Acceptance</h3>
          {acceptances.length === 0 ? (
            <p className="text-text-secondary">
              {doc.status === "DRAFT"
                ? "No acceptance is recorded: this agreement is still a draft and nobody is asked to accept it yet."
                : bySuperAdmin
                  ? "No acceptance recorded for this campaign (for example, it was submitted by Brohda on the sponsor's behalf)."
                  : "You have not accepted this agreement for this campaign."}
            </p>
          ) : (
            <ul className="space-y-1 text-text-secondary">
              {acceptances.map((a) => (
                <li key={`${a.agreementVersion}-${a.revision}`}>
                  Accepted <LocalDateTime iso={a.acceptedAt} options={{ month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }} /> · agreement version {a.agreementVersion}
                  {a.termsVersion ? ` · Sponsor Terms ${a.termsVersion}` : ""} · price {formatCommercialAmount(a.priceCents, a.currency)} · payment {a.paymentStatus.toLowerCase()} at the time · content revision {a.revision}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}
