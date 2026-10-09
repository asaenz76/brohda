import Link from "next/link";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { requireSponsorAccount } from "@/lib/sponsor/session";
import { sponsorAccountStatusCopy } from "@/lib/sponsor/status";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { listSponsorshipsForSponsor } from "@/lib/sponsorship/repository";
import { formatCommercialAmount, sponsorStatusCopy } from "@/lib/sponsorship/format";

// The Sponsor's home. It always shows where the ACCOUNT stands (under review / approved / not approved / suspended / disabled) and only that sponsor's own
// sponsorships. Browsing Games and starting a sponsorship need an ACTIVE account AND the sponsorship capability being on.
export default async function SponsorHomePage() {
  const { sponsor } = await requireSponsorAccount();
  const copy = sponsorAccountStatusCopy(sponsor.status, sponsor.statusReason);
  const [enabled, sponsorships] = await Promise.all([isSponsorshipEnabled(), listSponsorshipsForSponsor(sponsor.id)]);

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
                  return (
                    <li key={s.id} className="py-3">
                      <Link href={`/sponsor/${s.id}`} className="block space-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50">
                        <p className="text-sm font-medium text-text-primary">{s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName}` : s.campaignName}</p>
                        <p className="text-xs text-text-muted">
                          {s.game?.competitionName ? `${s.game.competitionName} · ` : ""}
                          {s.game && <LocalDateTime iso={s.game.scheduledStartUtc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}
                          {" · "}
                          {formatCommercialAmount(s.priceCents, s.currency)}
                        </p>
                        <p className="text-sm text-text-secondary">{status.label}</p>
                      </Link>
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
