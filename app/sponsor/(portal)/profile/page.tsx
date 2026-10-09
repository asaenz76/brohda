import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { Card, CardContent } from "@/components/ui/card";
import { requireSponsorAccount } from "@/lib/sponsor/session";
import { sponsorAccountStatusCopy } from "@/lib/sponsor/status";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { SponsorProfileForm } from "./profile-form";

export default async function SponsorProfilePage() {
  const { sponsor, email } = await requireSponsorAccount();
  const copy = sponsorAccountStatusCopy(sponsor.status, sponsor.statusReason);
  const logoMaxKb = await getSponsorshipConfig().then((c) => Math.round(c.logoMaxBytes / 1024), () => null);
  return (
    <div className="space-y-3">
      <ColumnHeader title="Sponsor profile" backHref="/sponsor" />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <dl className="grid gap-1 text-sm">
            <dt className="text-xs text-text-muted">Business email (your sign-in)</dt>
            <dd className="text-text-primary" data-slot="sponsor-email">{email ?? "—"}</dd>
          </dl>
          <SponsorProfileForm
            canEdit={copy.canEditProfile}
            brandLocked={sponsor.status !== "PENDING_REVIEW"}
            logoLocked={sponsor.status !== "PENDING_REVIEW"}
            logoMaxKb={logoMaxKb}
            sponsorId={sponsor.id}
            logoUrl={sponsor.logoUrl}
            initial={{ brandName: sponsor.displayName, contactName: sponsor.contactName ?? "", website: sponsor.website ?? "", country: sponsor.country ?? "", phone: sponsor.contactPhone ?? "" }}
          />
          <p className="text-xs text-text-muted">
            Your brand name and logo are shown to Brohda&apos;s Members on sponsored Games, so they&apos;re locked once your account is approved. To change them, contact Brohda.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
