"use client";

import { useActionState, useState } from "react";
import { searchFixturesAction, type FixtureSearchState } from "@/lib/actions/fixtures";
import type { NormalizedLeague, NormalizedTeam } from "@/lib/sports-data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { FixtureResultsList } from "./fixture-results-list";
import { LeagueSelect } from "./league-select";
import { TeamSearch } from "./team-search";

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
  const [mode, setMode] = useState<"by_league" | "by_id" | "by_team">("by_league");
  const [selectedLeague, setSelectedLeague] = useState<NormalizedLeague | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<NormalizedTeam | null>(null);
  const [season, setSeason] = useState("");
  const [date, setDate] = useState("");
  const [state, formAction, pending] = useActionState(searchFixturesAction, initialSearchState);

  // The API requires a season alongside a league on every search — picking
  // a date without knowing that produced a confusing "enter a league and
  // season" error even though a date was given. Auto-fill season from the
  // league's own season calendar (start/end vary per league — most run
  // Aug-May, some run calendar-year, so there's no universal formula) —
  // only while the admin hasn't typed a season themselves.
  function handleDateChange(value: string) {
    setDate(value);
    if (season || !selectedLeague || !value) return;
    const matchingSeason = selectedLeague.seasons.find(
      (s) => value >= s.startDate && value <= s.endDate,
    );
    if (matchingSeason) setSeason(matchingSeason.year);
  }

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
        <Button
          type="button"
          variant={mode === "by_team" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("by_team")}
        >
          By team
        </Button>
      </div>

      {mode === "by_league" && !selectedLeague && (
        <LeagueSelect leagues={leagues} onSelect={setSelectedLeague} />
      )}
      {mode === "by_team" && !selectedTeam && <TeamSearch onSelect={setSelectedTeam} />}

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
                      <Input
                        id="season"
                        name="season"
                        placeholder="2024"
                        className="w-24"
                        value={season}
                        onChange={(e) => setSeason(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="date">Date (optional)</Label>
                      <Input
                        id="date"
                        name="date"
                        type="date"
                        className="w-40"
                        value={date}
                        onChange={(e) => handleDateChange(e.target.value)}
                      />
                    </div>
                  </>
                )}
              </>
            ) : mode === "by_id" ? (
              <div className="space-y-1.5">
                <Label htmlFor="externalFixtureId">Fixture ID</Label>
                <Input
                  id="externalFixtureId"
                  name="externalFixtureId"
                  placeholder="215662"
                  className="w-36"
                />
              </div>
            ) : (
              selectedTeam && (
                <>
                  <input type="hidden" name="teamExternalId" value={selectedTeam.externalTeamId} />
                  <div className="space-y-1.5">
                    <Label>Team</Label>
                    <p className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-text-primary">{selectedTeam.name}</span>
                      <span className="text-text-secondary">
                        {selectedTeam.countryName ? `(${selectedTeam.countryName})` : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedTeam(null)}
                        className="text-xs text-accent-primary underline underline-offset-4"
                      >
                        Change
                      </button>
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="team-date">Date (optional)</Label>
                    <Input
                      id="team-date"
                      name="date"
                      type="date"
                      className="w-40"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                    <p className="text-xs text-text-muted">Defaults to this team&apos;s next 10 fixtures.</p>
                  </div>
                </>
              )
            )}
            <Button
              type="submit"
              disabled={
                pending ||
                (mode === "by_league" && !selectedLeague) ||
                (mode === "by_team" && !selectedTeam)
              }
            >
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
