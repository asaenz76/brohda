"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { wrapAxisNumberFormatter, wrapTooltipValueFormatter } from "@/lib/analytics/format";
import { ChartEmptyState } from "./ChartEmptyState";

export interface HorizontalBarDatum {
  label: string;
  value: number;
  sampleSize?: number;
  // Stable identity for list/element keys when two bars can share a
  // display label (e.g. same-named competitions with different provider
  // ids) — falls back to label when omitted.
  id?: string;
}

interface HorizontalBarChartCardProps {
  title: string;
  description?: string;
  bars: HorizontalBarDatum[];
  valueFormatter?: (value: number) => string;
  emptyMessage?: string;
  modes?: { key: string; label: string }[];
  activeMode?: string;
  onModeChange?: (key: string) => void;
  // Colors bars by sign (win/loss) rather than one flat accent color —
  // for net-result-style metrics where positive/negative carries meaning.
  colorBySign?: boolean;
  sampleSizeLabel?: (sampleSize: number) => string;
}

const tooltipStyle = {
  background: "var(--surface-elevated)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontSize: 12,
};

export function HorizontalBarChartCard({
  title,
  description,
  bars,
  valueFormatter,
  emptyMessage = "No data for this range yet.",
  modes,
  activeMode,
  onModeChange,
  colorBySign = false,
  sampleSizeLabel,
}: HorizontalBarChartCardProps) {
  const hasData = bars.length > 0;
  const height = Math.max(160, bars.length * 40);

  const tooltipValueFormatter = wrapTooltipValueFormatter(valueFormatter);
  const axisValueFormatter = wrapAxisNumberFormatter(valueFormatter);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {modes && modes.length > 1 && (
            <div className="flex shrink-0 flex-wrap gap-1 rounded-lg bg-surface-secondary p-1">
              {modes.map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  onClick={() => onModeChange?.(mode.key)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    activeMode === mode.key ? "bg-accent-primary text-white" : "text-text-secondary",
                  )}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <ChartEmptyState message={emptyMessage} />
        ) : (
          <>
            <div style={{ height }} className="w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bars} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }}>
                  <XAxis type="number" tickFormatter={axisValueFormatter} stroke="var(--text-muted)" fontSize={12} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={120}
                    stroke="var(--text-muted)"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={tooltipValueFormatter}
                    contentStyle={tooltipStyle}
                    itemStyle={{ color: "var(--text-primary)" }}
                    labelStyle={{ color: "var(--text-primary)" }}
                    cursor={false}
                  />
                  <Bar dataKey="value" radius={4}>
                    {bars.map((bar, index) => (
                      <Cell
                        key={index}
                        fill={
                          colorBySign
                            ? bar.value >= 0
                              ? "var(--pool-win)"
                              : "var(--pool-loss)"
                            : "var(--accent-primary)"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {sampleSizeLabel && (
              <ul className="mt-2 space-y-0.5 text-xs text-text-muted">
                {bars
                  .filter((bar) => bar.sampleSize !== undefined)
                  .map((bar) => (
                    <li key={bar.id ?? bar.label}>
                      {bar.label}: {sampleSizeLabel(bar.sampleSize!)}
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
