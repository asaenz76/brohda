"use client";

import { useMemo } from "react";
import type { NormalizedLeague } from "@/lib/sports-data/types";
import { Label } from "@/components/ui/label";

// A dropdown of every league the provider knows about (fetched once,
// server-side, at page load — see page.tsx) rather than a type-to-search
// box: with the full list already in hand there's nothing to search for,
// and a native <select> with <optgroup> per country is free browser-native
// type-ahead for narrowing hundreds of entries.
export function LeagueSelect({
  leagues,
  onSelect,
}: {
  leagues: NormalizedLeague[];
  onSelect: (league: NormalizedLeague) => void;
}) {
  const countries = useMemo(() => {
    const byCountry = new Map<string, NormalizedLeague[]>();
    for (const league of leagues) {
      const key = league.countryName ?? "Other";
      if (!byCountry.has(key)) byCountry.set(key, []);
      byCountry.get(key)!.push(league);
    }
    return [...byCountry.entries()]
      .map(([country, list]): [string, NormalizedLeague[]] => [
        country,
        [...list].sort((a, b) => a.name.localeCompare(b.name)),
      ])
      .sort(([a], [b]) => a.localeCompare(b));
  }, [leagues]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor="league-select">League</Label>
      <select
        id="league-select"
        defaultValue=""
        onChange={(e) => {
          const league = leagues.find((l) => l.externalLeagueId === e.target.value);
          if (league) onSelect(league);
        }}
        className="h-9 w-72 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        <option value="" disabled>
          Select a league…
        </option>
        {countries.map(([country, list]) => (
          <optgroup key={country} label={country}>
            {list.map((league) => (
              <option key={league.externalLeagueId} value={league.externalLeagueId}>
                {league.name}
                {league.type ? ` (${league.type})` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
