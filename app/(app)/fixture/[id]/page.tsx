import { notFound } from "next/navigation";
import { Rss } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { getPoolCardViewModels } from "@/lib/pools/fetch";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { SocialPoolCard } from "@/components/pools/SocialPoolCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { LocalDateTime } from "@/components/LocalDateTime";
import { getMatchupSeparator, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";
import type { CardState } from "@/lib/pools/card-state";

// Pools still worth acting on float to the top; settled/voided history
// trails behind — mirrors the grouping players already expect from My Picks.
const STATUS_PRIORITY: Partial<Record<CardState, number>> = {
  OPEN_PRE_VOTE: 0,
  OPEN_POST_VOTE: 0,
  LIVE: 1,
  LOCKED: 2,
  READY_FOR_REVIEW: 3,
};

// Reached from search results for a fixture (Decision: fixture search links
// here rather than to a single pool, since one fixture can back several
// pools — e.g. different questions on the same match).
export default async function FixturePoolsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();

  const [{ data: fixture }, { data: poolRows }, { data: myEntries }, { data: wallet }, paymentMethods] =
    await Promise.all([
      supabase
        .from("fixtures")
        .select("sport, home_team_name, away_team_name, competition_name, scheduled_start_utc")
        .eq("id", id)
        .single(),
      supabase.from("pools").select("id, created_at, tier_group_id").eq("fixture_id", id),
      // Same tier-group awareness as the feed (app/(app)/feed/page.tsx): a
      // pool the viewer already entered a *different* tier of would
      // otherwise render as a normal, live "join" card here — the RPC
      // correctly rejects it (already_entered_tier_group), but nothing
      // would warn the UI beforehand. Unlike the feed, the pool the viewer
      // actually entered still shows (so they can see their own entry) —
      // only *unentered sibling* tiers get filtered out below.
      supabase.from("entries").select("pool_id, tier_group_id").eq("user_id", user.id).eq("status", "ACTIVE"),
      supabase.from("wallet_balances").select("balance").eq("user_id", user.id).single(),
      getPaymentMethods(),
    ]);
  const enabledPaymentMethods = paymentMethods.filter((m) => m.enabled);

  if (!fixture) notFound();

  const enteredPoolIds = new Set((myEntries ?? []).map((e) => e.pool_id));
  const enteredTierGroupIds = new Set(
    (myEntries ?? []).map((e) => e.tier_group_id).filter((tgId): tgId is string => tgId != null),
  );

  const poolIds = (poolRows ?? [])
    .filter(
      (p) => enteredPoolIds.has(p.id) || !(p.tier_group_id && enteredTierGroupIds.has(p.tier_group_id)),
    )
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((p) => p.id);

  const viewModelsUnordered = await getPoolCardViewModels(poolIds, user.id);
  const viewModels = poolIds
    .map((poolId) => viewModelsUnordered.find((vm) => vm.poolId === poolId))
    .filter((vm) => vm != null)
    .sort((a, b) => (STATUS_PRIORITY[a.status] ?? 4) - (STATUS_PRIORITY[b.status] ?? 4));

  const balanceCents = wallet?.balance ?? 0;
  const [firstTeam, secondTeam] = orderTeamsForDisplay(fixture.sport, fixture.home_team_name, fixture.away_team_name);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-text-primary">
          {firstTeam} {getMatchupSeparator(fixture.sport)} {secondTeam}
        </h1>
        <p className="text-xs text-text-muted">
          {fixture.competition_name ? `${fixture.competition_name} · ` : ""}
          <LocalDateTime
            iso={fixture.scheduled_start_utc}
            options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
          />
        </p>
      </div>

      {viewModels.length === 0 ? (
        <EmptyFeedState
          icon={Rss}
          title="No pools yet"
          description="No one has created a pool for this fixture yet."
        />
      ) : (
        viewModels.map((vm) => (
          <SocialPoolCard
            key={vm.poolId}
            viewModel={vm}
            balanceCents={balanceCents}
            paymentMethods={enabledPaymentMethods}
            viewer={{ id: user.id, isModerator: isAdminOrAbove(user) }}
          />
        ))
      )}
    </div>
  );
}
