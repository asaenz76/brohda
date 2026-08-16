import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/guards";
import { fetchInChunks } from "@/lib/pools/fetch";
import { Button } from "@/components/ui/button";
import { PoolsTable, type PoolRow } from "./pools-table";

function unwrapEmbed<T>(raw: unknown): T | null {
  return (Array.isArray(raw) ? raw[0] : raw) as T | null;
}

export default async function AdminPoolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const viewer = await requireAdminOrAbove();
  const supabase = await createClient();
  const params = await searchParams;
  // Events (Phase 4) links a fixture's pool-count badge here rather than
  // building its own pools list (spec §25: "avoid duplicating the full
  // Pools management UI inside Events") — this is the one query-param
  // hook that makes that link do something useful.
  const fixtureId = params.fixtureId;

  let poolsQuery = supabase
    .from("pools")
    .select(
      "id, question, status, locks_at, entry_fee, house_fee_bps, first_entry_at, archived_at, fixtures(home_team_name, away_team_name, competition_name, scheduled_start_utc)",
    )
    .order("created_at", { ascending: false });
  if (fixtureId) poolsQuery = poolsQuery.eq("fixture_id", fixtureId);
  const { data: pools } = await poolsQuery;

  const poolIds = (pools ?? []).map((p) => p.id);

  // .in(column, poolIds) hits PostgREST's URL-length ceiling once the
  // platform has enough historical pools (~580+, same failure lib/pools/
  // fetch.ts's getPoolCardViewModels hit for Feed) — chunked the same way
  // to avoid this admin list silently going blank for large pool counts.
  const [options, entries, settlements] = await Promise.all([
    fetchInChunks(poolIds, (chunk) =>
      supabase
        .from("pool_options_public")
        .select("id, pool_id, label, team_name, entry_count, sort_order")
        .in("pool_id", chunk)
        .order("sort_order"),
    ),
    fetchInChunks(poolIds, (chunk) =>
      supabase
        .from("entries")
        .select("id, pool_id, user_id, option_id, amount, status")
        .in("pool_id", chunk)
        .order("created_at", { ascending: false }),
    ),
    fetchInChunks(poolIds, (chunk) =>
      supabase
        .from("settlements")
        .select(
          "id, pool_id, grading_version, outcome, winning_option_id, confirmed_at, reversed_at, reversal_reason",
        )
        .in("pool_id", chunk)
        .order("grading_version", { ascending: false }),
    ),
  ]);

  const userIds = [...new Set(entries.map((e) => e.user_id))];
  const users = await fetchInChunks(userIds, (chunk) =>
    supabase.from("user_profiles").select("id, display_name").in("id", chunk),
  );

  const userName = (userId: string) =>
    users.find((u) => u.id === userId)?.display_name ?? "Unknown";

  const optionLabelById = new Map(options.map((o) => [o.id, o.label]));

  const rows: PoolRow[] = (pools ?? []).map((pool) => {
    const fixture = unwrapEmbed<{
      home_team_name: string;
      away_team_name: string;
      competition_name: string | null;
      scheduled_start_utc: string;
    }>(pool.fixtures);

    const poolOptions = options.filter((o) => o.pool_id === pool.id);
    const totalVotes = poolOptions.reduce((sum, o) => sum + (o.entry_count ?? 0), 0);

    const poolEntries = entries.filter((e) => e.pool_id === pool.id);
    const poolSettlements = settlements.filter((s) => s.pool_id === pool.id);

    return {
      id: pool.id,
      question: pool.question,
      status: pool.status,
      archivedAt: pool.archived_at,
      locks_at: pool.locks_at,
      entryFeeCents: pool.entry_fee,
      houseFeeBps: pool.house_fee_bps,
      homeTeamName: fixture?.home_team_name ?? null,
      awayTeamName: fixture?.away_team_name ?? null,
      competitionName: fixture?.competition_name ?? null,
      kickoffAt: fixture?.scheduled_start_utc ?? null,
      options: poolOptions.map((o) => ({
        id: o.id,
        label: o.label,
        voteCount: o.entry_count,
        votePercentage:
          o.entry_count != null && totalVotes > 0 ? Math.round((o.entry_count / totalVotes) * 100) : null,
      })),
      entries: poolEntries.map((e) => ({
        id: e.id,
        userName: userName(e.user_id),
        optionLabel: optionLabelById.get(e.option_id) ?? "—",
        amountCents: e.amount,
        status: e.status,
      })),
      settlements: poolSettlements.map((s) => ({
        gradingVersion: s.grading_version,
        outcome: s.outcome,
        winnerLabel: s.winning_option_id ? (optionLabelById.get(s.winning_option_id) ?? "—") : null,
        confirmedAt: s.confirmed_at,
        reversedAt: s.reversed_at,
        reversalReason: s.reversal_reason,
      })),
    };
  });

  const filteredFixtureLabel = fixtureId && rows[0] ? `${rows[0].homeTeamName ?? "?"} vs ${rows[0].awayTeamName ?? "?"}` : null;

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Pools</h1>
      {fixtureId && (
        <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-secondary px-3 py-2 text-sm">
          <span className="text-text-secondary">
            Filtered to event{filteredFixtureLabel ? `: ${filteredFixtureLabel}` : ""}
          </span>
          <Link href="/admin/pools" className="text-xs font-medium text-accent-primary hover:underline">
            Clear
          </Link>
        </div>
      )}
      {isSuperAdmin(viewer) && (
        <div className="flex justify-end">
          <Link href="/admin/pools/new">
            <Button>Create pool</Button>
          </Link>
        </div>
      )}
      <PoolsTable pools={rows} isSuperAdmin={isSuperAdmin(viewer)} />
    </div>
  );
}
