import type { PublicPromotion } from "@/lib/sponsorship/types";

/**
 * An APPROVED sponsor-run promotion, shown on the Post detail only. Metadata, a link to the sponsor's official rules and a disclosure — nothing else:
 * Brohda collects no entries, decides no qualification, picks no winners, holds no prizes and delivers none. The disclosure copy is shown verbatim from
 * here so there is one place for counsel to review (docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md §9).
 */
export const PROMOTION_DISCLOSURE = "This promotion is run by the sponsor, not by Brohda. Brohda does not take entries, choose winners, hold prizes or deliver them. See the official rules for who is eligible and how it works.";

export function SponsorPromotion({ promotion }: { promotion: PublicPromotion }) {
  return (
    <section aria-label="Sponsor promotion" data-slot="sponsor-promotion" className="space-y-1.5 rounded-lg border border-border-subtle p-3 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Sponsor promotion</p>
      <p className="font-semibold text-text-primary">{promotion.title}</p>
      {promotion.description && <p className="text-text-secondary">{promotion.description}</p>}
      {promotion.prizeDescription && (
        <p className="text-text-secondary">
          <span className="font-medium text-text-primary">Prize: </span>
          {promotion.prizeDescription}
        </p>
      )}
      {promotion.eligibilitySummary && <p className="text-xs text-text-muted">{promotion.eligibilitySummary}</p>}
      <p className="text-xs text-text-muted">
        Run by {promotion.fulfillmentName}.{" "}
        <a href={promotion.officialRulesUrl} target="_blank" rel="sponsored noopener noreferrer" className="font-medium text-accent-primary underline-offset-2 hover:underline">
          Official rules
        </a>
      </p>
      <p className="text-xs text-text-muted">{PROMOTION_DISCLOSURE}</p>
    </section>
  );
}
