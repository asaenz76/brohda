"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { DateRangePreset } from "@/lib/analytics/types";

// CUSTOM isn't offered here yet — no date-picker UI in this pass. The
// type still supports it for a later phase.
const PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: "7D", label: "7 days" },
  { value: "30D", label: "30 days" },
  { value: "90D", label: "90 days" },
  { value: "THIS_MONTH", label: "This month" },
  { value: "YTD", label: "Year to date" },
  { value: "ALL_TIME", label: "All time" },
];

export function AnalyticsFilterBar({ activePreset }: { activePreset: DateRangePreset }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function selectPreset(preset: DateRangePreset) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", preset);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-surface-secondary p-1">
      {PRESETS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => selectPreset(value)}
          aria-current={activePreset === value ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            activePreset === value
              ? "bg-accent-primary text-white"
              : "text-text-secondary hover:text-text-primary",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
