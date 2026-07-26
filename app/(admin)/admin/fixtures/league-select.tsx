"use client";

import { useMemo } from "react";
import type { NormalizedLeague } from "@/lib/sports-data/types";
import { Label } from "@/components/ui/label";
import {
  compareLeagueTier,
  getPriorityLeagueMap,
  isLeagueInSeason,
} from "@/lib/sports-data/priority-leagues";

// A dropdown of every league the provider knows about (fetched once,
// server-side, at page load — see page.tsx) rather than a type-to-search
// box: with the full list already in hand there's nothing to search for,
// and a native <select> with <optgroup> per country is free browser-native
// type-ahead for narrowing hundreds of entries.
//
// The curated PRIORITY_LEAGUES list (this platform's actual focus, not
// every league API-Football knows about) gets pulled to the top in two
// groups — "In season now" first, then the rest by tier — so the super
// admin doesn't have to hunt through hundreds of countries for the
// handful of leagues they actually run pools on. Everything else still
// falls back to the original per-country breakdown below.
export function LeagueSelect({
  leagues,
  onSelect,
}: {
  leagues: NormalizedLeague[];
  onSelect: (league: NormalizedLeague) => void;
}) {
  const { inSeason, otherPriority, countries } = useMemo(() => {
    const priorityMap = getPriorityLeagueMap();
    const currentMonth = new Date().getMonth() + 1;

    const inSeason: NormalizedLeague[] = [];
    const otherPriority: NormalizedLeague[] = [];
    const rest: NormalizedLeague[] = [];

    for (const league of leagues) {
      const priority = priorityMap.get(league.externalLeagueId);
      if (!priority) {
        rest.push(league);
      } else if (isLeagueInSeason(priority, currentMonth)) {
        inSeason.push(league);
      } else {
        otherPriority.push(league);
      }
    }

    const byTier = (a: NormalizedLeague, b: NormalizedLeague) => {
      const tierA = priorityMap.get(a.externalLeagueId)?.tier ?? "C";
      const tierB = priorityMap.get(b.externalLeagueId)?.tier ?? "C";
      return compareLeagueTier(tierA, tierB) || a.name.localeCompare(b.name);
    };
    inSeason.sort(byTier);
    otherPriority.sort(byTier);

    const byCountry = new Map<string, NormalizedLeague[]>();
    for (const league of rest) {
      const key = league.countryName ?? "Other";
      if (!byCountry.has(key)) byCountry.set(key, []);
      byCountry.get(key)!.push(league);
    }
    const countries = [...byCountry.entries()]
      .map(([country, list]): [string, NormalizedLeague[]] => [
        country,
        [...list].sort((a, b) => a.name.localeCompare(b.name)),
      ])
      .sort(([a], [b]) => a.localeCompare(b));

    return { inSeason, otherPriority, countries };
  }, [leagues]);

  const renderOption = (league: NormalizedLeague) => (
    <option key={league.externalLeagueId} value={league.externalLeagueId}>
      {league.name}
      {league.type ? ` (${league.type})` : ""}
    </option>
  );

  // The priority groups mix leagues from every country, unlike the
  // per-country groups below where the optgroup label already disambiguates
  // — so a name shared across countries (e.g. two "Serie A"s, Brazil's and
  // Italy's) needs the country spelled out here to stay unambiguous.
  const renderPriorityOption = (league: NormalizedLeague) => (
    <option key={league.externalLeagueId} value={league.externalLeagueId}>
      {league.name}
      {league.type ? ` (${league.type})` : ""}
      {league.countryName ? ` — ${league.countryName}` : ""}
    </option>
  );

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
        {inSeason.length > 0 && (
          <optgroup label="⭐ In season now">{inSeason.map(renderPriorityOption)}</optgroup>
        )}
        {otherPriority.length > 0 && (
          <optgroup label="Other major leagues">{otherPriority.map(renderPriorityOption)}</optgroup>
        )}
        {countries.map(([country, list]) => (
          <optgroup key={country} label={country}>
            {list.map(renderOption)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
