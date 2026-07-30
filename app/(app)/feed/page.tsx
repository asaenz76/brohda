import { Rss } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPoolCardViewModels } from "@/lib/pools/fetch";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { effectivePoolStatus } from "@/lib/pools/status-filter";
import { SocialPoolCard } from "@/components/pools/SocialPoolCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { StoriesRow, type StoryEntry } from "@/components/feed/StoriesRow";
import { FeedFilters } from "./feed-filters";

function unwrapEmbed<T>(raw: unknown): T | null {
  return (Array.isArray(raw) ? raw[0] : raw) as T | null;
}

// Several countries have leagues that share the exact same name (e.g.
// "Primera División" — Costa Rica, Peru, Chile, Uruguay all use it), so the
// league filter needs country baked into both the option's value (to
// actually disambiguate what gets filtered) and its label (so the admin can
// tell them apart in the dropdown). Mirrors the "{country} | {name}"
// convention already used by PoolLeagueHeader and the admin pool-creation
// fixture picker.
function leagueKey(name: string, country: string | null): string {
  return country ? `${country}|${name}` : name;
}
function leagueLabel(name: string, country: string | null): string {
  return country ? `${country} | ${name}` : name;
}

// A defensive cap, not real pagination — every open pool used to be
// fetched unbounded, feeding directly into getPoolCardViewModels's
// per-pool cost. Ordered by whichever field the active sort mode actually
// needs (see the query below) before this cap applies, so "locking soon"
// still surfaces the genuinely soonest-to-lock pools rather than just the
// newest ones re-sorted.
const FEED_PAGE_SIZE = 50;

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string; league?: string; sort?: string }>;
}) {
  const { sport: sportParam, league: leagueParam, sort: sortParam } = await searchParams;
  const sortByLockingSoon = sortParam === "locking_soon";

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

  const poolsSelect =
    "id, status, locks_at, created_at, fixtures(sport, competition_name, competition_country)";

  // Feed only ever shows open pools — fetched by DB status, then refined by
  // effectivePoolStatus() below to exclude pools past their locks_at that
  // the lock cron (runs once a minute, and not at all outside Vercel Cron)
  // hasn't caught up to yet.
  const poolsQuery = supabase
    .from("pools")
    .select(poolsSelect)
    .eq("visibility", "VISIBLE_TO_ALL_MEMBERS")
    .eq("status", "OPEN")
    .order(sortByLockingSoon ? "locks_at" : "created_at", { ascending: sortByLockingSoon })
    .limit(FEED_PAGE_SIZE);

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
      const fixture = unwrapEmbed<{
        sport: string;
        competition_name: string | null;
        competition_country: string | null;
      }>(pool.fixtures);
      return {
        id: pool.id as string,
        status: pool.status as string,
        locksAt: pool.locks_at as string,
        createdAt: pool.created_at as string,
        sport: fixture?.sport ?? null,
        league: fixture?.competition_name ?? null,
        leagueCountry: fixture?.competition_country ?? null,
      };
    })
    .filter((row) => effectivePoolStatus(row) === "OPEN");

  const sportOptions = [...new Set(rows.map((r) => r.sport).filter((s): s is string => s != null))].sort();
  const leagueOptions = [
    ...new Map(
      rows
        .filter((r): r is typeof r & { league: string } => r.league != null)
        .map((r) => {
          const key = leagueKey(r.league, r.leagueCountry);
          return [key, { key, label: leagueLabel(r.league, r.leagueCountry) }] as const;
        }),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label));

  const isFiltered = Boolean(sportParam || leagueParam);
  const filteredRows = rows
    .filter((r) => (sportParam ? r.sport === sportParam : true))
    .filter((r) => (leagueParam ? r.league != null && leagueKey(r.league, r.leagueCountry) === leagueParam : true))
    .sort((a, b) =>
      sortByLockingSoon
        ? new Date(a.locksAt).getTime() - new Date(b.locksAt).getTime()
        : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

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
      <FeedFilters sportOptions={sportOptions} leagueOptions={leagueOptions} activeSort={sortParam ?? "newest"} />
      {viewModels.length === 0 ? (
        <EmptyFeedState
          icon={Rss}
          title={isFiltered ? "No pools match these filters" : "No open pools available at this moment"}
          description={
            isFiltered
              ? "Try a different sport or league, or clear the filters above."
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
