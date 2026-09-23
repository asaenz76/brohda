"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

// Milestone R11 §12, §30, §61. Mirrors app/(app)/leaderboard/leaderboard-filters.tsx's
// own searchParams-driven pattern — kept deliberately smaller (period only,
// no scope toggle: Community-scoped leaderboards were not built in R11,
// see docs/architecture/reputation-leaderboards.md).
const PERIOD_OPTIONS = [
  { value: "ALL_TIME", label: "All-time" },
  { value: "WEEK", label: "This week" },
  { value: "MONTH", label: "This month" },
] as const;

export function PeriodFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const period = searchParams.get("period") ?? "ALL_TIME";

  function updatePeriod(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", value);
    params.delete("page");
    router.push(`/leaderboard/predictions?${params.toString()}`);
  }

  return (
    <div className="flex gap-4 border-b border-border-subtle">
      {PERIOD_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => updatePeriod(value)}
          aria-current={period === value ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-1 pb-2 text-sm font-semibold transition-colors",
            period === value ? "border-accent-primary text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
