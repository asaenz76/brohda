"use client";

// Phase 2 spec §7: sourced entirely from SUPPORTED_COMPETITIONS ∩
// league_season_imports (passed in as `options`, computed server-side in
// page.tsx) — never a live provider catalog fetch. A competition with no
// imported season shows "Not imported" and a link to the Competition
// Workspace, never an automatic provider call.
import Link from "next/link";
import { useState } from "react";
import type { LocalCompetitionOption } from "@/lib/fixtures/local-competition-options";
import { COMPETITION_GROUP_LABEL, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import { Label } from "@/components/ui/label";

const GROUPS: CompetitionGroup[] = ["GLOBAL", "COSTA_RICA"];

export function CompetitionSeasonSelect({
  options,
  onSelect,
}: {
  options: LocalCompetitionOption[];
  onSelect: (externalLeagueId: string, season: string) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [season, setSeason] = useState("");
  const selected = options.find((c) => c.externalLeagueId === selectedId) ?? null;

  function handleCompetitionChange(id: string) {
    setSelectedId(id);
    const comp = options.find((c) => c.externalLeagueId === id);
    const firstSeason = comp?.seasons[0]?.season ?? "";
    setSeason(firstSeason);
    if (comp && firstSeason) onSelect(id, firstSeason);
  }

  function handleSeasonChange(value: string) {
    setSeason(value);
    if (selectedId) onSelect(selectedId, value);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="competition-select">Competition</Label>
        <select
          id="competition-select"
          value={selectedId}
          onChange={(e) => handleCompetitionChange(e.target.value)}
          className="h-9 w-72 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="" disabled>
            Select a competition…
          </option>
          {GROUPS.map((group) => {
            const list = options.filter((c) => c.group === group);
            if (list.length === 0) return null;
            return (
              <optgroup key={group} label={COMPETITION_GROUP_LABEL[group]}>
                {list.map((c) => (
                  <option key={c.externalLeagueId} value={c.externalLeagueId}>
                    {c.name} ({c.country})
                    {c.seasons.length === 0 ? " — not imported" : ""}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>

      {selected && selected.seasons.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor="season-select">Season</Label>
          <select
            id="season-select"
            value={season}
            onChange={(e) => handleSeasonChange(e.target.value)}
            className="h-9 w-32 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {selected.seasons.map((s) => (
              <option key={s.season} value={s.season}>
                {s.season}
              </option>
            ))}
          </select>
        </div>
      )}

      {selected && selected.seasons.length === 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium text-text-primary">Not imported</p>
          <Link href="/admin/competitions" className="text-xs font-medium text-accent-primary hover:underline">
            Go to Competition Workspace
          </Link>
        </div>
      )}
    </div>
  );
}
