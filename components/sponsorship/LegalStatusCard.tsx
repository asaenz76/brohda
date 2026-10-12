import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import { MEDIA_AGREEMENT_DOCUMENT, SPONSOR_PRIVACY_SECTION, SPONSOR_TERMS_DOCUMENT, type SponsorLegalDocument } from "@/lib/sponsor/terms";

// Settings → Brohda → Sponsorship: where each Sponsor legal text stands (legal status is configuration, not review work). READ-ONLY on purpose — legal versions are code-reviewed artifacts (lib/sponsor/terms.ts), not a CMS. Shows only status,
// version and effective date; never any legal text. (The refund cutoff, and the warning when it disagrees with an approved text, are on the refund policy card.)
function Row({ label, value, slot }: { label: string; value: string; slot: string }) {
  return (
    <p className="text-text-secondary">
      {label}: <span className="font-medium text-text-primary" data-slot={slot}>{value}</span>
    </p>
  );
}
const describe = (d: SponsorLegalDocument) => `${d.status === "APPROVED" ? "Approved" : "Draft"} · version ${d.version}${d.effectiveDate ? ` · effective ${d.effectiveDate}` : " · no effective date"}`;

export async function LegalStatusCard() {
  return (
    <section aria-label="Sponsor legal status" data-slot="legal-status" className="space-y-1 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Sponsor legal status</h2>
      <Row label="Sponsor Terms" value={describe(SPONSOR_TERMS_DOCUMENT)} slot="legal-terms" />
      <Row label="Media and Advertising Agreement" value={describe(MEDIA_AGREEMENT_DOCUMENT)} slot="legal-agreement" />
      <Row label="Privacy Policy (Member document)" value={`version ${LEGAL_DOCUMENTS.privacy.version} · effective ${LEGAL_DOCUMENTS.privacy.effectiveDate}`} slot="legal-privacy" />
      <Row label="Privacy — Sponsor section" value={SPONSOR_PRIVACY_SECTION.status === "APPROVED" ? "Approved" : "Draft"} slot="legal-privacy-sponsor" />
      <p className="text-xs text-text-muted">A draft binds nobody: while a document is a draft, no acceptance is requested and nothing is blocked on it.</p>
    </section>
  );
}
