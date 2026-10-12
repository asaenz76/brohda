import { requireSuperAdmin } from "@/lib/auth/session";
import { listAllSponsorships } from "@/lib/sponsorship/repository";
import { REVIEWABLE_SPONSORSHIP } from "@/lib/sponsorship/review-policy";
import { SponsorshipTable } from "@/components/sponsorship/SponsorshipTable";
import { SponsorshipNav } from "../sponsorship-nav";

// Every sponsorship that is NOT waiting for a review decision, grouped by where it stands — so live, suspended, in-progress and past campaigns stay one click away without crowding the
// Review queue. Operational access is unaffected by the capability switch (history stays available when it is OFF).
const GROUPS: Array<{ title: string; match: (s: { lifecycle: string; reviewStatus: string }) => boolean }> = [
  { title: "Reviewed — awaiting payment or changes", match: (s) => s.lifecycle === "SUBMITTED" && s.reviewStatus !== REVIEWABLE_SPONSORSHIP.reviewStatus },
  { title: "Scheduled and live", match: (s) => s.lifecycle === "SCHEDULED" || s.lifecycle === "LIVE" },
  { title: "Suspended", match: (s) => s.lifecycle === "SUSPENDED" },
  { title: "History", match: (s) => ["COMPLETED", "REJECTED", "CANCELLED", "DRAFT"].includes(s.lifecycle) },
];

export default async function SponsorshipCampaignsPage() {
  await requireSuperAdmin();
  const all = await listAllSponsorships();
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Campaigns</h1>
      <SponsorshipNav active="/admin/sponsorship/campaigns" />
      {GROUPS.map((group) => {
        const rows = all.filter(group.match);
        return (
          <section key={group.title} aria-label={group.title} className="space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">
              {group.title} <span className="font-normal text-text-muted">({rows.length})</span>
            </h2>
            {rows.length === 0 ? <p className="text-sm text-text-muted">None.</p> : <SponsorshipTable rows={rows} />}
          </section>
        );
      })}
    </div>
  );
}
