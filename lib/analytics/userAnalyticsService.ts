import "server-only";
import { createClient } from "@/lib/supabase/server";
import { resolveDateRange, previousPeriod, type DateRange } from "./date-ranges";
import { DEFAULT_ANALYTICS_TIMEZONE, normalizeIanaTimezone } from "./timezone";
import { ANALYTICS_CATEGORY_LABELS, type AnalyticsCategoryCode } from "@/lib/pools/templates/category-labels";
import { computeStreaks, toStreakSymbols, type GradedOutcome, type StreakSymbol } from "./streaks";
import { buildMetric } from "./metrics";
import type { AnalyticsFilters, AnalyticsResponse, MetricValue } from "./types";

// Every function below is self-scoped: the SQL RPCs read auth.uid()
// internally (never a parameter), so they can only ever return the
// signed-in caller's own data regardless of what this module is passed.
// `userId` is only ever used against RLS-protected plain-table reads
// (user_profiles), where Postgres enforces "own row only" independent of
// the literal value supplied.
//
// Date attribution is split three ways (see
// supabase/migrations/20260101000071_analytics_financial_rewrite.sql for
// the full reasoning):
// - Activity (get_user_analytics_overview): entry-dated. "What did I do."
// - Cohort (predictionAccuracy, category/competition breakdowns):
//   entry-dated too, but the *result* can still change until every entry
//   in the cohort settles — the UI must label these as cohort results.
// - Financial (get_user_financial_overview): realization-dated
//   (settlement.created_at). "What money actually moved." Never mixes
//   with entry-dated volume in the same ratio (that was the original bug
//   — this module keeps stake_basis and net_result on the same
//   realization-dated footing for realized ROI).

function toDateRange(filters: AnalyticsFilters, timeZone: string): DateRange {
  const custom =
    filters.preset === "CUSTOM" && filters.dateFrom && filters.dateTo
      ? { from: filters.dateFrom, to: filters.dateTo }
      : undefined;
  return resolveDateRange(filters.preset, timeZone, custom);
}

function responseFilters(range: DateRange) {
  return { dateFrom: range.from.toISOString(), dateTo: range.to.toISOString() };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UserOverviewData {
  /** Realized this period (settlement/refund date), never entry date. */
  netResult: MetricValue;
  /** Realized ROI = realized WON/LOST net result / realized WON/LOST stake, both settlement-dated. */
  returnOnEntries: MetricValue;
  /** Cohort accuracy — entries PLACED this period; may still change until every entry in the cohort settles. */
  predictionAccuracy: MetricValue;
  poolsEntered: MetricValue;
  currentStreak: number;
  bestStreak: number;
  bestCategory: { label: string; netResult: number } | null;
}

interface ActivityOverviewRow {
  pools_entered: number;
  entry_volume: number;
  wins: number;
  losses: number;
  voids: number;
  graded_entries: number;
}

interface FinancialOverviewRow {
  net_result: number;
  graded_net_result: number;
  stake_basis: number;
}

export async function getUserOverview(
  userId: string,
  filters: AnalyticsFilters,
  timeZone: string,
): Promise<AnalyticsResponse<UserOverviewData>> {
  const range = toDateRange(filters, timeZone);
  const prevRange = previousPeriod(range, filters.preset, timeZone);
  const supabase = await createClient();

  const [activityNow, activityPrev, financialNow, financialPrev, profileResult, categoryResponse] = await Promise.all([
    supabase.rpc("get_user_analytics_overview", {
      p_date_from: range.from.toISOString(),
      p_date_to: range.to.toISOString(),
    }),
    prevRange
      ? supabase.rpc("get_user_analytics_overview", {
          p_date_from: prevRange.from.toISOString(),
          p_date_to: prevRange.to.toISOString(),
        })
      : Promise.resolve({ data: null as ActivityOverviewRow[] | null }),
    supabase.rpc("get_user_financial_overview", {
      p_date_from: range.from.toISOString(),
      p_date_to: range.to.toISOString(),
    }),
    prevRange
      ? supabase.rpc("get_user_financial_overview", {
          p_date_from: prevRange.from.toISOString(),
          p_date_to: prevRange.to.toISOString(),
        })
      : Promise.resolve({ data: null as FinancialOverviewRow[] | null }),
    supabase.from("user_profiles").select("current_streak, best_streak").eq("id", userId).single(),
    getUserCategoryPerformance(filters, timeZone),
  ]);

  const activity = (activityNow.data as ActivityOverviewRow[] | null)?.[0] ?? null;
  const activityPrevious = (activityPrev.data as ActivityOverviewRow[] | null)?.[0] ?? null;
  const financial = (financialNow.data as FinancialOverviewRow[] | null)?.[0] ?? null;
  const financialPrevious = (financialPrev.data as FinancialOverviewRow[] | null)?.[0] ?? null;

  const currentROI = financial && financial.stake_basis > 0 ? financial.graded_net_result / financial.stake_basis : null;
  const previousROI =
    financialPrevious && financialPrevious.stake_basis > 0
      ? financialPrevious.graded_net_result / financialPrevious.stake_basis
      : null;

  const currentAccuracy = activity && activity.graded_entries > 0 ? activity.wins / activity.graded_entries : null;
  const previousAccuracy =
    activityPrevious && activityPrevious.graded_entries > 0 ? activityPrevious.wins / activityPrevious.graded_entries : null;

  const bestCategory = categoryResponse.data.reduce<{ label: string; netResult: number } | null>(
    (best, row) => (best === null || row.netResult > best.netResult ? { label: row.label, netResult: row.netResult } : best),
    null,
  );

  return {
    data: {
      netResult: buildMetric(financial?.net_result ?? 0, financialPrevious ? financialPrevious.net_result : null),
      returnOnEntries: buildMetric(currentROI, previousROI),
      predictionAccuracy: buildMetric(currentAccuracy, previousAccuracy),
      poolsEntered: buildMetric(activity?.pools_entered ?? 0, activityPrevious ? activityPrevious.pools_entered : null),
      currentStreak: profileResult.data?.current_streak ?? 0,
      bestStreak: profileResult.data?.best_streak ?? 0,
      bestCategory,
    },
    generatedAt: new Date().toISOString(),
    filters: responseFilters(range),
  };
}

export interface CategoryPerformanceRow {
  label: string;
  entries: number;
  entryVolume: number;
  netResult: number;
  wins: number;
  losses: number;
  returnOnEntries: number | null;
  accuracy: number | null;
}

interface CategoryPerformanceRpcRow {
  category: AnalyticsCategoryCode;
  entries: number;
  entry_volume: number;
  net_result: number;
  wins: number;
  losses: number;
}

export async function getUserCategoryPerformance(
  filters: AnalyticsFilters,
  timeZone: string,
): Promise<AnalyticsResponse<CategoryPerformanceRow[]>> {
  const range = toDateRange(filters, timeZone);
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_user_category_performance", {
    p_date_from: range.from.toISOString(),
    p_date_to: range.to.toISOString(),
  });

  // Grouping by pools.analytics_category (an immutable per-pool snapshot)
  // happens in SQL now — every row here is already one distinct category,
  // no TS-side re-aggregation needed.
  const rows: CategoryPerformanceRow[] = ((data as CategoryPerformanceRpcRow[] | null) ?? [])
    .map((row) => ({
      label: ANALYTICS_CATEGORY_LABELS[row.category],
      entries: row.entries,
      entryVolume: row.entry_volume,
      netResult: row.net_result,
      wins: row.wins,
      losses: row.losses,
      returnOnEntries: row.entry_volume > 0 ? row.net_result / row.entry_volume : null,
      accuracy: row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : null,
    }))
    .sort((a, b) => b.netResult - a.netResult);

  return { data: rows, generatedAt: new Date().toISOString(), filters: responseFilters(range) };
}

export interface CompetitionPerformanceRow {
  competitionKey: string;
  competitionName: string;
  entries: number;
  entryVolume: number;
  netResult: number;
  wins: number;
  losses: number;
  avgPayout: number | null;
  returnOnEntries: number | null;
  accuracy: number | null;
}

interface CompetitionPerformanceRpcRow {
  competition_key: string;
  competition_name: string;
  entries: number;
  entry_volume: number;
  net_result: number;
  wins: number;
  losses: number;
  avg_payout: number | null;
}

export async function getUserCompetitionPerformance(
  filters: AnalyticsFilters,
  timeZone: string,
): Promise<AnalyticsResponse<CompetitionPerformanceRow[]>> {
  const range = toDateRange(filters, timeZone);
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_user_competition_performance", {
    p_date_from: range.from.toISOString(),
    p_date_to: range.to.toISOString(),
  });

  const rows: CompetitionPerformanceRow[] = ((data as CompetitionPerformanceRpcRow[] | null) ?? [])
    .map((row) => ({
      competitionKey: row.competition_key,
      competitionName: row.competition_name,
      entries: row.entries,
      entryVolume: row.entry_volume,
      netResult: row.net_result,
      wins: row.wins,
      losses: row.losses,
      avgPayout: row.avg_payout,
      returnOnEntries: row.entry_volume > 0 ? row.net_result / row.entry_volume : null,
      accuracy: row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : null,
    }))
    .sort((a, b) => b.netResult - a.netResult);

  return { data: rows, generatedAt: new Date().toISOString(), filters: responseFilters(range) };
}

export interface MonthlyActivityPoint {
  bucket: string;
  poolsEntered: number;
  entryVolume: number;
  payouts: number;
  netResult: number;
}

interface MonthlyActivityRpcRow {
  bucket: string;
  pools_entered: number;
  entry_volume: number;
  payouts: number;
  net_result: number;
}

export async function getUserMonthlyActivity(
  filters: AnalyticsFilters,
  timeZone: string,
): Promise<AnalyticsResponse<MonthlyActivityPoint[]>> {
  const range = toDateRange(filters, timeZone);
  const rangeDays = (range.to.getTime() - range.from.getTime()) / DAY_MS;
  const granularity = rangeDays <= 30 ? "day" : rangeDays <= 90 ? "week" : "month";

  const supabase = await createClient();
  const { data } = await supabase.rpc("get_user_monthly_activity", {
    p_date_from: range.from.toISOString(),
    p_date_to: range.to.toISOString(),
    p_granularity: granularity,
    p_timezone: timeZone,
  });

  const rows: MonthlyActivityPoint[] = ((data as MonthlyActivityRpcRow[] | null) ?? []).map((row) => ({
    bucket: row.bucket,
    poolsEntered: row.pools_entered,
    entryVolume: row.entry_volume,
    payouts: row.payouts,
    netResult: row.net_result,
  }));

  return { data: rows, generatedAt: new Date().toISOString(), filters: responseFilters(range) };
}

export interface EntryHistoryItem {
  entryId: string;
  poolId: string;
  question: string;
  fixtureLabel: string | null;
  competitionName: string | null;
  optionLabel: string;
  amount: number;
  payout: number;
  netResult: number;
  finalOptionShare: number | null;
  status: "WON" | "LOST" | "VOID" | "REFUNDED";
  createdAt: string;
}

interface EntryHistoryRpcRow {
  entry_id: string;
  pool_id: string;
  question: string;
  fixture_label: string | null;
  competition_name: string | null;
  option_label: string;
  amount: number;
  payout: number;
  net_result: number;
  final_option_share: number | null;
  status: string;
  created_at: string;
}

function mapEntryHistoryRow(row: EntryHistoryRpcRow): EntryHistoryItem {
  return {
    entryId: row.entry_id,
    poolId: row.pool_id,
    question: row.question,
    fixtureLabel: row.fixture_label,
    competitionName: row.competition_name,
    optionLabel: row.option_label,
    amount: row.amount,
    payout: row.payout,
    netResult: row.net_result,
    finalOptionShare: row.final_option_share,
    status: row.status as EntryHistoryItem["status"],
    createdAt: row.created_at,
  };
}

export async function getUserEntryHighlights(
  filters: AnalyticsFilters,
  order: "best" | "worst",
  limit: number,
  timeZone: string,
): Promise<AnalyticsResponse<EntryHistoryItem[]>> {
  const range = toDateRange(filters, timeZone);
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_user_entry_history", {
    p_date_from: range.from.toISOString(),
    p_date_to: range.to.toISOString(),
    p_order: order,
    p_limit: limit,
  });

  const rows = ((data as EntryHistoryRpcRow[] | null) ?? []).map(mapEntryHistoryRow);
  return { data: rows, generatedAt: new Date().toISOString(), filters: responseFilters(range) };
}

export interface StreakTimelineData {
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
  symbols: StreakSymbol[];
}

// currentStreak/longestWinStreak come from user_profiles (the same
// authoritative counters the overview card reads) so the two never
// disagree on-screen. Only the W/L/V symbol strip and longestLossStreak —
// which has no all-time equivalent column — stay windowed to the last 20
// graded entries, ignoring the page's selected date range (per spec, the
// streak timeline is a lifetime view).
export async function getUserStreakTimeline(userId: string): Promise<AnalyticsResponse<StreakTimelineData>> {
  const supabase = await createClient();
  const [historyResult, profileResult] = await Promise.all([
    supabase.rpc("get_user_entry_history", {
      p_date_from: null,
      p_date_to: null,
      p_order: "recent",
      p_limit: 20,
    }),
    supabase.from("user_profiles").select("current_streak, best_streak").eq("id", userId).single(),
  ]);

  const outcomes: GradedOutcome[] = ((historyResult.data as EntryHistoryRpcRow[] | null) ?? []).map((row) => ({
    status: row.status as GradedOutcome["status"],
  }));
  const { longestLossStreak } = computeStreaks(outcomes);
  const symbols = toStreakSymbols(outcomes);

  return {
    data: {
      currentStreak: profileResult.data?.current_streak ?? 0,
      longestWinStreak: profileResult.data?.best_streak ?? 0,
      longestLossStreak,
      symbols,
    },
    generatedAt: new Date().toISOString(),
    filters: { dateFrom: "", dateTo: "" },
  };
}

export interface BankrollPoint {
  timestamp: string;
  value: number;
}

interface BankrollBalanceRpcRow {
  bucket_timestamp: string;
  value: number;
}

interface CumulativePnlRpcRow {
  bucket: string;
  bucket_net_result: number;
  cumulative_net_result: number;
}

// "balance" mode calls get_user_bankroll_balance, which seeds the series
// with the true balance at the start of the range (not just the balance
// after the first in-range transaction) — see that function's comment.
// "cumulative" mode calls get_user_cumulative_pnl, a bucketed running sum
// computed entirely in SQL, bucketed by realization date (settlement
// date), not entry date — this is a P&L chart, the same attribution rule
// as the overview's Net result card. The two modes are never combined on
// one line, per spec (deposits/withdrawals must never be mixed into
// betting P&L).
export async function getUserBankroll(
  userId: string,
  filters: AnalyticsFilters,
  mode: "balance" | "cumulative",
  timeZone: string,
): Promise<AnalyticsResponse<BankrollPoint[]>> {
  const range = toDateRange(filters, timeZone);
  const supabase = await createClient();

  if (mode === "balance") {
    const { data } = await supabase.rpc("get_user_bankroll_balance", {
      p_date_from: range.from.toISOString(),
      p_date_to: range.to.toISOString(),
    });

    const points = ((data as BankrollBalanceRpcRow[] | null) ?? []).map((row) => ({
      timestamp: row.bucket_timestamp,
      value: row.value,
    }));
    return { data: points, generatedAt: new Date().toISOString(), filters: responseFilters(range) };
  }

  const rangeDays = (range.to.getTime() - range.from.getTime()) / DAY_MS;
  const granularity = rangeDays <= 30 ? "day" : rangeDays <= 90 ? "week" : "month";

  const { data } = await supabase.rpc("get_user_cumulative_pnl", {
    p_date_from: range.from.toISOString(),
    p_date_to: range.to.toISOString(),
    p_granularity: granularity,
    p_timezone: timeZone,
  });

  const points = ((data as CumulativePnlRpcRow[] | null) ?? []).map((row) => ({
    timestamp: row.bucket,
    value: row.cumulative_net_result,
  }));

  return { data: points, generatedAt: new Date().toISOString(), filters: responseFilters(range) };
}

export interface UserAnalyticsPageData {
  timeZone: string;
  overview: UserOverviewData;
  bankrollBalance: BankrollPoint[];
  bankrollCumulative: BankrollPoint[];
  categoryPerformance: CategoryPerformanceRow[];
  competitionPerformance: CompetitionPerformanceRow[];
  monthlyActivity: MonthlyActivityPoint[];
  streakTimeline: StreakTimelineData;
  biggestWins: EntryHistoryItem[];
  biggestLosses: EntryHistoryItem[];
}

export async function getUserAnalyticsPageData(userId: string, filters: AnalyticsFilters): Promise<UserAnalyticsPageData> {
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("analytics_timezone")
    .eq("id", userId)
    .single();
  // Defensive read-time fallback only, never a silent write-time one: a
  // row can't be WRITTEN with an invalid zone (validated at the write
  // path in lib/analytics/timezone.ts), but this guards any row that
  // predates that validation.
  const timeZone = (profile?.analytics_timezone && normalizeIanaTimezone(profile.analytics_timezone)) || DEFAULT_ANALYTICS_TIMEZONE;

  const [overview, bankrollBalance, bankrollCumulative, category, competition, monthly, streaks, wins, losses] =
    await Promise.all([
      getUserOverview(userId, filters, timeZone),
      getUserBankroll(userId, filters, "balance", timeZone),
      getUserBankroll(userId, filters, "cumulative", timeZone),
      getUserCategoryPerformance(filters, timeZone),
      getUserCompetitionPerformance(filters, timeZone),
      getUserMonthlyActivity(filters, timeZone),
      getUserStreakTimeline(userId),
      getUserEntryHighlights(filters, "best", 10, timeZone),
      getUserEntryHighlights(filters, "worst", 10, timeZone),
    ]);

  return {
    timeZone,
    overview: overview.data,
    bankrollBalance: bankrollBalance.data,
    bankrollCumulative: bankrollCumulative.data,
    categoryPerformance: category.data,
    competitionPerformance: competition.data,
    monthlyActivity: monthly.data,
    streakTimeline: streaks.data,
    biggestWins: wins.data,
    biggestLosses: losses.data,
  };
}
