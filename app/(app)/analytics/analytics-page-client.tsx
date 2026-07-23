"use client";

import { useMemo, useState } from "react";
import { AnalyticsFilterBar } from "@/components/analytics/AnalyticsFilterBar";
import { AnalyticsPageHeader } from "@/components/analytics/AnalyticsPageHeader";
import { MetricCard } from "@/components/analytics/MetricCard";
import { LineChartCard } from "@/components/analytics/LineChartCard";
import { HorizontalBarChartCard, type HorizontalBarDatum } from "@/components/analytics/HorizontalBarChartCard";
import { StreakTimeline } from "@/components/analytics/StreakTimeline";
import { EntryHighlightsTable } from "@/components/analytics/EntryHighlightsTable";
import { formatChartDate, formatPercent, formatSignedCents } from "@/lib/analytics/format";
import { formatCents } from "@/lib/utils/money";
import type { DateRangePreset, MetricValue } from "@/lib/analytics/types";
import type { UserAnalyticsPageData } from "@/lib/analytics/userAnalyticsService";

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

type RatioMetricKey = "netResult" | "returnOnEntries" | "accuracy" | "entries" | "entryVolume";

const METRIC_OPTIONS: {
  key: RatioMetricKey;
  label: string;
  formatter: (value: number) => string;
  colorBySign: boolean;
}[] = [
  { key: "netResult", label: "Net result", formatter: formatSignedCents, colorBySign: true },
  { key: "returnOnEntries", label: "Return on entries", formatter: formatPercent, colorBySign: true },
  { key: "accuracy", label: "Accuracy", formatter: formatPercent, colorBySign: false },
  { key: "entries", label: "Entries", formatter: (v) => String(v), colorBySign: false },
  { key: "entryVolume", label: "Entry volume", formatter: formatCents, colorBySign: false },
];

interface MetricBearingRow {
  entries: number;
  entryVolume: number;
  netResult: number;
  returnOnEntries: number | null;
  accuracy: number | null;
}

function metricValue(row: MetricBearingRow, metric: RatioMetricKey): number | null {
  if (metric === "entries") return row.entries;
  return row[metric];
}

function toBars<T extends MetricBearingRow>(
  rows: T[],
  metric: RatioMetricKey,
  getLabel: (row: T) => string,
  getId?: (row: T) => string,
): HorizontalBarDatum[] {
  const bars: HorizontalBarDatum[] = [];
  for (const row of rows) {
    const value = metricValue(row, metric);
    if (value !== null) bars.push({ label: getLabel(row), value, sampleSize: row.entries, id: getId?.(row) });
  }
  return bars.sort((a, b) => b.value - a.value);
}

export function AnalyticsPageClient({ data, preset }: { data: UserAnalyticsPageData; preset: DateRangePreset }) {
  const [bankrollMode, setBankrollMode] = useState<"balance" | "cumulative">("balance");
  const [categoryMetric, setCategoryMetric] = useState<RatioMetricKey>("netResult");
  const [competitionMetric, setCompetitionMetric] = useState<RatioMetricKey>("netResult");
  const [monthlyMetric, setMonthlyMetric] = useState<"netResult" | "entryVolume" | "payouts" | "poolsEntered">(
    "netResult",
  );

  const comparisonLabel = COMPARISON_LABELS[preset];

  const categoryMetricOption = METRIC_OPTIONS.find((m) => m.key === categoryMetric)!;
  const competitionMetricOption = METRIC_OPTIONS.find((m) => m.key === competitionMetric)!;

  const categoryBars = useMemo(
    () => toBars(data.categoryPerformance, categoryMetric, (row) => row.label),
    [data.categoryPerformance, categoryMetric],
  );
  const competitionBars = useMemo(
    () => toBars(data.competitionPerformance, competitionMetric, (row) => row.competitionName, (row) => row.competitionKey),
    [data.competitionPerformance, competitionMetric],
  );

  const bankrollPoints = bankrollMode === "balance" ? data.bankrollBalance : data.bankrollCumulative;

  const monthlyValueGetter: Record<typeof monthlyMetric, (p: UserAnalyticsPageData["monthlyActivity"][number]) => number> = {
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

  const { overview } = data;
  const chartDateFormatter = (iso: string) => formatChartDate(iso, data.timeZone);

  return (
    <div className="space-y-6">
      <AnalyticsPageHeader
        title="Analytics"
        description="Your personal pool performance. Deposits and withdrawals are excluded from betting results."
      >
        <AnalyticsFilterBar activePreset={preset} />
      </AnalyticsPageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard
          label="Net result"
          value={overview.netResult.current !== null ? formatSignedCents(overview.netResult.current) : "—"}
          delta={buildDelta(overview.netResult, formatSignedCents, comparisonLabel)}
          helpText="Realized wallet result during this period"
        />
        <MetricCard
          label="Realized ROI"
          value={overview.returnOnEntries.current !== null ? formatPercent(overview.returnOnEntries.current) : "—"}
          emptyMessage={overview.returnOnEntries.current === null ? "No settled entries yet." : undefined}
          delta={buildDelta(overview.returnOnEntries, formatPercent, comparisonLabel)}
          helpText="Won/lost entries settled this period only"
        />
        <MetricCard
          label="Prediction accuracy"
          value={overview.predictionAccuracy.current !== null ? formatPercent(overview.predictionAccuracy.current) : "—"}
          emptyMessage={overview.predictionAccuracy.current === null ? "No graded entries yet." : undefined}
          delta={buildDelta(overview.predictionAccuracy, formatPercent, comparisonLabel)}
          helpText="Result of entries placed this period — may change until settled"
        />
        <MetricCard
          label="Pools entered"
          value={String(overview.poolsEntered.current ?? 0)}
          delta={buildDelta(overview.poolsEntered, (v) => String(v), comparisonLabel)}
        />
        <MetricCard
          label="Current streak"
          value={
            overview.currentStreak > 0
              ? `${overview.currentStreak}W`
              : overview.currentStreak < 0
                ? `${-overview.currentStreak}L`
                : "—"
          }
        />
        <MetricCard
          label="Best category"
          value={overview.bestCategory ? overview.bestCategory.label : "—"}
          helpText={overview.bestCategory ? formatSignedCents(overview.bestCategory.netResult) : undefined}
          emptyMessage={overview.bestCategory ? undefined : "No graded entries yet."}
        />
      </div>

      <LineChartCard
        title={bankrollMode === "balance" ? "Account balance" : "Cumulative pool result"}
        description={
          bankrollMode === "balance"
            ? "Your wallet balance over time. Includes deposits, withdrawals, and pool activity."
            : "Realized running total, dated by settlement — when an entry actually paid out or lost, not when it was placed. Deposits and withdrawals are excluded."
        }
        points={bankrollPoints}
        variant="area"
        valueFormatter={formatCents}
        labelFormatter={chartDateFormatter}
        modes={[
          { key: "balance", label: "Account balance" },
          { key: "cumulative", label: "Pool result" },
        ]}
        activeMode={bankrollMode}
        onModeChange={(key) => setBankrollMode(key as "balance" | "cumulative")}
        color={bankrollMode === "cumulative" ? "var(--pool-win)" : "var(--accent-primary)"}
        emptyMessage="Enter more pools to unlock this graph."
      />

      <HorizontalBarChartCard
        title="Performance by category"
        description="Cohort result of entries placed in this range — may change until every entry settles."
        bars={categoryBars}
        valueFormatter={categoryMetricOption.formatter}
        colorBySign={categoryMetricOption.colorBySign}
        modes={METRIC_OPTIONS.map((m) => ({ key: m.key, label: m.label }))}
        activeMode={categoryMetric}
        onModeChange={(key) => setCategoryMetric(key as RatioMetricKey)}
        emptyMessage="No settled pools in this range yet."
      />

      <HorizontalBarChartCard
        title="Performance by competition"
        description="Cohort result of entries placed in this range — may change until every entry settles. Small samples aren't statistically meaningful."
        bars={competitionBars}
        valueFormatter={competitionMetricOption.formatter}
        colorBySign={competitionMetricOption.colorBySign}
        modes={METRIC_OPTIONS.map((m) => ({ key: m.key, label: m.label }))}
        activeMode={competitionMetric}
        onModeChange={(key) => setCompetitionMetric(key as RatioMetricKey)}
        emptyMessage="No settled pools in this range yet."
        sampleSizeLabel={(n) => `Based on ${n} ${n === 1 ? "entry" : "entries"}`}
      />

      <LineChartCard
        title="Monthly activity"
        description="Your participation over time for the selected range. Net result here is by entry date (cohort) — see Cumulative pool result above for realized, settlement-dated P&L."
        points={monthlyPoints}
        valueFormatter={monthlyFormatter}
        labelFormatter={chartDateFormatter}
        modes={[
          { key: "netResult", label: "Net result" },
          { key: "entryVolume", label: "Volume" },
          { key: "payouts", label: "Payouts" },
          { key: "poolsEntered", label: "Pools entered" },
        ]}
        activeMode={monthlyMetric}
        onModeChange={(key) => setMonthlyMetric(key as typeof monthlyMetric)}
        emptyMessage="No activity in this range yet."
      />

      <StreakTimeline
        symbols={data.streakTimeline.symbols}
        currentStreak={data.streakTimeline.currentStreak}
        longestWinStreak={data.streakTimeline.longestWinStreak}
        longestLossStreak={data.streakTimeline.longestLossStreak}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <EntryHighlightsTable
          title="Biggest wins"
          description="Your highest net-result graded entries in this range."
          entries={data.biggestWins}
          emptyMessage="No wins in this range yet."
        />
        <EntryHighlightsTable
          title="Biggest losses"
          description="Your lowest net-result graded entries in this range."
          entries={data.biggestLosses}
          emptyMessage="No losses in this range yet."
        />
      </div>
    </div>
  );
}
