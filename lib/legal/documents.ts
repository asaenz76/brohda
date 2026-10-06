// The published legal documents' identity: which version is current, and the effective date the page shows. ONE place, so the version a
// member accepts (recorded in `legal_acceptances`) and the date on the page can never drift apart, and so an owner can change either
// deliberately — and only deliberately.
//
// OWNER/COUNSEL DECISION REQUIRED: these values have NOT been chosen for the current text. Both documents were corrected for factual product
// accuracy after the "July 22, 2026" date (see docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md), and engineering does not pick legal effective
// dates. They are left at the dates the pages already carried. To publish a new version: change `version` and `effectiveDate` here together
// (version is the identifier stored with every acceptance; the date is what readers see). To require everyone to re-accept it, ALSO list the
// document in platform_settings.legal_reconsent_required — a separate, deliberate step that is never taken for a copy edit.
export type LegalDocument = "terms" | "privacy";

export interface LegalDocumentInfo {
  /** Stored with every acceptance. Any stable, unique identifier; by convention the effective date in ISO form. */
  version: string;
  /** Shown on the page ("Effective …"). */
  effectiveDate: string;
}

export const LEGAL_DOCUMENTS: Record<LegalDocument, LegalDocumentInfo> = {
  terms: { version: "2026-07-22", effectiveDate: "July 22, 2026" },
  privacy: { version: "2026-07-22", effectiveDate: "July 22, 2026" },
};

export const LEGAL_DOCUMENT_NAMES: Record<LegalDocument, string> = { terms: "Terms of Service", privacy: "Privacy Policy" };
export const LEGAL_DOCUMENT_ORDER: readonly LegalDocument[] = ["terms", "privacy"];

export type LegalAcceptanceSource = "register" | "invitation" | "reconsent";
