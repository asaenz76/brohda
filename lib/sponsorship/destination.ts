// WHERE A SPONSORED POST LINKS — the one place the rule is written down in TypeScript (the database has its twin, sponsorship_effective_destination(), used when an approval
// freezes the value; an integration test keeps the two identical).
//
//     the sponsorship's own destination link  ??  the Sponsor profile website  ??  no link
//
// The destination link on a campaign is OPTIONAL. The Sponsor profile website is the fallback and is never copied onto the sponsorship: it is resolved when read (the review
// screen, the editor hint) and frozen at APPROVAL, so a profile edit after approval can't move a live sponsored post. The public click path serves only the frozen value.
export type DestinationSource = "CAMPAIGN" | "SPONSOR_PROFILE" | "NONE";

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export interface EffectiveDestination {
  url: string | null;
  source: DestinationSource;
}

/** The destination a campaign would use right now. Both inputs are already validated URLs (database + validation schema); blank means "not set". */
export function resolveEffectiveSponsorUrl(campaignDestinationUrl: string | null | undefined, sponsorWebsite: string | null | undefined): EffectiveDestination {
  const campaign = clean(campaignDestinationUrl);
  if (campaign) return { url: campaign, source: "CAMPAIGN" };
  const profile = clean(sponsorWebsite);
  if (profile) return { url: profile, source: "SPONSOR_PROFILE" };
  return { url: null, source: "NONE" };
}

/** A short, readable form of a URL for hints ("example.com/launch"); the full URL is never abbreviated where it is acted on. */
export function displayUrl(url: string | null | undefined): string {
  const t = clean(url);
  if (!t) return "";
  try {
    const u = new URL(t);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return t;
  }
}
