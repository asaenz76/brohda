import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { Card, CardContent } from "@/components/ui/card";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { listSponsorsForUser, listSponsorshipsForSponsor } from "@/lib/sponsorship/repository";
import { formatCommercialAmount, sponsorStatusCopy } from "@/lib/sponsorship/format";
import { LocalDateTime } from "@/components/LocalDateTime";

// The sponsor's home: only for members of a sponsor organization (anyone else gets the ordinary not-found — the area is not advertised). It shows only that
// sponsor's own sponsorships. With the capability OFF it is read-only history: no way to start or submit anything.
export default async function SponsorHomePage() {
  const user = await requireUser();
  const sponsors = await listSponsorsForUser(user.id);
  if (sponsors.length === 0) notFound();
  const enabled = await isSponsorshipEnabled();
  const groups = await Promise.all(sponsors.map(async (sponsor) => ({ sponsor, sponsorships: await listSponsorshipsForSponsor(sponsor.id) })));

  return (
    <div className="space-y-3">
      <ColumnHeader title="Sponsorships" backHref="/feed" />
      {!enabled && (
        <p role="status" className="rounded-lg border border-border-subtle p-3 text-sm text-text-secondary">
          Sponsored Game Posts aren&apos;t open right now. Your existing sponsorships are listed below; new ones can&apos;t be started or submitted.
        </p>
      )}
      {enabled && (
        <Link href="/sponsor/games" className="inline-flex rounded-md bg-accent-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          Browse available Games
        </Link>
      )}
      {groups.map(({ sponsor, sponsorships }) => (
        <Card key={sponsor.id}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-text-primary">{sponsor.displayName}</h2>
              {sponsor.status !== "ACTIVE" && <span className="text-xs font-medium text-warning-muted">Account {sponsor.status.toLowerCase()}</span>}
            </div>
            {sponsorships.length === 0 ? (
              <p className="text-sm text-text-secondary">No sponsorships yet.</p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {sponsorships.map((s) => {
                  const copy = sponsorStatusCopy(s);
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
                        <p className="text-sm text-text-secondary">{copy.label}</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
