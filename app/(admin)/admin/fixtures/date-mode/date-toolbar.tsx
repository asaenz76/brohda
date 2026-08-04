"use client";

import { DATE_RANGE_PRESET_LABEL, type DateRangePreset } from "@/lib/fixtures/date-window";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PRESETS: DateRangePreset[] = ["today", "tomorrow", "today_tomorrow", "next_3_days", "next_7_days", "custom"];

export function DateToolbar({
  preset,
  onPresetChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
}: {
  preset: DateRangePreset;
  onPresetChange: (preset: DateRangePreset) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPresetChange(p)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium",
              preset === p
                ? "border-accent-primary bg-accent-primary/10 text-text-primary"
                : "border-border-subtle text-text-muted hover:text-text-secondary",
            )}
          >
            {DATE_RANGE_PRESET_LABEL[p]}
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="customFrom" className="text-xs text-text-muted">
              From
            </label>
            <Input id="customFrom" type="date" value={customFrom} onChange={(e) => onCustomFromChange(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <label htmlFor="customTo" className="text-xs text-text-muted">
              To
            </label>
            <Input id="customTo" type="date" value={customTo} onChange={(e) => onCustomToChange(e.target.value)} className="w-40" />
          </div>
        </div>
      )}
    </div>
  );
}

export function RefreshButton({ pending, lastRefreshedLabel, onRefresh }: { pending: boolean; lastRefreshedLabel: string | null; onRefresh: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onRefresh}>
        {pending ? "Refreshing…" : "Refresh fixtures"}
      </Button>
      {lastRefreshedLabel && <span className="text-xs text-text-muted">{lastRefreshedLabel}</span>}
    </div>
  );
}
