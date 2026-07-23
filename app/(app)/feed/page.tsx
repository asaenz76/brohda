import { Rss } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPoolCardViewModels } from "@/lib/pools/fetch";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { FEED_STATUS_OPTIONS, effectivePoolStatus, isFeedStatus } from "@/lib/pools/status-filter";
import { SocialPoolCard } from "@/components/pools/SocialPoolCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { StoriesRow, type StoryEntry } from "@/components/feed/StoriesRow";
import { FeedFilters } from "./feed-filters";

function unwrapEmbed<T>(raw: unknown): T | null {
  return (Array.isArray(raw) ? raw[0] : raw) as T | null;
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string; league?: string; status?: string }>;
}) {
  const { sport: sportParam, league: leagueParam, status: statusParamRaw } = await searchParams;
  const statusParam =
    statusParamRaw === "ALL" || (statusParamRaw != null && isFeedStatus(statusParamRaw))
      ? statusParamRaw
      : "OPEN";

  const user = await requireUser();
  const supabase = await createClient();

  // Stories row: compute "new since last visit" using the OLD threshold,
  // then bump it to now() so the same activity doesn't show as new again
  // on the next visit. Null means "never visited" — treated as "show
  // everything currently active", not "show nothing".
  const { data: viewerProfile } = await supabase
    .from("user_profiles")
    .select("stories_last_seen_at")
    .eq("id", user.id)
    .single();
  const storiesSince = viewerProfile?.stories_last_seen_at ?? new Date(0).toISOString();
  const { data: storyRows } = await supabase.rpc("get_stories_row", {
    p_viewer_id: user.id,
    p_since: storiesSince,
  });
  const storyEntries: StoryEntry[] = (storyRows ?? []).map(
    (row: { user_id: string; display_name: string; username: string | null; avatar_url: string | null }) => ({
      userId: row.user_id,
      displayName: row.display_name,
      username: row.username,
      avatarUrl: row.avatar_url,
    }),
  );
  await createAdminClient()
    .from("user_profiles")
    .update({ stories_last_seen_at: new Date().toISOString() })
    .eq("id", user.id);

  const poolsSelect = "id, status, locks_at, created_at, fixtures(sport, competition_name)";

  // The lock cron only runs once a minute (and not at all outside Vercel
  // Cron) — a pool past its locks_at can sit with pools.status still
  // 'OPEN' in the DB until that job catches up (same race
  // lib/pools/card-state.ts's deriveCardState already corrects for on the
  // card itself). Filtering by the raw DB status alone would let such a
  // pool show under "Open" even though it's no longer available to bet
  // on — so OPEN/LOCKED both need the broader DB fetch below, refined by
  // effectiveStatus() afterward. "ALL" means every status in
  // FEED_STATUS_OPTIONS, not literally every pool_status (DRAFT/SCHEDULED/
  // etc. are admin-internal and never shown here regardless of filter).
  const dbStatusFilter =
    statusParam === "ALL"
      ? FEED_STATUS_OPTIONS
      : statusParam === "LOCKED"
        ? (["OPEN", "LOCKED"] as const)
        : ([statusParam] as const);

  const poolsQuery = supabase
    .from("pools")
    .select(poolsSelect)
    .eq("visibility", "VISIBLE_TO_ALL_MEMBERS")
    .in("status", dbStatusFilter);

  const [{ data: pools }, { data: myEntries }, { data: wallet }, paymentMethods] = await Promise.all([
    poolsQuery,
    supabase.from("entries").select("pool_id").eq("user_id", user.id).eq("status", "ACTIVE"),
    supabase.from("wallet_balances").select("balance").eq("user_id", user.id).single(),
    getPaymentMethods(),
  ]);
  const enabledPaymentMethods = paymentMethods.filter((m) => m.enabled);

  const enteredPoolIds = new Set((myEntries ?? []).map((e) => e.pool_id));

  const rows = (pools ?? [])
    .filter((pool) => !enteredPoolIds.has(pool.id))
    .map((pool) => {
      const fixture = unwrapEmbed<{ sport: string; competition_name: string | null }>(pool.fixtures);
      return {
        id: pool.id as string,
        status: pool.status as string,
        locksAt: pool.locks_at as string,
        createdAt: pool.created_at as string,
        sport: fixture?.sport ?? null,
        league: fixture?.competition_name ?? null,
      };
    })
    .filter((row) => statusParam === "ALL" || effectivePoolStatus(row) === statusParam);

  const sportOptions = [...new Set(rows.map((r) => r.sport).filter((s): s is string => s != null))].sort();
  const leagueOptions = [
    ...new Set(rows.map((r) => r.league).filter((l): l is string => l != null)),
  ].sort();

  const isFiltered = Boolean(sportParam || leagueParam) || statusParam !== "OPEN";
  const filteredRows = rows
    .filter((r) => (sportParam ? r.sport === sportParam : true))
    .filter((r) => (leagueParam ? r.league === leagueParam : true))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const poolIds = filteredRows.map((r) => r.id);
  const viewModelsUnordered = await getPoolCardViewModels(poolIds, user.id);
  // getPoolCardViewModels doesn't guarantee input order — resort to match
  // the newest-created-first order computed above.
  const viewModels = poolIds
    .map((id) => viewModelsUnordered.find((vm) => vm.poolId === id))
    .filter((vm) => vm != null);

  const balanceCents = wallet?.balance ?? 0;

  return (
    <div className="space-y-[18px] sm:space-y-[22px]">
      <h1 className="sr-only">Feed</h1>
      <StoriesRow entries={storyEntries} />
      <FeedFilters sportOptions={sportOptions} leagueOptions={leagueOptions} />
      {viewModels.length === 0 ? (
        <EmptyFeedState
          icon={Rss}
          title={isFiltered ? "No pools match these filters" : "No open pools available at this moment"}
          description={
            isFiltered
              ? "Try a different status, sport, or league, or clear the filters above."
              : "Check back soon — new pools show up here as soon as they're published."
          }
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
