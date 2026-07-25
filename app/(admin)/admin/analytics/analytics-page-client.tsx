"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnalyticsFilterBar } from "@/components/analytics/AnalyticsFilterBar";
import { AnalyticsPageHeader } from "@/components/analytics/AnalyticsPageHeader";
import { MetricCard } from "@/components/analytics/MetricCard";
import { LineChartCard } from "@/components/analytics/LineChartCard";
import { HorizontalBarChartCard, type HorizontalBarDatum } from "@/components/analytics/HorizontalBarChartCard";
import { formatPercent, formatSignedCents } from "@/lib/analytics/format";
import { formatCents } from "@/lib/utils/money";
import type { DateRangePreset, MetricValue } from "@/lib/analytics/types";
import type { AdminAnalyticsPageData, TopUserRow } from "@/lib/analytics/adminAnalyticsService";

const COMPARISON_LABELS: Record<DateRangePreset, string> = {
  "7D": "vs previous 7 days",
  "30D": "vs previous 30 days",
  "90D": "vs previous 90 days",
  THIS_MONTH: "vs previous month",
  YTD: "vs previous year",
  ALL_TIME: "",
  CUSTOM: "vs previous period",
};

function buildDelta(
  metric: MetricValue,
  formatter: (value: number) => string,
  comparisonLabel: string,
): { text: string; tone: "positive" | "negative" | "neutral" } | null {
  if (metric.changeAbsolute === null || metric.changeAbsolute === undefined || !comparisonLabel) return null;
  const tone = metric.changeAbsolute > 0 ? "positive" : metric.changeAbsolute < 0 ? "negative" : "neutral";
  const sign = metric.changeAbsolute > 0 ? "+" : "";
  return { text: `${sign}${formatter(metric.changeAbsolute)} ${comparisonLabel}`, tone };
}

type MonthlyMetric = "netResult" | "entryVolume" | "payouts" | "poolsEntered";
type TopUsersSort = "netResult" | "entryVolume" | "accuracy";

const SORT_LABELS: Record<TopUsersSort, string> = {
  netResult: "Net result",
  entryVolume: "Volume",
  accuracy: "Accuracy",
};

function sortValue(row: TopUserRow, sort: TopUsersSort): number {
  if (sort === "accuracy") return row.accuracy ?? -Infinity;
  return row[sort];
}

export function AdminAnalyticsPageClient({ data, preset }: { data: AdminAnalyticsPageData; preset: DateRangePreset }) {
  const [monthlyMetric, setMonthlyMetric] = useState<MonthlyMetric>("netResult");
  const [topUsersSort, setTopUsersSort] = useState<TopUsersSort>("netResult");

  const comparisonLabel = COMPARISON_LABELS[preset];
  const { overview } = data;

  const categoryBars: HorizontalBarDatum[] = useMemo(
    () =>
      data.categoryPerformance
        .map((row) => ({ label: row.label, value: row.netResult, sampleSize: row.entries }))
        .sort((a, b) => b.value - a.value),
    [data.categoryPerformance],
  );

  const monthlyValueGetter: Record<MonthlyMetric, (p: AdminAnalyticsPageData["monthlyActivity"][number]) => number> = {
    netResult: (p) => p.netResult,
    entryVolume: (p) => p.entryVolume,
    payouts: (p) => p.payouts,
    poolsEntered: (p) => p.poolsEntered,
  };
  const monthlyFormatter = monthlyMetric === "poolsEntered" ? (v: number) => String(v) : formatCents;
  const monthlyPoints = data.monthlyActivity.map((p) => ({
    timestamp: p.bucket,
    value: monthlyValueGetter[monthlyMetric](p),
  }));

  const sortedTopUsers = useMemo(
    () => [...data.topUsers].sort((a, b) => sortValue(b, topUsersSort) - sortValue(a, topUsersSort)),
    [data.topUsers, topUsersSort],
  );

  return (
    <div className="space-y-6">
      <AnalyticsPageHeader
        title="Analytics"
        description="Platform-wide activity across every player. Deposits and withdrawals are excluded from betting results — see Reports for house revenue and operational status."
      >
        <AnalyticsFilterBar activePreset={preset} />
      </AnalyticsPageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Net result"
          value={overview.netResult.current !== null ? formatSignedCents(overview.netResult.current) : "—"}
          delta={buildDelta(overview.netResult, formatSignedCents, comparisonLabel)}
          helpText="Realized across every player this period"
        />
        <MetricCard
          label="Entry volume"
          value={overview.entryVolume.current !== null ? formatCents(overview.entryVolume.current) : "—"}
          delta={buildDelta(overview.entryVolume, formatCents, comparisonLabel)}
        />
        <MetricCard
          label="Pools entered"
          value={String(overview.poolsEntered.current ?? 0)}
          delta={buildDelta(overview.poolsEntered, (v) => String(v), comparisonLabel)}
        />
        <MetricCard
          label="Prediction accuracy"
          value={overview.predictionAccuracy.current !== null ? formatPercent(overview.predictionAccuracy.current) : "—"}
          emptyMessage={overview.predictionAccuracy.current === null ? "No graded entries yet." : undefined}
          delta={buildDelta(overview.predictionAccuracy, formatPercent, comparisonLabel)}
          helpText="Entries placed this period — may change until settled"
        />
      </div>

      <LineChartCard
        title="Monthly activity"
        description="Platform participation over time for the selected range. Net result here is by entry date (cohort)."
        points={monthlyPoints}
        valueFormatter={monthlyFormatter}
        modes={[
          { key: "netResult", label: "Net result" },
          { key: "entryVolume", label: "Volume" },
          { key: "payouts", label: "Payouts" },
          { key: "poolsEntered", label: "Pools entered" },
        ]}
        activeMode={monthlyMetric}
        onModeChange={(key) => setMonthlyMetric(key as MonthlyMetric)}
        emptyMessage="No activity in this range yet."
      />

      <HorizontalBarChartCard
        title="Performance by category"
        description="Cohort result of entries placed in this range — may change until every entry settles."
        bars={categoryBars}
        valueFormatter={formatSignedCents}
        colorBySign
        emptyMessage="No settled pools in this range yet."
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text-primary">Top users</h2>
          <div className="flex gap-1 rounded-lg bg-surface-secondary p-1">
            {(Object.keys(SORT_LABELS) as TopUsersSort[]).map((sort) => (
              <button
                key={sort}
                type="button"
                onClick={() => setTopUsersSort(sort)}
                className={
                  topUsersSort === sort
                    ? "rounded-md bg-accent-primary px-2.5 py-1 text-xs font-medium text-white"
                    : "rounded-md px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors"
                }
              >
                {SORT_LABELS[sort]}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Player</th>
                <th className="px-3 py-2 font-medium">Entries</th>
                <th className="px-3 py-2 font-medium">Volume</th>
                <th className="px-3 py-2 font-medium">Net result</th>
                <th className="px-3 py-2 font-medium">Accuracy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {sortedTopUsers.map((row) => (
                <tr key={row.userId}>
                  <td className="px-3 py-2 text-text-primary">
                    <Link
                      href={`/profile/${row.username ?? row.userId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.displayName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{row.entries}</td>
                  <td className="px-3 py-2 text-text-secondary">{formatCents(row.entryVolume)}</td>
                  <td className={row.netResult >= 0 ? "px-3 py-2 font-medium text-credit" : "px-3 py-2 font-medium text-debit"}>
                    {formatSignedCents(row.netResult)}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">
                    {row.accuracy !== null ? formatPercent(row.accuracy) : "—"}
                  </td>
                </tr>
              ))}
              {sortedTopUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
                    No settled entries in this range yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
