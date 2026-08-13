"use client";

import { useRouter, useSearchParams } from "next/navigation";

// fixtures.sport is the raw provider-facing value (api-football writes
// "football", api-nfl writes "american_football" — see mapGame in each
// provider) — naively capitalizing it read as "American_football" in the
// filter dropdown (underscore intact, only the first letter cased). This
// is purely a display label; the option's `value` stays the raw sport
// string so the actual filter/query param is unaffected.
const SPORT_LABELS: Record<string, string> = {
  football: "Football",
  american_football: "NFL Football",
};

function sportLabel(sport: string): string {
  return SPORT_LABELS[sport] ?? sport.charAt(0).toUpperCase() + sport.slice(1);
}

export function FeedFilters({
  sportOptions,
  leagueOptions,
  activeSort,
}: {
  sportOptions: string[];
  leagueOptions: { key: string; label: string }[];
  activeSort: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateParam(key: "sport" | "league" | "sort", value: string) {
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
        aria-label="Sort by"
        value={activeSort}
        onChange={(e) => updateParam("sort", e.target.value === "newest" ? "" : e.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        <option value="newest">Newest</option>
        <option value="locking_soon">Locking soon</option>
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
            {sportLabel(sport)}
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
          <option key={league.key} value={league.key}>
            {league.label}
          </option>
        ))}
      </select>
    </div>
  );
}
