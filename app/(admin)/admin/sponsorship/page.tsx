import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/session";
import { LocalDateTime } from "@/components/LocalDateTime";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { listAllSponsorships } from "@/lib/sponsorship/repository";
import { formatCommercialAmount, PAYMENT_STATUS_LABEL, sponsorStatusCopy } from "@/lib/sponsorship/format";
import { SponsorshipNav } from "./sponsorship-nav";
import { ProviderStatusCard } from "@/components/sponsorship/ProviderStatusCard";

const GROUPS: Array<{ title: string; lifecycle: string[] }> = [
  { title: "Needs review or payment", lifecycle: ["SUBMITTED"] },
  { title: "Scheduled and live", lifecycle: ["SCHEDULED", "LIVE"] },
  { title: "Suspended", lifecycle: ["SUSPENDED"] },
  { title: "History", lifecycle: ["COMPLETED", "REJECTED", "CANCELLED", "DRAFT"] },
];

// Super Admin review queue. Operational access is unaffected by the capability switch (history and review stay available when it is OFF).
export default async function SponsorshipQueuePage() {
  await requireSuperAdmin();
  const [enabled, all] = await Promise.all([isSponsorshipEnabled(), listAllSponsorships()]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Sponsorship</h1>
      <SponsorshipNav active="/admin/sponsorship" />
      <p className={enabled ? "text-sm text-text-secondary" : "text-sm font-medium text-warning-muted"}>
        Sponsored Game Posts is <strong>{enabled ? "ON" : "OFF"}</strong>. {enabled ? "" : "Nothing sponsored is shown to members and sponsors cannot submit. "}
        <Link href="/admin/settings/brohda" className="text-accent-primary hover:underline">Change in Settings</Link>
      </p>
      <ProviderStatusCard />
      {GROUPS.map((group) => {
        const rows = all.filter((s) => group.lifecycle.includes(s.lifecycle));
        return (
          <section key={group.title} aria-label={group.title} className="space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">
              {group.title} <span className="font-normal text-text-muted">({rows.length})</span>
            </h2>
            {rows.length === 0 ? (
              <p className="text-sm text-text-muted">None.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border-subtle">
                <table className="w-full text-sm">
                  <thead className="bg-surface-secondary text-left text-text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Sponsor</th>
                      <th className="px-3 py-2 font-medium">Game</th>
                      <th className="px-3 py-2 font-medium">Kickoff</th>
                      <th className="px-3 py-2 font-medium">Price</th>
                      <th className="px-3 py-2 font-medium">Payment</th>
                      <th className="px-3 py-2 font-medium">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.id} className="border-t border-border-subtle">
                        <td className="px-3 py-2 text-text-primary">{s.sponsorName}</td>
                        <td className="px-3 py-2">
                          <Link href={`/admin/sponsorship/${s.id}`} className="font-medium text-accent-primary hover:underline">
                            {s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName}` : s.campaignName}
                          </Link>
                          <span className="block text-xs text-text-muted">{s.game?.competitionName} · {s.marketCode}</span>
                        </td>
                        <td className="px-3 py-2 text-text-secondary">{s.game && <LocalDateTime iso={s.game.scheduledStartUtc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}</td>
                        <td className="px-3 py-2 text-text-secondary">{formatCommercialAmount(s.priceCents, s.currency)}</td>
                        <td className="px-3 py-2 text-text-secondary">{PAYMENT_STATUS_LABEL[s.paymentStatus]}</td>
                        <td className="px-3 py-2 text-text-secondary">{sponsorStatusCopy(s).label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
