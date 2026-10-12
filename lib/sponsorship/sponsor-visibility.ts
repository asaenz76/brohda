// Sponsor ADMIN LIST VISIBILITY — a separate idea from account status (r72).
//   status      answers "can this Sponsor operate?"                        (sponsors.status; unchanged by hiding)
//   visibility  answers "does it appear in the normal admin Sponsors list?" (sponsor_admin_hidden; admin-only)
// Hiding never deletes anything, never changes status or login, and is not part of any public eligibility rule.
export type SponsorVisibilityFilter = "visible" | "hidden" | "all";

export const DEFAULT_SPONSOR_VISIBILITY: SponsorVisibilityFilter = "visible";

/** The list filter from a URL parameter. Anything unrecognised is the default (visible) — an odd link can never reveal more than the control offers. */
export function parseSponsorVisibility(value: string | string[] | undefined | null): SponsorVisibilityFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "hidden" || v === "all" || v === "visible" ? v : DEFAULT_SPONSOR_VISIBILITY;
}
