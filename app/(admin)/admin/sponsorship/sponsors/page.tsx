import { requireSuperAdmin } from "@/lib/auth/session";
import { listSponsors } from "@/lib/sponsorship/repository";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { SponsorshipNav } from "../sponsorship-nav";
import { SponsorsManager } from "./sponsors-manager";

export default async function SponsorsPage() {
  await requireSuperAdmin();
  const [all, config] = await Promise.all([listSponsors(), getSponsorshipConfig()]);
  // Applications waiting for a decision first, oldest first; everyone else after, newest first.
  const pending = all.filter((s) => s.status === "PENDING_REVIEW").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sponsors = [...pending, ...all.filter((s) => s.status !== "PENDING_REVIEW")];
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Sponsors</h1>
      <p role="status" data-slot="sponsor-applications-count" className="text-sm text-text-secondary">
        {pending.length === 0 ? "No applications waiting for review." : `${pending.length} application${pending.length === 1 ? "" : "s"} waiting for review.`}
      </p>
      <SponsorshipNav active="/admin/sponsorship/sponsors" />
      <SponsorsManager
        logoMaxKb={Math.round(config.logoMaxBytes / 1024)}
        sponsors={sponsors.map((s) => ({ id: s.id, displayName: s.displayName, legalName: s.legalName, contactEmail: s.contactEmail, contactName: s.contactName, contactPhone: s.contactPhone, website: s.website, country: s.country, status: s.status, statusReason: s.statusReason, internalReviewNote: s.internalReviewNote, createdAt: s.createdAt, logoUrl: s.logoUrl, login: s.login ? { email: s.login.email, emailVerified: s.login.emailVerified } : null }))}
      />
    </div>
  );
}
