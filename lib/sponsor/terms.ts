// Sponsor Terms: the MECHANISM only. No legal text is written or implied here.
//
// OWNER/COUNSEL DECISION REQUIRED: there is no approved Sponsor Terms document yet, so `CURRENT_SPONSOR_TERMS` is null and the signup form neither shows nor
// requires an acceptance. When counsel approves a document: publish it at a page, then set this to { version, effectiveDate, href } — from that moment
// every new application must tick the acceptance, and each one is recorded (account, version, time) in `sponsor_terms_acceptances`. Changing the version
// does not retroactively bind existing Sponsors; that is a separate, deliberate step.
export const SPONSOR_TERMS_KEY = "sponsor_terms";

export interface SponsorTermsDocument {
  /** Stored with every acceptance. */
  version: string;
  /** Shown beside the link. */
  effectiveDate: string;
  /** The published page with the approved text. */
  href: string;
}

export const CURRENT_SPONSOR_TERMS: SponsorTermsDocument | null = null;
