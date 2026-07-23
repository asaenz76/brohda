"use client";

import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  wrapAxisLabelFormatter,
  wrapAxisNumberFormatter,
  wrapTooltipLabelFormatter,
  wrapTooltipValueFormatter,
} from "@/lib/analytics/format";
import { ChartEmptyState } from "./ChartEmptyState";

interface LineChartCardProps {
  title: string;
  description?: string;
  points: { timestamp: string; value: number }[];
  valueFormatter?: (value: number) => string;
  labelFormatter?: (timestamp: string) => string;
  variant?: "line" | "area";
  emptyMessage?: string;
  modes?: { key: string; label: string }[];
  activeMode?: string;
  onModeChange?: (key: string) => void;
  color?: string;
}

const tooltipStyle = {
  background: "var(--surface-elevated)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontSize: 12,
};

export function LineChartCard({
  title,
  description,
  points,
  valueFormatter,
  labelFormatter,
  variant = "line",
  emptyMessage = "No data for this range yet.",
  modes,
  activeMode,
  onModeChange,
  color = "var(--accent-primary)",
}: LineChartCardProps) {
  const hasData = points.length > 0;

  const tooltipValueFormatter = wrapTooltipValueFormatter(valueFormatter);
  const tooltipLabelFormatter = wrapTooltipLabelFormatter(labelFormatter);
  const axisValueFormatter = wrapAxisNumberFormatter(valueFormatter);
  const axisLabelFormatter = wrapAxisLabelFormatter(labelFormatter);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {modes && modes.length > 1 && (
            <div className="flex shrink-0 gap-1 rounded-lg bg-surface-secondary p-1">
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
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {variant === "area" ? (
                <AreaChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={axisLabelFormatter}
                    stroke="var(--text-muted)"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={axisValueFormatter}
                    stroke="var(--text-muted)"
                    fontSize={12}
                    width={64}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={tooltipValueFormatter}
                    labelFormatter={tooltipLabelFormatter}
                    contentStyle={tooltipStyle}
                    itemStyle={{ color: "var(--text-primary)" }}
                    labelStyle={{ color: "var(--text-primary)" }}
                  />
                  <Area type="monotone" dataKey="value" stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              ) : (
                <LineChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={axisLabelFormatter}
                    stroke="var(--text-muted)"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={axisValueFormatter}
                    stroke="var(--text-muted)"
                    fontSize={12}
                    width={64}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={tooltipValueFormatter}
                    labelFormatter={tooltipLabelFormatter}
                    contentStyle={tooltipStyle}
                    itemStyle={{ color: "var(--text-primary)" }}
                    labelStyle={{ color: "var(--text-primary)" }}
                  />
                  <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
