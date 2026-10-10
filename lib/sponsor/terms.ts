// Sponsor legal documents: the REGISTRY (identity, version, effective date, status, route) and the rule for when each one binds a Sponsor.
//
// NOTHING HERE IS COUNSEL-APPROVED. The texts (components/legal/SponsorTermsDocument.tsx, components/legal/MediaAgreementTerms.tsx) were drafted by
// engineering so the product could be built end to end; every one is `status: "DRAFT"` and renders with a visible DRAFT banner. A DRAFT binds nobody:
// the signup checkbox, the per-campaign acceptance and the re-consent gate all switch on ONLY when a document is `APPROVED`, so a draft can never be
// accepted by mistake and the acceptance UI is never "legally final" by accident.
//
// OWNER/COUNSEL DECISION REQUIRED to go live with each document: counsel approves the wording; then change its `status` to "APPROVED" and set a
// real `version` and `effectiveDate` (the version is what every acceptance stores, so a new version means a new acceptance). That is the whole switch.
// Changing the version later does not retroactively bind existing Sponsors; they accept the new version at their next sign-in (see
// lib/sponsor/legal-acceptance.ts). Member Terms and Privacy are NOT here (lib/legal/documents.ts) and are never re-consented by anything in this file.
export type SponsorLegalStatus = "DRAFT" | "APPROVED";

export interface SponsorLegalDocument {
  /** Stored with every acceptance. */
  key: string;
  title: string;
  /** Stored with every acceptance — the exact text a Sponsor accepted. */
  version: string;
  /** Shown on the page; null while the document is a draft (it has no effective date until someone approves it). */
  effectiveDate: string | null;
  status: SponsorLegalStatus;
  /** The published page with the text. */
  href: string;
  /**
   * The Sponsor refund cutoff (hours before kickoff) THIS VERSION OF THE TEXT states. Part of the legal version, not of operational configuration: once a document is
   * APPROVED, the text it renders uses this number, and a configured cutoff that differs from it blocks new submissions until a new version is approved
   * (lib/sponsor/commercial-legal-gate.ts). null while a document is a draft — nothing approved states a number yet.
   */
  refundCutoffHours?: number | null;
}

export const SPONSOR_TERMS_KEY = "sponsor_terms";
export const MEDIA_AGREEMENT_KEY = "media_agreement";

export const SPONSOR_TERMS_DOCUMENT: SponsorLegalDocument = {
  key: SPONSOR_TERMS_KEY,
  title: "Sponsor Terms",
  version: "DRAFT-1",
  effectiveDate: null,
  status: "DRAFT",
  href: "/sponsor/terms",
};

/** The per-campaign media / advertising agreement: its standing terms (the campaign-specific schedule is generated from the canonical sponsorship record). */
export const MEDIA_AGREEMENT_DOCUMENT: SponsorLegalDocument = {
  key: MEDIA_AGREEMENT_KEY,
  title: "Media and Advertising Agreement",
  version: "DRAFT-1",
  effectiveDate: null,
  status: "DRAFT",
  href: "/sponsor/terms#media-agreement",
};

/** The document a Sponsor must accept right now, or null when none is approved (a draft binds nobody). */
export function requiredDocument(doc: SponsorLegalDocument): SponsorLegalDocument | null {
  return doc.status === "APPROVED" ? doc : null;
}

/**
 * The Sponsor section of the Privacy Policy. It lives INSIDE the Member Privacy Policy page (lib/legal/documents.ts owns that document's version and Member re-consent), so it
 * has no version of its own — only a status that says whether counsel has approved the section's wording. While DRAFT, the section carries a visible banner.
 */
export const SPONSOR_PRIVACY_SECTION: { key: string; title: string; status: SponsorLegalStatus; href: string } = {
  key: "privacy_sponsor_section",
  title: "Privacy Policy — Sponsor accounts and sponsorships",
  status: "DRAFT",
  href: "/privacy#sponsors",
};

/** The cutoff to SHOW in legal text: an approved version states its own number; a draft shows the configured one (it states nothing yet). */
export function legalRefundCutoffHours(doc: SponsorLegalDocument, configuredHours: number | null): number | null {
  return doc.status === "APPROVED" && doc.refundCutoffHours != null ? doc.refundCutoffHours : configuredHours;
}

export const CURRENT_SPONSOR_TERMS = requiredDocument(SPONSOR_TERMS_DOCUMENT);
export const CURRENT_MEDIA_AGREEMENT = requiredDocument(MEDIA_AGREEMENT_DOCUMENT);
