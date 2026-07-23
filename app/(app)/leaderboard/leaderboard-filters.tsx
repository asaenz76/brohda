"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const SCOPE_TABS = [
  { value: "global", label: "Global" },
  { value: "following", label: "Following" },
] as const;

const RANGE_OPTIONS = [
  { value: "all_time", label: "All-time" },
  { value: "weekly", label: "This week" },
  { value: "monthly", label: "This month" },
] as const;

export function LeaderboardFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scope = searchParams.get("scope") ?? "global";
  const range = searchParams.get("range") ?? "all_time";

  function updateParam(key: "scope" | "range", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.push(`/leaderboard?${params.toString()}`);
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex gap-4 border-b border-border-subtle">
        {SCOPE_TABS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => updateParam("scope", value)}
            aria-current={scope === value ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-1 pb-2 text-sm font-semibold transition-colors",
              scope === value
                ? "border-accent-primary text-text-primary"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <select
        aria-label="Range"
        value={range}
        onChange={(e) => updateParam("range", e.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        {RANGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
