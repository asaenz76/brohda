import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { hasAcceptedCurrentSponsorTerms } from "./legal-acceptance";
import { CURRENT_MEDIA_AGREEMENT, CURRENT_SPONSOR_TERMS, type SponsorLegalDocument } from "./terms";

// THE canonical commercial legal-eligibility check for a Sponsor. One place answers "may this Sponsor take a new commercial step right now?" — so legal gating is never
// scattered through payment, submission or admin code, and never provider-specific. It is separate from every other gate (email verification, Sponsor account approval, the
// capability switch, payment, campaign approval): this one is ONLY about whether the required legal texts have been accepted.
//
//   SPONSOR_TERMS    the current APPROVED Sponsor Terms version has not been accepted by this account (a draft requires nothing)
//   MEDIA_AGREEMENT  the current APPROVED media agreement has not been accepted for THIS campaign at its CURRENT content revision
//   REFUND_POLICY    the configured refund cutoff differs from the one the approved Sponsor Terms state — new submissions wait for a new approved version
//                    (so changing a database setting can never silently change what an accepted legal text means)
//
// Everything is resolved on the server from the registry and the database; nothing here reads a version, a timestamp or an account id from a browser.
export type LegalRequirement = "SPONSOR_TERMS" | "MEDIA_AGREEMENT" | "REFUND_POLICY";
export type CommercialLegalStatus = { ok: true } | { ok: false; missing: LegalRequirement[] };
/** SUBMIT: putting a campaign in front of Brohda. PAYMENT: starting a payment for a submitted campaign. */
export type CommercialStage = "SUBMIT" | "PAYMENT";

export interface LegalGateDocs {
  terms: SponsorLegalDocument | null;
  agreement: SponsorLegalDocument | null;
}

/** True when an approved Sponsor Terms version states a refund cutoff that the configured one doesn't match. */
export function refundPolicyDiffersFromApprovedTerms(terms: SponsorLegalDocument | null, configuredHours: number): boolean {
  return Boolean(terms && terms.status === "APPROVED" && terms.refundCutoffHours != null && terms.refundCutoffHours !== configuredHours);
}

/** True when `agreement` has been accepted for this campaign at its CURRENT content revision (a later edit makes a new revision, which needs a new acceptance). */
export async function agreementAcceptedForCurrentRevision(sponsorshipId: string, agreement: SponsorLegalDocument): Promise<boolean> {
  const admin = createAdminClient();
  const { data: s } = await admin.from("sponsorships").select("revision").eq("id", sponsorshipId).single();
  if (!s) return false;
  const { data } = await admin.from("sponsorship_agreement_acceptances").select("id").eq("sponsorship_id", sponsorshipId).eq("agreement_key", agreement.key).eq("agreement_version", agreement.version).eq("revision", s.revision).limit(1);
  return (data ?? []).length > 0;
}

export async function sponsorCommercialLegalStatus(
  input: { userId: string; sponsorshipId: string | null; stage: CommercialStage },
  docs: LegalGateDocs = { terms: CURRENT_SPONSOR_TERMS, agreement: CURRENT_MEDIA_AGREEMENT },
): Promise<CommercialLegalStatus> {
  const missing: LegalRequirement[] = [];
  if (!(await hasAcceptedCurrentSponsorTerms(input.userId, docs.terms))) missing.push("SPONSOR_TERMS");

  if (input.stage === "SUBMIT") {
    // The agreement is accepted IN the submit step itself (sponsor_submit_with_agreement); what must already hold is that the terms' own refund number is still in force.
    if (docs.terms && refundPolicyDiffersFromApprovedTerms(docs.terms, (await getSponsorshipConfig()).refundCutoffHours)) missing.push("REFUND_POLICY");
  } else if (docs.agreement && input.sponsorshipId) {
    if (!(await agreementAcceptedForCurrentRevision(input.sponsorshipId, docs.agreement))) missing.push("MEDIA_AGREEMENT");
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** Sponsor-facing wording for what is missing (provider-neutral, no legal text). */
export function legalRequirementCopy(missing: LegalRequirement[]): string {
  if (missing.includes("SPONSOR_TERMS")) return "Please accept the current Sponsor Terms to continue.";
  if (missing.includes("MEDIA_AGREEMENT")) return "Please accept the Media and Advertising Agreement for this campaign before paying.";
  if (missing.includes("REFUND_POLICY")) return "New sponsorships are paused briefly while Brohda updates its Sponsor Terms. Please check back soon.";
  return "A required agreement hasn't been accepted yet.";
}
