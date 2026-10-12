import Link from "next/link";
import { LocalDateTime } from "@/components/LocalDateTime";
import { SponsorshipTable } from "@/components/sponsorship/SponsorshipTable";
import type { SponsorRecord, SponsorshipRecord } from "@/lib/sponsorship/repository";

// The Review queue: ONLY objects that need a Super Admin decision right now (what counts is defined once in lib/sponsorship/review-policy.ts). Each row is one specific Sponsor
// application or one specific sponsorship request. No settings, no status cards, no legal or payment configuration — those live in Settings → Brohda. Presentational on purpose:
// the page hands it the already-filtered lists, so it can be tested without a database.
export function ReviewQueue({ sponsorApplications, sponsorships }: { sponsorApplications: SponsorRecord[]; sponsorships: SponsorshipRecord[] }) {
  if (sponsorApplications.length === 0 && sponsorships.length === 0) {
    return (
      <p role="status" data-slot="review-empty" className="rounded-lg border border-border-subtle p-4 text-sm text-text-secondary">
        Nothing to review right now.
      </p>
    );
  }
  return (
    <div className="space-y-4" data-slot="review-queue">
      {sponsorApplications.length > 0 && (
        <section aria-label="Sponsor applications" className="space-y-2" data-slot="review-sponsor-applications">
          <h2 className="text-sm font-semibold text-text-primary">
            Sponsor applications <span className="font-normal text-text-muted">({sponsorApplications.length})</span>
          </h2>
          <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
            {sponsorApplications.map((s) => (
              <li key={s.id} data-sponsor-id={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium text-text-primary">{s.displayName}</span>
                  <span className="block text-xs text-text-muted">
                    {[s.contactName, s.website, s.country].filter(Boolean).join(" · ") || "No details yet"} · applied <LocalDateTime iso={s.createdAt} options={{ month: "short", day: "numeric" }} />
                  </span>
                </span>
                <Link href={`/admin/sponsorship/sponsors#sponsor-${s.id}`} className="font-medium text-accent-primary hover:underline">
                  Review application
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {sponsorships.length > 0 && (
        <section aria-label="Sponsorship requests" className="space-y-2" data-slot="review-sponsorships">
          <h2 className="text-sm font-semibold text-text-primary">
            Sponsorship requests <span className="font-normal text-text-muted">({sponsorships.length})</span>
          </h2>
          <SponsorshipTable rows={sponsorships} />
        </section>
      )}
    </div>
  );
}
