// Sponsor-facing wording for a missing legal step (provider-neutral, no legal text). Kept apart from the server-only gate so components can use it.
export type LegalRequirement = "SPONSOR_TERMS" | "MEDIA_AGREEMENT" | "REFUND_POLICY";

/** Sponsor-facing wording for what is missing (provider-neutral, no legal text). */
export function legalRequirementCopy(missing: LegalRequirement[]): string {
  if (missing.includes("SPONSOR_TERMS")) return "Please accept the current Sponsor Terms to continue.";
  if (missing.includes("MEDIA_AGREEMENT")) return "Please accept the Media and Advertising Agreement for this campaign before paying.";
  if (missing.includes("REFUND_POLICY")) return "New sponsorships are paused briefly while Brohda updates its Sponsor Terms. Please check back soon.";
  return "A required agreement hasn't been accepted yet.";
}
