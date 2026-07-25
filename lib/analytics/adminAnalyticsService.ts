import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveDateRange, previousPeriod, type DateRange } from "./date-ranges";
import { DEFAULT_ANALYTICS_TIMEZONE } from "./timezone";
import { ANALYTICS_CATEGORY_LABELS, type AnalyticsCategoryCode } from "@/lib/pools/templates/category-labels";
import { buildMetric } from "./metrics";
import type { AnalyticsFilters, AnalyticsResponse, MetricValue } from "./types";

// Platform-wide sibling of userAnalyticsService.ts — same date-attribution
// rules (activity entry-dated, financial realization-dated via
// settlements.created_at), same response shapes, but every RPC here
// aggregates across every user instead of one. Uses createAdminClient()
// (service role) because the get_platform_* functions are granted to
// service_role only — never authenticated — so only a page already gated
// by requireSuperAdmin() can reach this data. There's no auth.uid()
// scoping to rely on here, unlike the per-user functions.

const DAY_MS = 24 * 60 * 60 * 1000;

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

export interface PlatformOverviewData {
  netResult: MetricValue;
  entryVolume: MetricValue;
  poolsEntered: MetricValue;
  predictionAccuracy: MetricValue;
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

export async function getPlatformOverview(filters: AnalyticsFilters): Promise<AnalyticsResponse<PlatformOverviewData>> {
  const timeZone = DEFAULT_ANALYTICS_TIMEZONE;
  const range = toDateRange(filters, timeZone);
  const prevRange = previousPeriod(range, filters.preset, timeZone);
  const supabase = createAdminClient();

  const [activityNow, activityPrev, financialNow, financialPrev] = await Promise.all([
    supabase.rpc("get_platform_overview", {
      p_date_from: range.from.toISOString(),
      p_date_to: range.to.toISOString(),
    }),
    prevRange
      ? supabase.rpc("get_platform_overview", {
          p_date_from: prevRange.from.toISOString(),
          p_date_to: prevRange.to.toISOString(),
        })
      : Promise.resolve({ data: null as ActivityOverviewRow[] | null }),
    supabase.rpc("get_platform_financial_overview", {
      p_date_from: range.from.toISOString(),
      p_date_to: range.to.toISOString(),
    }),
    prevRange
      ? supabase.rpc("get_platform_financial_overview", {
          p_date_from: prevRange.from.toISOString(),
          p_date_to: prevRange.to.toISOString(),
        })
      : Promise.resolve({ data: null as FinancialOverviewRow[] | null }),
  ]);

  const activity = (activityNow.data as ActivityOverviewRow[] | null)?.[0] ?? null;
  const activityPrevious = (activityPrev.data as ActivityOverviewRow[] | null)?.[0] ?? null;
  const financial = (financialNow.data as FinancialOverviewRow[] | null)?.[0] ?? null;
  const financialPrevious = (financialPrev.data as FinancialOverviewRow[] | null)?.[0] ?? null;

  const currentAccuracy = activity && activity.graded_entries > 0 ? activity.wins / activity.graded_entries : null;
  const previousAccuracy =
    activityPrevious && activityPrevious.graded_entries > 0 ? activityPrevious.wins / activityPrevious.graded_entries : null;

  return {
    data: {
      netResult: buildMetric(financial?.net_result ?? 0, financialPrevious ? financialPrevious.net_result : null),
      entryVolume: buildMetric(activity?.entry_volume ?? 0, activityPrevious ? activityPrevious.entry_volume : null),
      poolsEntered: buildMetric(activity?.pools_entered ?? 0, activityPrevious ? activityPrevious.pools_entered : null),
      predictionAccuracy: buildMetric(currentAccuracy, previousAccuracy),
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

export async function getPlatformCategoryPerformance(
  filters: AnalyticsFilters,
): Promise<AnalyticsResponse<CategoryPerformanceRow[]>> {
  const timeZone = DEFAULT_ANALYTICS_TIMEZONE;
  const range = toDateRange(filters, timeZone);
  const supabase = createAdminClient();
  const { data } = await supabase.rpc("get_platform_category_performance", {
    p_date_from: range.from.toISOString(),
    p_date_to: range.to.toISOString(),
  });

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

export async function getPlatformMonthlyActivity(
  filters: AnalyticsFilters,
): Promise<AnalyticsResponse<MonthlyActivityPoint[]>> {
  const timeZone = DEFAULT_ANALYTICS_TIMEZONE;
  const range = toDateRange(filters, timeZone);
  const rangeDays = (range.to.getTime() - range.from.getTime()) / DAY_MS;
  const granularity = rangeDays <= 30 ? "day" : rangeDays <= 90 ? "week" : "month";

  const supabase = createAdminClient();
  const { data } = await supabase.rpc("get_platform_monthly_activity", {
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

export type TopUsersOrder = "net_result" | "entry_volume" | "accuracy";

export interface TopUserRow {
  userId: string;
  displayName: string;
  username: string | null;
  entries: number;
  entryVolume: number;
  netResult: number;
  wins: number;
  losses: number;
  accuracy: number | null;
}

interface TopUsersRpcRow {
  user_id: string;
  display_name: string;
  username: string | null;
  entries: number;
  entry_volume: number;
  net_result: number;
  wins: number;
  losses: number;
}

export async function getPlatformTopUsers(
  filters: AnalyticsFilters,
  order: TopUsersOrder,
  limit: number,
): Promise<AnalyticsResponse<TopUserRow[]>> {
  const timeZone = DEFAULT_ANALYTICS_TIMEZONE;
  const range = toDateRange(filters, timeZone);
  const supabase = createAdminClient();
  const { data } = await supabase.rpc("get_platform_top_users", {
    p_date_from: range.from.toISOString(),
    p_date_to: range.to.toISOString(),
    p_order: order,
    p_limit: limit,
  });

  const rows: TopUserRow[] = ((data as TopUsersRpcRow[] | null) ?? []).map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    username: row.username,
    entries: row.entries,
    entryVolume: row.entry_volume,
    netResult: row.net_result,
    wins: row.wins,
    losses: row.losses,
    accuracy: row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : null,
  }));

  return { data: rows, generatedAt: new Date().toISOString(), filters: responseFilters(range) };
}

export interface AdminAnalyticsPageData {
  overview: PlatformOverviewData;
  categoryPerformance: CategoryPerformanceRow[];
  monthlyActivity: MonthlyActivityPoint[];
  topUsers: TopUserRow[];
}

export async function getAdminAnalyticsPageData(filters: AnalyticsFilters): Promise<AdminAnalyticsPageData> {
  const [overview, category, monthly, topUsers] = await Promise.all([
    getPlatformOverview(filters),
    getPlatformCategoryPerformance(filters),
    getPlatformMonthlyActivity(filters),
    getPlatformTopUsers(filters, "net_result", 20),
  ]);

  return {
    overview: overview.data,
    categoryPerformance: category.data,
    monthlyActivity: monthly.data,
    topUsers: topUsers.data,
  };
}
