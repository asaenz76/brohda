import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalDateTime } from "@/components/LocalDateTime";
import { listAllInventory } from "@/lib/sponsorship/repository";
import { getSponsorshipConfig } from "@/lib/sponsorship/settings";
import { GLOBAL_MARKET } from "@/lib/sponsorship/geography";
import { PAYMENT_STATUS_LABEL } from "@/lib/sponsorship/format";
import { SponsorshipNav } from "../sponsorship-nav";
import { InventoryRow } from "./inventory-row";

// The Games schedule IS the inventory calendar: upcoming published Game Posts, each of which Super Admin may mark sponsorable with a price, market and window.
// Nothing is sponsorable until it is set here.
export default async function SponsorshipInventoryPage() {
  await requireSuperAdmin();
  const admin = createAdminClient();
  const now = new Date();
  const [config, inventory, postsResult] = await Promise.all([
    getSponsorshipConfig(),
    listAllInventory(),
    admin
      .from("posts")
      .select("id, fixture_id, fixtures!inner(home_team_name, away_team_name, competition_name, scheduled_start_utc, internal_status)")
      .not("published_at", "is", null)
      .gt("fixtures.scheduled_start_utc", now.toISOString())
      .eq("fixtures.internal_status", "NOT_STARTED")
      .order("scheduled_start_utc", { referencedTable: "fixtures", ascending: true })
      .limit(120),
  ]);
  const byPost = new Map(inventory.filter((i) => i.marketCode === GLOBAL_MARKET).map((i) => [i.postId, i]));
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const posts = ((postsResult.data ?? []) as any[]).map((p) => ({ ...p, fixture: Array.isArray(p.fixtures) ? p.fixtures[0] : p.fixtures }));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Sponsorship inventory</h1>
      <SponsorshipNav active="/admin/sponsorship/inventory" />
      <p className="text-sm text-text-secondary">Upcoming Game Posts. Mark a Game sponsorable, set its price and campaign window. Only Global inventory is shown to members today (no trusted location signal exists yet).</p>
      <div className="space-y-2">
        {posts.map((p) => {
          const inv = byPost.get(p.id);
          const kickoff = new Date(p.fixture.scheduled_start_utc);
          const defaultEnd = new Date(kickoff.getTime() + config.endAfterKickoffHours * 3_600_000);
          return (
            <div key={p.id} className="space-y-2 rounded-lg border border-border-subtle p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-text-primary">{p.fixture.away_team_name} @ {p.fixture.home_team_name}</p>
                <p className="text-xs text-text-muted">
                  {p.fixture.competition_name} · <LocalDateTime iso={p.fixture.scheduled_start_utc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                </p>
              </div>
              {inv?.holdingSponsorshipId && (
                <p className="text-xs text-text-secondary">
                  Held by {inv.holdingSponsorName} · {inv.holdingLifecycle} · review {inv.holdingReviewStatus} · {inv.holdingPaymentStatus ? PAYMENT_STATUS_LABEL[inv.holdingPaymentStatus] : ""}
                </p>
              )}
              <InventoryRow
                postId={p.id}
                initial={{
                  isSponsorable: inv?.isSponsorable ?? false,
                  price: inv ? (inv.priceCents / 100).toFixed(2) : "0.00",
                  currency: inv?.currency ?? config.defaultCurrency,
                  startsAt: toLocalInput(inv?.startsAt ?? now.toISOString()),
                  endsAt: toLocalInput(inv?.endsAt ?? defaultEnd.toISOString()),
                  marketCode: inv?.marketCode ?? GLOBAL_MARKET,
                }}
              />
            </div>
          );
        })}
        {posts.length === 0 && <p className="text-sm text-text-muted">No upcoming published Game Posts.</p>}
      </div>
    </div>
  );
}

/** ISO -> the value format a datetime-local input wants (UTC, so server and client agree; the field is labelled UTC). */
function toLocalInput(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16);
}
