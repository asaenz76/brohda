"use client";

import { useState } from "react";
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

// Launch simplification: the leaderboard opens straight to one view — the
// whole group, all-time — with zero decisions in front of the ranking
// itself (see PRODUCT_SIMPLICITY_REVIEW.md / UX_FRICTION_REPORT.md).
// Deliberately keeping "global" as that default rather than "following":
// in an invite-only app every player already IS someone you know, so
// "global" already reads as "your circle" — defaulting to "following"
// instead risks a new or lightly-social user landing on an empty
// leaderboard before they've followed anyone (see the empty-state copy in
// page.tsx). The full 2-scope x 3-range picker still exists, just behind
// an explicit "More views" toggle instead of shown by default.
export function LeaderboardFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scope = searchParams.get("scope") ?? "global";
  const range = searchParams.get("range") ?? "all_time";
  const hasNonDefaultView = scope !== "global" || range !== "all_time";
  const [expanded, setExpanded] = useState(hasNonDefaultView);

  function updateParam(key: "scope" | "range", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.push(`/leaderboard?${params.toString()}`);
  }

  if (!expanded) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs font-medium text-accent-primary hover:underline"
        >
          More views
        </button>
      </div>
    );
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
