"use client";

import { useMemo } from "react";
import type { NormalizedLeague } from "@/lib/sports-data/types";
import { Label } from "@/components/ui/label";
import { categorizeLeaguesForPicker } from "@/lib/sports-data/league-picker";

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
// handful of competitions they actually run pools on. Everything else
// still falls back to the original per-country breakdown below. See
// lib/sports-data/league-picker.ts for the categorization itself.
export function LeagueSelect({
  leagues,
  onSelect,
}: {
  leagues: NormalizedLeague[];
  onSelect: (league: NormalizedLeague) => void;
}) {
  const { inSeason, otherPriority, countries } = useMemo(
    () => categorizeLeaguesForPicker(leagues),
    [leagues],
  );

  // A league with zero season entries has no real coverage from the
  // provider at all (as opposed to just being out of season right now —
  // that's still a perfectly valid pick, e.g. searching a preseason opener
  // before a new season officially starts) — grayed out here is a data-
  // completeness failsafe, not a "currently active" filter, since the
  // latter would block exactly that kind of near-future search.
  const hasSeasonData = (league: NormalizedLeague) => league.seasons.length > 0;

  const renderOption = (league: NormalizedLeague) => (
    <option key={league.externalLeagueId} value={league.externalLeagueId} disabled={!hasSeasonData(league)}>
      {league.name}
      {league.type ? ` (${league.type})` : ""}
      {hasSeasonData(league) ? "" : " — no season data"}
    </option>
  );

  // The priority groups mix leagues from every country, unlike the
  // per-country groups below where the optgroup label already disambiguates
  // — so a name shared across countries (e.g. two "Serie A"s, Brazil's and
  // Italy's) needs the country spelled out here to stay unambiguous.
  const renderPriorityOption = (league: NormalizedLeague) => (
    <option key={league.externalLeagueId} value={league.externalLeagueId} disabled={!hasSeasonData(league)}>
      {league.name}
      {league.type ? ` (${league.type})` : ""}
      {league.countryName ? ` — ${league.countryName}` : ""}
      {hasSeasonData(league) ? "" : " — no season data"}
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
