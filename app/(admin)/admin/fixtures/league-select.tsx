"use client";

import { Label } from "@/components/ui/label";
import {
  SUPPORTED_COMPETITIONS,
  COMPETITION_GROUP_LABEL,
  type CompetitionGroup,
  type SupportedCompetition,
} from "@/lib/sports-data/supported-competitions";

export type SelectableCompetition = SupportedCompetition & { externalLeagueId: string };

// Sourced entirely from the static SUPPORTED_COMPETITIONS config — no live
// provider catalog fetch (page.tsx no longer makes one). This means the
// "by competition" fixture browser can only ever search a supported
// competition, matching the same curated boundary as "By date"'s
// Global/Costa Rica scoping. Unresolved entries (externalLeagueId: null,
// e.g. Costa Rican Cup/Super Cup) and disabled entries are excluded — they
// have no id to search with yet.
const SELECTABLE: SelectableCompetition[] = SUPPORTED_COMPETITIONS.filter(
  (c): c is SelectableCompetition => c.enabled && c.externalLeagueId != null,
);

const GROUPS: CompetitionGroup[] = ["GLOBAL", "COSTA_RICA"];

export function LeagueSelect({ onSelect }: { onSelect: (competition: SelectableCompetition) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="league-select">League</Label>
      <select
        id="league-select"
        defaultValue=""
        onChange={(e) => {
          const competition = SELECTABLE.find((c) => c.externalLeagueId === e.target.value);
          if (competition) onSelect(competition);
        }}
        className="h-9 w-72 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        <option value="" disabled>
          Select a competition…
        </option>
        {GROUPS.map((group) => {
          const list = SELECTABLE.filter((c) => c.group === group);
          if (list.length === 0) return null;
          return (
            <optgroup key={group} label={COMPETITION_GROUP_LABEL[group]}>
              {list.map((c) => (
                <option key={c.externalLeagueId} value={c.externalLeagueId}>
                  {c.name} ({c.country})
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}
