import { requireSuperAdmin } from "@/lib/auth/session";
import { listSponsorApplicationsAwaitingReview, listSponsorshipsAwaitingReview } from "@/lib/sponsorship/repository";
import { ReviewQueue } from "@/components/sponsorship/ReviewQueue";
import { SponsorshipNav } from "./sponsorship-nav";

// Super Admin Review queue — REVIEW WORK ONLY. It answers one question: what needs my review right now? Global configuration (Sponsored Game Posts on/off, online payments and the
// provider, the legal documents' status, the refund cutoff) is not review work and lives in Settings → Brohda. Everything that isn't awaiting a decision (live, suspended, history,
// awaiting payment) is on the Campaigns tab.
export default async function SponsorshipQueuePage() {
  await requireSuperAdmin();
  const [sponsorApplications, sponsorships] = await Promise.all([listSponsorApplicationsAwaitingReview(), listSponsorshipsAwaitingReview()]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Sponsorship</h1>
      <SponsorshipNav active="/admin/sponsorship" />
      <ReviewQueue sponsorApplications={sponsorApplications} sponsorships={sponsorships} />
    </div>
  );
}
