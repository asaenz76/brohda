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

  const [{ data: fixture }, { data: poolRows }, { data: wallet }, paymentMethods] = await Promise.all([
    supabase
      .from("fixtures")
      .select("home_team_name, away_team_name, competition_name, scheduled_start_utc")
      .eq("id", id)
      .single(),
    supabase.from("pools").select("id, created_at").eq("fixture_id", id),
    supabase.from("wallet_balances").select("balance").eq("user_id", user.id).single(),
    getPaymentMethods(),
  ]);
  const enabledPaymentMethods = paymentMethods.filter((m) => m.enabled);

  if (!fixture) notFound();

  const poolIds = (poolRows ?? [])
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((p) => p.id);

  const viewModelsUnordered = await getPoolCardViewModels(poolIds, user.id);
  const viewModels = poolIds
    .map((poolId) => viewModelsUnordered.find((vm) => vm.poolId === poolId))
    .filter((vm) => vm != null)
    .sort((a, b) => (STATUS_PRIORITY[a.status] ?? 4) - (STATUS_PRIORITY[b.status] ?? 4));

  const balanceCents = wallet?.balance ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-text-primary">
          {fixture.home_team_name} vs {fixture.away_team_name}
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
