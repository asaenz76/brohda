import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocalDateTime } from "@/components/LocalDateTime";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { listAvailableInventory, listSponsorsForUser } from "@/lib/sponsorship/repository";
import { formatCommercialAmount } from "@/lib/sponsorship/format";
import { startSponsorshipAction } from "@/lib/actions/sponsorship";

// Available Games for a sponsor: only sponsorable, still-open, unheld inventory, with its price. No odds, no Picks, no user data. Unavailable entirely while
// the capability is OFF.
export default async function SponsorGamesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const sponsors = (await listSponsorsForUser(user.id)).filter((s) => s.status === "ACTIVE");
  if (sponsors.length === 0) notFound();
  const enabled = await isSponsorshipEnabled();
  const { error } = await searchParams;
  const inventory = enabled ? await listAvailableInventory() : [];

  return (
    <div className="space-y-3">
      <ColumnHeader title="Available Games" backHref="/sponsor" />
      {error && (
        <p role="alert" className="text-sm font-medium text-warning-muted">
          {error}
        </p>
      )}
      {!enabled ? (
        <p role="status" className="rounded-lg border border-border-subtle p-3 text-sm text-text-secondary">Sponsored Game Posts aren&apos;t open right now.</p>
      ) : inventory.length === 0 ? (
        <p className="text-sm text-text-secondary">No Games are available to sponsor right now. Check back soon.</p>
      ) : (
        inventory.map((item) => (
          <Card key={item.id}>
            <CardContent className="space-y-3 pt-6">
              <div className="space-y-0.5">
                <p className="text-base font-semibold text-text-primary">{item.game ? `${item.game.awayTeamName} @ ${item.game.homeTeamName}` : "Game"}</p>
                <p className="text-xs text-text-muted">
                  {item.game?.competitionName ? `${item.game.competitionName} · ` : ""}
                  {item.game && <LocalDateTime iso={item.game.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}
                  {" · "}Market: {item.marketCode === "GLOBAL" ? "Global" : item.marketCode}
                </p>
                <p className="text-sm font-medium text-text-primary">{formatCommercialAmount(item.priceCents, item.currency)}</p>
              </div>
              <form action={startSponsorshipAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="inventoryId" value={item.id} />
                {sponsors.length === 1 ? (
                  <input type="hidden" name="sponsorId" value={sponsors[0].id} />
                ) : (
                  <label className="text-xs text-text-muted">
                    Sponsor
                    <select name="sponsorId" className="mt-1 block rounded-md border border-border-subtle bg-background px-2 py-2 text-sm text-text-primary">
                      {sponsors.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="min-w-0 flex-1 text-xs text-text-muted">
                  Campaign name (private)
                  <Input name="campaignName" required maxLength={120} defaultValue={item.game ? `${item.game.awayTeamName} @ ${item.game.homeTeamName}` : ""} className="mt-1" />
                </label>
                <Button type="submit">Start sponsorship</Button>
              </form>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
