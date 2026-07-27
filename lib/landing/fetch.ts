import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPoolCardViewModel, type SocialPoolCardViewModel } from "@/lib/pools/view-model";

export interface LandingStats {
  betaTesters: number;
  predictionsMade: number;
  poolsCompleted: number;
}

export interface LandingActivityPoint {
  timestamp: string;
  value: number;
}

export interface LandingActivityItem {
  id: string;
  text: string;
  createdAt: string;
}

export interface LandingLeaderboardEntry {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  correctCount: number;
  totalCount: number;
  rank: number;
}

export interface LandingSampleAnalytics {
  displayName: string;
  poolsEntered: number;
  currentStreak: number;
  predictionAccuracy: { correct: number; total: number };
  balancePoints: LandingActivityPoint[];
}

export interface LandingPageData {
  stats: LandingStats;
  heroPool: SocialPoolCardViewModel | null;
  feedPools: SocialPoolCardViewModel[];
  leaderboard: LandingLeaderboardEntry[];
  activity: LandingActivityItem[];
  sampleAnalytics: LandingSampleAnalytics | null;
}

// Only pools that are already unambiguously public within the app itself —
// open to every member and configured to show picks/percentages before
// anyone has to enter — are eligible for the pre-login marketing page.
// Anything HIDDEN, invite-scoped, or SHOW_AFTER_ENTRY/SHOW_AFTER_LOCK stays
// exactly as private to a logged-out visitor as it already is to a
// logged-in one who hasn't entered yet.
const PUBLIC_POOL_FILTERS = {
  status: "OPEN",
  visibility: "VISIBLE_TO_ALL_MEMBERS",
  participation_visibility: "SHOW_BEFORE_ENTRY",
} as const;

// No real visitor session exists pre-login, so there's no "current user" to
// scope entries/likes to — every card renders in its plain, unentered state
// (no "Your Choice" badge, no like state), which is exactly what a
// marketing preview should show anyway.
async function buildPublicViewModel(
  admin: ReturnType<typeof createAdminClient>,
  pool: Record<string, unknown>,
): Promise<SocialPoolCardViewModel | null> {
  const poolId = pool.id as string;

  const [{ data: fixture }, { data: options }, { data: totalsRows }, { data: participantsRows }] =
    await Promise.all([
      pool.fixture_id
        ? admin.from("fixtures").select("*").eq("id", pool.fixture_id as string).single()
        : Promise.resolve({ data: null }),
      // pool_options_public is only granted to `authenticated` (it exists
      // to null out aggregates for viewers who can't see distribution yet)
      // — service_role has no grant on it at all. The admin client reads
      // the base table directly instead, which is fine here: every pool
      // eligible for this page is already filtered to SHOW_BEFORE_ENTRY,
      // i.e. exactly the case where that view would never null anything
      // out anyway.
      admin.from("pool_options").select("*").eq("pool_id", poolId),
      admin.rpc("get_pool_totals", { p_pool_id: poolId }),
      admin.rpc("get_pool_participants", { p_pool_id: poolId }),
    ]);

  if (!options || options.length === 0) return null;

  const fixtureRow = fixture ?? {
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

  const totalsRaw = Array.isArray(totalsRows) ? totalsRows[0] : totalsRows;
  const participants = (participantsRows ?? []) as Array<{
    display_name: string;
    avatar_url: string | null;
  }>;

  return buildPoolCardViewModel({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pool: pool as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fixture: fixtureRow as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: options as any,
    currentUserEntry: null,
    totals: totalsRaw ?? { total_entries: 0, gross_pool: 0 },
    participants,
    participantCount: participants.length,
    finalPayout: null,
    isLikedByCurrentUser: false,
    comboLegs: [],
  });
}

export async function getLandingPageData(): Promise<LandingPageData> {
  const admin = createAdminClient();

  const [
    { count: betaTesters },
    { count: predictionsMade },
    { count: poolsCompleted },
    { data: candidatePools },
    { data: leaderboardRows },
  ] = await Promise.all([
    admin
      .from("user_profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "player")
      .eq("is_active", true),
    admin.from("entries").select("id", { count: "exact", head: true }),
    admin
      .from("pools")
      .select("id", { count: "exact", head: true })
      .eq("status", "SETTLED"),
    admin
      .from("pools")
      .select("*")
      .match(PUBLIC_POOL_FILTERS)
      // Same race the lock cron corrects for everywhere else (see
      // effectivePoolStatus): a pool past its locks_at can sit with
      // status still 'OPEN' until that job catches up. A marketing page
      // has even less excuse to show a stale one than Feed does.
      .gt("locks_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(20),
    // p_caller_id is only consulted for the "following" scope — ignored
    // entirely by the SQL function's WHERE clause when p_scope is
    // "global", so a fixed nil UUID (no real visitor exists pre-login) is
    // safe here.
    admin.rpc("get_leaderboard", {
      p_scope: "global",
      p_range: "all_time",
      p_caller_id: "00000000-0000-0000-0000-000000000000",
    }),
  ]);

  const pools = candidatePools ?? [];

  const totalsByPool = await Promise.all(
    pools.map(async (pool) => {
      const { data } = await admin.rpc("get_pool_totals", { p_pool_id: pool.id as string });
      const row = Array.isArray(data) ? data[0] : data;
      return { pool, totalEntries: row?.total_entries ?? 0 };
    }),
  );

  const ranked = totalsByPool
    .filter((p) => p.totalEntries > 0)
    .sort((a, b) => b.totalEntries - a.totalEntries);

  const heroCandidate = ranked[0]?.pool ?? pools[0] ?? null;
  const otherPools = ranked
    .slice(1, 3)
    .map((p) => p.pool)
    .concat(pools.filter((p) => p.id !== heroCandidate?.id))
    .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);
  // A single real open pool is still a real feed — better to show the
  // hero pool a second time here than to leave "Your feed" empty just
  // because there's nothing else open yet.
  const feedCandidates = (otherPools.length > 0 ? otherPools : heroCandidate ? [heroCandidate] : []).slice(
    0,
    2,
  );

  const [heroPool, feedPools] = await Promise.all([
    heroCandidate ? buildPublicViewModel(admin, heroCandidate) : Promise.resolve(null),
    Promise.all(feedCandidates.map((p) => buildPublicViewModel(admin, p))),
  ]);

  const leaderboard: LandingLeaderboardEntry[] = (leaderboardRows ?? [])
    .slice(0, 5)
    .map(
      (row: {
        user_id: string;
        display_name: string;
        username: string | null;
        avatar_url: string | null;
        correct_count: number;
        total_count: number;
        rank: number;
      }) => ({
        userId: row.user_id,
        displayName: row.display_name,
        username: row.username,
        avatarUrl: row.avatar_url,
        correctCount: row.correct_count,
        totalCount: row.total_count,
        rank: row.rank,
      }),
    );

  const activity = await getRecentActivity(admin);
  // Rank 1 (with SQL tiebreakers already applied by get_leaderboard) is
  // "whoever has the best record so far" — the real top-of-leaderboard
  // player, not an arbitrary pick.
  const topUser = leaderboard[0];
  const sampleAnalytics = topUser ? await getSampleUserAnalytics(admin, topUser) : null;

  return {
    stats: {
      betaTesters: betaTesters ?? 0,
      predictionsMade: predictionsMade ?? 0,
      poolsCompleted: poolsCompleted ?? 0,
    },
    heroPool,
    feedPools: feedPools.filter((vm): vm is SocialPoolCardViewModel => vm != null),
    leaderboard,
    activity,
    sampleAnalytics,
  };
}

// The real /analytics page's "Account balance" chart and MetricCard row,
// reconstructed for one real player instead of the visitor viewing their
// own — pre-login there's no session to scope to, so this uses the
// leaderboard's #1 player (real tiebreakers already applied by
// get_leaderboard) and reads the same source data those pages read.
// get_user_bankroll_balance/get_profile_stats are auth.uid()-scoped (no
// user-id parameter — see supabase/migrations/20260101000067), so they
// can't be called for an arbitrary user via the admin client; this
// mirrors get_user_bankroll_balance's own logic directly (opening balance
// = last balance_after before the range, then every wallet_transactions
// row's balance_after after that) rather than reinventing it.
async function getSampleUserAnalytics(
  admin: ReturnType<typeof createAdminClient>,
  topUser: LandingLeaderboardEntry,
): Promise<LandingSampleAnalytics> {
  const [{ count: poolsEntered }, { data: profile }, { data: balanceRows }] = await Promise.all([
    admin
      .from("entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", topUser.userId),
    admin.from("user_profiles").select("current_streak").eq("id", topUser.userId).single(),
    admin
      .from("wallet_transactions")
      .select("created_at, balance_after")
      .eq("user_id", topUser.userId)
      .eq("account_type", "user")
      .order("created_at", { ascending: true }),
  ]);

  const balancePoints: LandingActivityPoint[] = (balanceRows ?? []).map((row) => ({
    timestamp: row.created_at as string,
    value: row.balance_after as number,
  }));

  return {
    displayName: topUser.displayName,
    poolsEntered: poolsEntered ?? 0,
    currentStreak: profile?.current_streak ?? 0,
    predictionAccuracy: { correct: topUser.correctCount, total: topUser.totalCount },
    balancePoints,
  };
}

async function getRecentActivity(
  admin: ReturnType<typeof createAdminClient>,
): Promise<LandingActivityItem[]> {
  const { data: entries } = await admin
    .from("entries")
    .select("id, created_at, pool_id, option_id, user_id")
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: false })
    .limit(30);

  if (!entries || entries.length === 0) return [];

  const poolIds = [...new Set(entries.map((e) => e.pool_id as string))];
  const userIds = [...new Set(entries.map((e) => e.user_id as string))];
  const optionIds = [...new Set(entries.map((e) => e.option_id as string))];

  const [{ data: pools }, { data: users }, { data: options }] = await Promise.all([
    admin.from("pools").select("id, question, visibility, participation_visibility").in("id", poolIds),
    admin.from("user_profiles").select("id, display_name").in("id", userIds).eq("is_active", true),
    admin.from("pool_options").select("id, label").in("id", optionIds),
  ]);

  const poolById = new Map((pools ?? []).map((p) => [p.id, p]));
  const userById = new Map((users ?? []).map((u) => [u.id, u]));
  const optionById = new Map((options ?? []).map((o) => [o.id, o]));

  const items: LandingActivityItem[] = [];
  for (const entry of entries) {
    const pool = poolById.get(entry.pool_id as string);
    const user = userById.get(entry.user_id as string);
    const option = optionById.get(entry.option_id as string);
    if (!pool || !user || !option) continue;
    if (pool.visibility !== "VISIBLE_TO_ALL_MEMBERS" || pool.participation_visibility !== "SHOW_BEFORE_ENTRY") {
      continue;
    }

    items.push({
      id: entry.id as string,
      text: `${user.display_name} picked ${option.label}`,
      createdAt: entry.created_at as string,
    });
    if (items.length === 5) break;
  }

  return items;
}
