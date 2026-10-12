import Link from "next/link";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { requireSponsorAccount } from "@/lib/sponsor/session";
import { sponsorAccountStatusCopy } from "@/lib/sponsor/status";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { listSponsorshipsForSponsor } from "@/lib/sponsorship/repository";
import { resolveOnlinePayment } from "@/lib/payments/active-provider";
import { sponsorPaymentEligibility } from "@/lib/sponsorship/payment-eligibility";
import { APPROVAL_STATUS_LABEL, formatCommercialAmount, paymentStateLabel, sponsorStatusCopy } from "@/lib/sponsorship/format";

// The Sponsor's home. It always shows where the ACCOUNT stands (under review / approved / not approved / suspended / disabled) and only that sponsor's own
// sponsorships. Browsing Games and starting a sponsorship need an ACTIVE account AND the sponsorship capability being on.
export default async function SponsorHomePage() {
  const { sponsor, userId } = await requireSponsorAccount();
  const copy = sponsorAccountStatusCopy(sponsor.status, sponsor.statusReason);
  const [enabled, sponsorships] = await Promise.all([isSponsorshipEnabled(), listSponsorshipsForSponsor(sponsor.id)]);
  // Pay now is offered per sponsorship by the SAME canonical check the sponsorship page and the payment service use (account, state, provider availability, legal acceptance).
  // The provider policy is read once for the whole list.
  const awaitingPayment = sponsorships.some((x) => x.lifecycle === "SUBMITTED");
  const online = awaitingPayment ? await resolveOnlinePayment() : undefined;
  const eligibility = new Map(await Promise.all(sponsorships.map(async (x) => [x.id, await sponsorPaymentEligibility({ userId, sponsorStatus: sponsor.status, capabilityEnabled: enabled, sponsorship: { id: x.id, lifecycle: x.lifecycle, paymentStatus: x.paymentStatus }, online })] as const)));

  return (
    <div className="space-y-3">
      <ColumnHeader title="Sponsor dashboard" />
      <div role="status" className="space-y-1 rounded-lg border border-border-subtle p-3" data-slot="sponsor-account-status">
        <p className="text-sm font-semibold text-text-primary">{copy.label}</p>
        <p className="text-sm text-text-secondary">{copy.detail}</p>
        {copy.canEditProfile && (
          <Link href="/sponsor/profile" className="inline-block pt-1 text-sm font-medium text-accent-primary hover:underline">
            {sponsor.status === "PENDING_REVIEW" ? "Complete your profile" : "Edit your profile"}
          </Link>
        )}
      </div>
      {copy.commercialAccess && !enabled && (
        <p role="status" className="rounded-lg border border-border-subtle p-3 text-sm text-text-secondary">
          Sponsored Game Posts aren&apos;t open right now. Your existing sponsorships are listed below; new ones can&apos;t be started or submitted.
        </p>
      )}
      {copy.commercialAccess && enabled && (
        <Link href="/sponsor/games" className="inline-flex rounded-md bg-accent-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          Browse available Games
        </Link>
      )}
      {(copy.commercialAccess || sponsorships.length > 0) && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h2 className="text-base font-semibold text-text-primary">Your sponsorships</h2>
            {sponsorships.length === 0 ? (
              <p className="text-sm text-text-secondary">No sponsorships yet.</p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {sponsorships.map((s) => {
                  const status = sponsorStatusCopy(s);
                  const canPay = eligibility.get(s.id)?.state === "PAY_NOW";
                  return (
                    <li key={s.id} className="py-3" data-slot="sponsorship-row">
                      <Link href={`/sponsor/${s.id}`} className="block space-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50">
                        <p className="text-sm font-medium text-text-primary">{s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName}` : s.campaignName}</p>
                        <p className="text-xs text-text-muted">
                          {s.game?.competitionName ? `${s.game.competitionName} · ` : ""}
                          {s.game && <LocalDateTime iso={s.game.scheduledStartUtc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}
                        </p>
                        <p className="text-sm text-text-secondary">{status.label}</p>
                        <p className="text-xs text-text-muted" data-slot="sponsorship-commercial">
                          <span data-slot="row-amount">{formatCommercialAmount(s.priceCents, s.currency)}</span>
                          {" · "}Payment: <span data-slot="row-payment">{paymentStateLabel(s.paymentStatus, false)}</span>
                          {" · "}Approval: <span data-slot="row-approval">{APPROVAL_STATUS_LABEL[s.reviewStatus] ?? s.reviewStatus}</span>
                          {" · "}Window: <LocalDateTime iso={s.startsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> – <LocalDateTime iso={s.endsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                        </p>
                      </Link>
                      {canPay && (
                        <Link href={`/sponsor/${s.id}`} data-slot="row-pay-now" className="mt-1 inline-flex rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
                          Pay now
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
