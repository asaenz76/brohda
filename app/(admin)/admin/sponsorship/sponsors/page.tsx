import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/session";
import { countHiddenSponsors, countReviewItems, listSponsors } from "@/lib/sponsorship/repository";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { parseSponsorVisibility, type SponsorVisibilityFilter } from "@/lib/sponsorship/sponsor-visibility";
import { SponsorshipNav } from "../sponsorship-nav";
import { SponsorsManager } from "./sponsors-manager";

const FILTERS: Array<{ value: SponsorVisibilityFilter; label: string }> = [
  { value: "visible", label: "Visible" },
  { value: "hidden", label: "Hidden" },
  { value: "all", label: "All" },
];
const EMPTY: Record<SponsorVisibilityFilter, string> = { visible: "No sponsors yet.", hidden: "No hidden sponsors.", all: "No sponsors yet." };

// Sponsor accounts. By default only NON-hidden Sponsors are listed; "Hidden" and "All" bring hidden ones back. Hiding is admin list visibility only — separate from account status — so a
// hidden Sponsor can be ACTIVE, DISABLED or anything else, and a pending application that is hidden still surfaces in the Review queue.
export default async function SponsorsPage({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  await requireSuperAdmin();
  const show = parseSponsorVisibility((await searchParams).show);
  const [sponsors, config, hiddenCount, review] = await Promise.all([listSponsors({ visibility: show }), getSponsorshipConfig(), countHiddenSponsors(), countReviewItems()]);
  // Applications waiting for a decision first, oldest first; everyone else after, newest first.
  const pending = sponsors.filter((s) => s.status === "PENDING_REVIEW").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ordered = [...pending, ...sponsors.filter((s) => s.status !== "PENDING_REVIEW")];
  const waiting = review.sponsorApplications; // every application awaiting review, hidden or not — hiding never buries review work
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Sponsors</h1>
      <p role="status" data-slot="sponsor-applications-count" className="text-sm text-text-secondary">
        {waiting === 0 ? "No applications waiting for review." : `${waiting} application${waiting === 1 ? "" : "s"} waiting for review.`}
      </p>
      <SponsorshipNav active="/admin/sponsorship/sponsors" />
      <nav aria-label="Sponsor visibility" className="flex flex-wrap items-center gap-2 text-sm" data-slot="sponsor-visibility-filter">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "visible" ? "/admin/sponsorship/sponsors" : `/admin/sponsorship/sponsors?show=${f.value}`}
            aria-current={f.value === show ? "page" : undefined}
            className={f.value === show ? "rounded-md bg-secondary px-3 py-1 font-medium text-text-primary" : "rounded-md px-3 py-1 text-text-secondary hover:bg-secondary"}
          >
            {f.label}
            {f.value === "hidden" && hiddenCount > 0 ? ` (${hiddenCount})` : ""}
          </Link>
        ))}
      </nav>
      <SponsorsManager
        emptyText={EMPTY[show]}
        logoMaxKb={Math.round(config.logoMaxBytes / 1024)}
        sponsors={ordered.map((s) => ({ id: s.id, displayName: s.displayName, legalName: s.legalName, contactEmail: s.contactEmail, contactName: s.contactName, contactPhone: s.contactPhone, website: s.website, country: s.country, status: s.status, statusReason: s.statusReason, internalReviewNote: s.internalReviewNote, createdAt: s.createdAt, logoUrl: s.logoUrl, login: s.login ? { email: s.login.email, emailVerified: s.login.emailVerified } : null, hiddenAt: s.hiddenAt }))}
      />
    </div>
  );
}
