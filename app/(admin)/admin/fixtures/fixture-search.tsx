"use client";

import { useActionState, useState } from "react";
import { searchFixturesAction, type FixtureSearchState } from "@/lib/actions/fixtures";
import type { NormalizedLeague } from "@/lib/sports-data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { FixtureResultsList } from "./fixture-results-list";
import { LeagueSelect } from "./league-select";

const initialSearchState: FixtureSearchState = {
  error: null,
  providerDisabled: false,
  results: [],
};

export function FixtureSearch({
  leagues,
  providerDisabled,
}: {
  leagues: NormalizedLeague[];
  providerDisabled: boolean;
}) {
  const [mode, setMode] = useState<"by_league" | "by_id">("by_league");
  const [selectedLeague, setSelectedLeague] = useState<NormalizedLeague | null>(null);
  const [state, formAction, pending] = useActionState(searchFixturesAction, initialSearchState);

  if (providerDisabled) {
    return (
      <p className="text-sm text-text-secondary">
        The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code>{" "}
        and a valid <code>API_FOOTBALL_KEY</code> to search and import fixtures.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <Button
          type="button"
          variant={mode === "by_league" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("by_league")}
        >
          By league
        </Button>
        <Button
          type="button"
          variant={mode === "by_id" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("by_id")}
        >
          By fixture ID
        </Button>
      </div>

      {mode === "by_league" && !selectedLeague && (
        <LeagueSelect leagues={leagues} onSelect={setSelectedLeague} />
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <form action={formAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="mode" value={mode} />
            {mode === "by_league" ? (
              <>
                {selectedLeague && (
                  <>
                    <input
                      type="hidden"
                      name="competitionExternalId"
                      value={selectedLeague.externalLeagueId}
                    />
                    <div className="space-y-1.5">
                      <Label>League</Label>
                      <p className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-text-primary">{selectedLeague.name}</span>
                        <span className="text-text-secondary">
                          {selectedLeague.countryName ? `(${selectedLeague.countryName})` : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedLeague(null)}
                          className="text-xs text-accent-primary underline underline-offset-4"
                        >
                          Change
                        </button>
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="season">Season</Label>
                      <Input id="season" name="season" placeholder="2024" className="w-24" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="date">Date (optional)</Label>
                      <Input id="date" name="date" type="date" className="w-40" />
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="externalFixtureId">Fixture ID</Label>
                <Input
                  id="externalFixtureId"
                  name="externalFixtureId"
                  placeholder="215662"
                  className="w-36"
                />
              </div>
            )}
            <Button type="submit" disabled={pending || (mode === "by_league" && !selectedLeague)}>
              {pending ? "Searching…" : "Search"}
            </Button>
          </form>

          {state.error && <p className="text-sm text-danger">{state.error}</p>}
          {state.providerDisabled && (
            <p className="text-sm text-text-secondary">
              The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code>{" "}
              and a valid <code>API_FOOTBALL_KEY</code> to search and import fixtures.
            </p>
          )}
          {!state.providerDisabled &&
            !state.error &&
            state.results.length === 0 &&
            pending === false && (
              <p className="text-sm text-text-muted">No results yet — try a search above.</p>
            )}
        </CardContent>
      </Card>

      {state.results.length > 0 && <FixtureResultsList fixtures={state.results} />}
    </div>
  );
}
