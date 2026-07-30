import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPoolCardViewModel, computeOptionStats, type FollowState, type SocialPoolCardViewModel } from "./view-model";
import type { EntryStatusForCard } from "./card-state";

// PostgREST encodes an .in(column, ids) filter directly into the request
// URL — past a few hundred UUIDs (~580 in practice) that URL exceeds the
// proxy's length limit and the request fails with a bare "URI too long"
// error. Every .in() call below is keyed on an unbounded id list (every
// visible pool, once a viewer's feed/profile has enough history), and none
// of them checked their query's error before this — so that failure was
// silently swallowed (data just came back undefined) and every pool
// referencing anything looked up this way got dropped instead of erroring
// loudly. Splitting large id lists into safe-sized batches sidesteps the
// URL-length ceiling entirely, at the cost of one extra round trip per
// ~150 ids.
const IN_CLAUSE_CHUNK_SIZE = 150;

export async function fetchInChunks<Row>(
  ids: string[],
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: Row[] | null }>,
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + IN_CLAUSE_CHUNK_SIZE));
  }
  const results = await Promise.all(chunks.map(fetchChunk));
  return results.flatMap((r) => r.data ?? []);
}

/**
 * Fetches everything needed to render a set of pools as
 * SocialPoolCardViewModels — shared by Feed, /pool/[id], and My Picks so
 * the multi-query orchestration (pool, options, fixture, creator, the
 * viewer's entry, social proof) lives in exactly one place.
 *
 * `userId` is whose entry/pick this card represents (the Profile page's
 * Predictions tab reuses this for another user's settled picks, per Phase
 * 4 — the whole point is showing what *they* chose). `viewerId` is who's
 * actually looking at the screen right now, and defaults to `userId` since
 * every caller except that one public-profile case has viewer === owner.
 * Only the interactive social bits (currently: likes) key off `viewerId` —
 * currentUserEntry intentionally still keys off `userId`.
 */
export async function getPoolCardViewModels(
  poolIds: string[],
  userId: string,
  viewerId: string = userId,
): Promise<SocialPoolCardViewModel[]> {
  if (poolIds.length === 0) return [];

  const supabase = await createClient();

  // entries' RLS only allows reading your own rows. That's fine for every
  // caller except the one documented above (userId !== viewerId, a visited
  // profile showing someone else's settled picks) — there, the
  // request-scoped client would silently come back empty for their entry,
  // so "Your Choice" would never render even on a WON/LOST pick. Read
  // through the admin client only in that case; every other caller keeps
  // reading its own entry the normal RLS-scoped way.
  const entriesClient = userId === viewerId ? supabase : createAdminClient();

  const [pools, options, entries, likes, comboLegs] = await Promise.all([
    fetchInChunks(poolIds, (chunk) => supabase.from("pools").select("*").in("id", chunk)),
    fetchInChunks(poolIds, (chunk) => supabase.from("pool_options_public").select("*").in("pool_id", chunk)),
    fetchInChunks(poolIds, (chunk) =>
      entriesClient.from("entries").select("*").eq("user_id", userId).in("pool_id", chunk),
    ),
    fetchInChunks(poolIds, (chunk) =>
      supabase.from("pool_likes").select("pool_id").eq("user_id", viewerId).in("pool_id", chunk),
    ),
    // Only COMBO pools have rows here — harmless no-op for every other
    // pool_type, so this doesn't need to be scoped to COMBO poolIds first.
    fetchInChunks(poolIds, (chunk) =>
      supabase.from("pool_combo_legs").select("id, pool_id, label").in("pool_id", chunk).order("sort_order"),
    ),
  ]);

  const likedPoolIds = new Set(likes.map((l) => l.pool_id));

  if (pools.length === 0) return [];

  const wonEntryIds = entries.filter((e) => e.status === "WON").map((e) => e.id);
  // Same owner-or-admin RLS gap as entries above — a visited profile's WON
  // pick needs its payout amount too, not just the entry row.
  const payouts = await fetchInChunks(wonEntryIds, (chunk) =>
    entriesClient.from("settlement_payouts").select("entry_id, amount").in("entry_id", chunk),
  );
  const payoutByEntryId = new Map(payouts.map((p) => [p.entry_id, p.amount]));

  const fixtureIds = [...new Set(pools.map((p) => p.fixture_id).filter((id) => id != null))];
  const creatorIds = [...new Set(pools.map((p) => p.created_by))];

  // public_profiles filters to is_active — a pool created by an account
  // that's since been deactivated (common for the many test/seed accounts
  // in this app) would otherwise silently vanish for every viewer once its
  // creator lookup came back empty (`if (!fixture || !creator) continue`
  // below). A deactivated creator's past pools should stay visible, so this
  // reads user_profiles directly (any status) via the admin client — a
  // regular authenticated client can only read its own row there.
  const [fixtures, creators] = await Promise.all([
    fetchInChunks(fixtureIds, (chunk) => supabase.from("fixtures").select("*").in("id", chunk)),
    fetchInChunks(creatorIds, (chunk) =>
      createAdminClient().from("user_profiles").select("id, display_name, avatar_url").in("id", chunk),
    ),
  ]);

  // Resolves each fixture's home/away team + league external_id to a
  // teams/leagues row id, then to the viewer's own follow state for it —
  // keyed on `${provider}:${external_id}` since a bare external_id isn't
  // guaranteed unique across providers (this app only has one today, but
  // the key stays correct either way rather than assuming that holds).
  const teamExternalIds = [
    ...new Set(
      fixtures
        .flatMap((f) => [f.home_team_external_id, f.away_team_external_id])
        .filter((id): id is string => id != null),
    ),
  ];
  const leagueExternalIds = [
    ...new Set(fixtures.map((f) => f.competition_external_id).filter((id): id is string => id != null)),
  ];

  const [teamRows, leagueRows] = await Promise.all([
    fetchInChunks(teamExternalIds, (chunk) =>
      supabase.from("teams").select("id, provider, external_id").in("external_id", chunk),
    ),
    fetchInChunks(leagueExternalIds, (chunk) =>
      supabase.from("leagues").select("id, provider, external_id").in("external_id", chunk),
    ),
  ]);

  const teamIdByExternal = new Map(teamRows.map((t) => [`${t.provider}:${t.external_id}`, t.id as string]));
  const leagueIdByExternal = new Map(leagueRows.map((l) => [`${l.provider}:${l.external_id}`, l.id as string]));

  const teamIds = teamRows.map((t) => t.id as string);
  const leagueIds = leagueRows.map((l) => l.id as string);

  const [teamFollowRows, leagueFollowRows] = await Promise.all([
    fetchInChunks(teamIds, (chunk) =>
      supabase.from("team_follows").select("team_id, email_enabled").eq("user_id", viewerId).in("team_id", chunk),
    ),
    fetchInChunks(leagueIds, (chunk) =>
      supabase
        .from("league_follows")
        .select("league_id, email_enabled")
        .eq("user_id", viewerId)
        .in("league_id", chunk),
    ),
  ]);

  const teamFollowEmailByTeamId = new Map(teamFollowRows.map((f) => [f.team_id as string, f.email_enabled as boolean]));
  const leagueFollowEmailByLeagueId = new Map(
    leagueFollowRows.map((f) => [f.league_id as string, f.email_enabled as boolean]),
  );

  function resolveFollowState(
    provider: string | undefined,
    externalId: string | null | undefined,
    idByExternal: Map<string, string>,
    emailByEntityId: Map<string, boolean>,
  ): FollowState | null {
    if (!provider || !externalId) return null;
    const id = idByExternal.get(`${provider}:${externalId}`);
    if (!id) return null;
    return { id, following: emailByEntityId.has(id), emailEnabled: emailByEntityId.get(id) ?? false };
  }

  const perPoolExtras = await Promise.all(
    pools.map(async (pool) => {
      const [{ data: totalsRows }, { data: participantsRows }] = await Promise.all([
        supabase.rpc("get_pool_totals", { p_pool_id: pool.id }),
        supabase.rpc("get_pool_participants", { p_pool_id: pool.id }),
      ]);

      const totalsRaw = Array.isArray(totalsRows) ? totalsRows[0] : totalsRows;

      return {
        poolId: pool.id as string,
        totals: totalsRaw ?? { total_entries: 0, gross_pool: 0 },
        participants: (participantsRows ?? []) as Array<{
          display_name: string;
          avatar_url: string | null;
        }>,
      };
    }),
  );

  const viewModels: SocialPoolCardViewModel[] = [];

  for (const pool of pools) {
    // CUSTOM pools have no fixture_id at all — synthesize a neutral
    // stand-in so downstream code (deriveCardState, buildNoticeCopy, the
    // view model's `fixture` sub-object) keeps working without every one
    // of them needing to handle a null fixture. internal_status
    // 'NOT_STARTED' never matches a LIVE or anomaly status, so it's inert
    // everywhere it's read. scheduled_start_utc borrows the pool's own
    // locks_at since a couple of call sites require a valid ISO string.
    const fixture = pool.fixture_id
      ? fixtures.find((f) => f.id === pool.fixture_id)
      : {
          competition_name: null,
          competition_country: null,
          competition_logo_url: null,
          round: null,
          scheduled_start_utc: pool.locks_at,
          home_team_name: "",
          home_team_logo_url: null,
          away_team_name: "",
          away_team_logo_url: null,
          internal_status: "NOT_STARTED",
          elapsed_minutes: null,
          home_score: null,
          away_score: null,
        };
    // Not read by buildPoolCardViewModel anymore (the card shows the league,
    // not the creator — see PoolLeagueHeader), but this lookup stays: it's
    // what catches a pool whose creator account no longer resolves and
    // skips it, same as the fixture-missing check right next to it.
    const creator = creators.find((c) => c.id === pool.created_by);
    if (!fixture || !creator) continue;

    const poolOptions = options.filter((o) => o.pool_id === pool.id);
    const entry = entries.find((e) => e.pool_id === pool.id);
    const extras = perPoolExtras.find((e) => e.poolId === pool.id);

    viewModels.push(
      buildPoolCardViewModel({
        pool,
        fixture: {
          ...fixture,
          home_team_follow: resolveFollowState(
            fixture.provider,
            fixture.home_team_external_id,
            teamIdByExternal,
            teamFollowEmailByTeamId,
          ),
          away_team_follow: resolveFollowState(
            fixture.provider,
            fixture.away_team_external_id,
            teamIdByExternal,
            teamFollowEmailByTeamId,
          ),
          league_follow: resolveFollowState(
            fixture.provider,
            fixture.competition_external_id,
            leagueIdByExternal,
            leagueFollowEmailByLeagueId,
          ),
        },
        options: poolOptions,
        currentUserEntry: entry
          ? { option_id: entry.option_id, amount: entry.amount, status: entry.status as EntryStatusForCard }
          : null,
        totals: extras?.totals ?? { total_entries: 0, gross_pool: 0 },
        participants: extras?.participants ?? [],
        participantCount: extras?.participants.length ?? 0,
        finalPayout: entry ? (payoutByEntryId.get(entry.id) ?? null) : null,
        isLikedByCurrentUser: likedPoolIds.has(pool.id),
        comboLegs: comboLegs.filter((leg) => leg.pool_id === pool.id),
      }),
    );
  }

  return viewModels;
}

export interface PoolLiveStats {
  totalEntries: number;
  grossPool: number;
  options: Record<string, { percentage: number | null; estimatedPayout: number | null }>;
}

/**
 * Live-refetch counterpart to `getPoolCardViewModels`, scoped to one pool —
 * called by `SocialPoolCard` right after a realtime broadcast tells it
 * someone entered. Reads through the exact same RLS-gated path
 * (`pool_options_public` + `get_pool_totals`, both keyed on the request's
 * own `auth.uid()` via `createClient()`), so a viewer who isn't allowed to
 * see distribution yet still gets nulls back here, identically to the
 * initial server render — no separate gating logic to keep in sync.
 */
export async function getPoolLiveStats(poolId: string): Promise<PoolLiveStats | null> {
  const supabase = await createClient();

  const [{ data: pool }, { data: options }, { data: totalsRows }] = await Promise.all([
    supabase.from("pools").select("house_fee_bps").eq("id", poolId).single(),
    supabase.from("pool_options_public").select("id, entry_count").eq("pool_id", poolId),
    supabase.rpc("get_pool_totals", { p_pool_id: poolId }),
  ]);

  if (!pool || !options) return null;

  const totalsRaw = Array.isArray(totalsRows) ? totalsRows[0] : totalsRows;
  const totals = totalsRaw ?? { total_entries: 0, gross_pool: 0 };

  const houseFeeMultiplier = (10000 - pool.house_fee_bps) / 10000;
  const estimatedNetPrizePool = Math.floor(totals.gross_pool * houseFeeMultiplier);

  const optionStats = computeOptionStats(options, totals.total_entries, estimatedNetPrizePool);

  return {
    totalEntries: totals.total_entries,
    grossPool: totals.gross_pool,
    options: Object.fromEntries(
      optionStats.map((s) => [s.optionId, { percentage: s.percentage, estimatedPayout: s.estimatedPayout }]),
    ),
  };
}
