import type { Metadata } from "next";
import { SponsorTermsDocument } from "@/components/legal/SponsorTermsDocument";
import { Button } from "@/components/ui/button";
import { publicAccountNav } from "@/components/shell/PublicAccountNav";
import { getSponsorSession } from "@/lib/sponsor/session";
import { hasAcceptedCurrentSponsorTerms } from "@/lib/sponsor/legal-acceptance";
import { CURRENT_SPONSOR_TERMS } from "@/lib/sponsor/terms";
import { acceptSponsorTermsAction } from "@/lib/actions/sponsor-account";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";

export const metadata: Metadata = { title: "Sponsor Terms — brohda.", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// The Sponsor Terms are public (linked from the Sponsorship page, Sponsor signup and the Sponsor area). A signed-in Sponsor who still has to accept the
// current APPROVED version sees the accept button here; nothing is offered for a draft.
export default async function SponsorTermsPage() {
  const session = await getSponsorSession();
  const needsAcceptance = Boolean(session && CURRENT_SPONSOR_TERMS && !(await hasAcceptedCurrentSponsorTerms(session.userId)));
  const refundCutoffHours = await getSponsorshipConfig().then((c) => c.refundCutoffHours, () => null);
  return (
    <SponsorTermsDocument
      refundCutoffHours={refundCutoffHours}
      accountNav={await publicAccountNav()}
      accept={
        needsAcceptance ? (
          <form action={acceptSponsorTermsAction} className="rounded-lg border border-border-subtle p-4" data-slot="accept-sponsor-terms">
            <p className="mb-3 text-sm text-text-primary">To continue, accept the current Sponsor Terms.</p>
            <Button type="submit">I accept the Sponsor Terms</Button>
          </form>
        ) : null
      }
    />
  );
}
