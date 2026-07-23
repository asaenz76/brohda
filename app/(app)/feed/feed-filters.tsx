"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FEED_STATUS_OPTIONS } from "@/lib/pools/status-filter";

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  LOCKED: "Locked",
  AWAITING_RESULT: "Awaiting Result",
  CANCELLED: "Cancelled",
  VOIDED: "Voided",
  SETTLED: "Settled",
};

// "All" first, then the rest alphabetical by label — the values come from
// the single shared FEED_STATUS_OPTIONS list (lib/pools/status-filter.ts)
// so the dropdown can never drift from what the query actually filters by.
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "ALL", label: "All" },
  ...FEED_STATUS_OPTIONS.map((status) => ({ value: status, label: STATUS_LABELS[status] })).sort(
    (a, b) => a.label.localeCompare(b.label),
  ),
];

export function FeedFilters({
  sportOptions,
  leagueOptions,
}: {
  sportOptions: string[];
  leagueOptions: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateParam(key: "sport" | "league" | "status", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    const query = params.toString();
    router.push(query ? `/feed?${query}` : "/feed");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Filter by status"
        value={searchParams.get("status") ?? "OPEN"}
        onChange={(e) => updateParam("status", e.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        {STATUS_OPTIONS.map((status) => (
          <option key={status.value} value={status.value}>
            {status.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by sport"
        value={searchParams.get("sport") ?? ""}
        onChange={(e) => updateParam("sport", e.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        <option value="">All sports</option>
        {sportOptions.map((sport) => (
          <option key={sport} value={sport}>
            {sport.charAt(0).toUpperCase() + sport.slice(1)}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by league"
        value={searchParams.get("league") ?? ""}
        onChange={(e) => updateParam("league", e.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        <option value="">All leagues</option>
        {leagueOptions.map((league) => (
          <option key={league} value={league}>
            {league}
          </option>
        ))}
      </select>
    </div>
  );
}
