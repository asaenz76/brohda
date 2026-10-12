import Link from "next/link";
import { LocalDateTime } from "@/components/LocalDateTime";
import { formatCommercialAmount, PAYMENT_STATUS_LABEL, sponsorStatusCopy } from "@/lib/sponsorship/format";
import type { SponsorshipRecord } from "@/lib/sponsorship/repository";

// One table of sponsorships (Sponsor, Game, Kickoff, Price, Payment, State), each row linking to that sponsorship's admin page. Used by the Review queue (requests awaiting review) and
// by the Campaigns tab (everything else) so the two never drift apart.
export function SponsorshipTable({ rows }: { rows: SponsorshipRecord[] }) {
  return (
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
            <tr key={s.id} className="border-t border-border-subtle" data-sponsorship-id={s.id}>
              <td className="px-3 py-2 text-text-primary">{s.sponsorName}</td>
              <td className="px-3 py-2">
                <Link href={`/admin/sponsorship/${s.id}`} className="font-medium text-accent-primary hover:underline">
                  {s.game ? `${s.game.awayTeamName} @ ${s.game.homeTeamName}` : s.campaignName}
                </Link>
                <span className="block text-xs text-text-muted">
                  {s.game?.competitionName} · {s.marketCode}
                </span>
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
  );
}
