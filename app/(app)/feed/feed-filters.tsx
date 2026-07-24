"use client";

import { useRouter, useSearchParams } from "next/navigation";

export function FeedFilters({
  sportOptions,
  leagueOptions,
}: {
  sportOptions: string[];
  leagueOptions: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateParam(key: "sport" | "league", value: string) {
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
