"use client";

import { useActionState, useState } from "react";
import { searchTeamsAction, type TeamSearchState } from "@/lib/actions/fixtures";
import type { NormalizedTeam } from "@/lib/sports-data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: TeamSearchState = { error: null, providerDisabled: false, results: [] };

// Unlike leagues (a bounded list, fetched once and preloaded into a
// <select> — see league-select.tsx), there's no feasible "every team API-
// Football knows about" list to preload, so this is a genuine type-to-
// search-then-pick flow: search, get candidate teams (a name like
// "Manchester" matches more than one), click the right one.
export function TeamSearch({ onSelect }: { onSelect: (team: NormalizedTeam) => void }) {
  const [query, setQuery] = useState("");
  const [state, formAction, pending] = useActionState(searchTeamsAction, initialState);

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="team-query">Team name</Label>
          <Input
            id="team-query"
            name="query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Arsenal"
            className="w-56"
          />
        </div>
        <Button type="submit" disabled={pending || query.trim().length === 0}>
          {pending ? "Searching…" : "Search teams"}
        </Button>
      </form>

      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.providerDisabled && (
        <p className="text-sm text-text-secondary">
          The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code>{" "}
          and a valid <code>API_FOOTBALL_KEY</code> to search teams.
        </p>
      )}
      {!state.providerDisabled && !state.error && state.results.length === 0 && !pending && (
        <p className="text-sm text-text-muted">Search a team name above to pick one.</p>
      )}
      {state.results.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-border-subtle">
          {state.results.map((team) => (
            <li key={team.externalTeamId}>
              <button
                type="button"
                onClick={() => onSelect(team)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-secondary"
              >
                <span className="font-medium text-text-primary">{team.name}</span>
                {team.countryName && <span className="text-text-secondary">({team.countryName})</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
