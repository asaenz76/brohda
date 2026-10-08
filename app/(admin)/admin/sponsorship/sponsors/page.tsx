import { requireSuperAdmin } from "@/lib/auth/session";
import { listSponsors } from "@/lib/sponsorship/repository";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { SponsorshipNav } from "../sponsorship-nav";
import { SponsorsManager } from "./sponsors-manager";

export default async function SponsorsPage() {
  await requireSuperAdmin();
  const [sponsors, config] = await Promise.all([listSponsors(), getSponsorshipConfig()]);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Sponsors</h1>
      <SponsorshipNav active="/admin/sponsorship/sponsors" />
      <SponsorsManager
        logoMaxKb={Math.round(config.logoMaxBytes / 1024)}
        sponsors={sponsors.map((s) => ({ id: s.id, displayName: s.displayName, legalName: s.legalName, contactEmail: s.contactEmail, status: s.status, logoUrl: s.logoUrl, members: s.members }))}
      />
    </div>
  );
}
