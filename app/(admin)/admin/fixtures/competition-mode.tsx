"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { searchFixturesAction, type FixtureSearchState } from "@/lib/actions/fixtures";
import type { NormalizedTeam } from "@/lib/sports-data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { FixtureResultsList } from "./fixture-results-list";
import { LeagueSelect, type SelectableCompetition } from "./league-select";
import { TeamSearch } from "./team-search";

const initialSearchState: FixtureSearchState = { error: null, providerDisabled: false, results: [] };

export interface WorkspaceRef {
  id: string;
  externalLeagueId: string;
  season: string;
}

/**
 * The preserved competition-based fixture browser — cleanly isolated onto
 * its own mode/screen (mode=competition) rather than tab-toggled alongside
 * date and fixture-ID search in one shared component. This is only a
 * fixture browser + selective import tool; it must never duplicate the
 * Competition Workspace's own management surface (import jobs, sync,
 * lifecycle) — see the Open/Create Workspace links below, which hand off
 * to that surface rather than reimplementing any of it here.
 */
export function CompetitionMode({
  workspaces,
  providerDisabled,
}: {
  workspaces: WorkspaceRef[];
  providerDisabled: boolean;
}) {
  const [searchBy, setSearchBy] = useState<"competition" | "team">("competition");
  const [selectedLeague, setSelectedLeague] = useState<SelectableCompetition | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<NormalizedTeam | null>(null);
  const [season, setSeason] = useState("");
  const [date, setDate] = useState("");
  const [state, formAction, pending] = useActionState(searchFixturesAction, initialSearchState);

  const matchingWorkspace = selectedLeague && season ? workspaces.find((w) => w.externalLeagueId === selectedLeague.externalLeagueId && w.season === season) : null;

  if (providerDisabled) {
    return (
      <p className="text-sm text-text-secondary">
        The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code> and a valid <code>API_FOOTBALL_KEY</code> to search and import
        fixtures.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <Button type="button" variant={searchBy === "competition" ? "default" : "outline"} size="sm" onClick={() => setSearchBy("competition")}>
          Search by competition
        </Button>
        <Button type="button" variant={searchBy === "team" ? "default" : "outline"} size="sm" onClick={() => setSearchBy("team")}>
          Search by team
        </Button>
      </div>

      {searchBy === "competition" && !selectedLeague && <LeagueSelect onSelect={setSelectedLeague} />}
      {searchBy === "team" && !selectedTeam && <TeamSearch onSelect={setSelectedTeam} />}

      {selectedLeague && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {matchingWorkspace ? (
            <Link href={`/admin/competitions/${matchingWorkspace.id}`} className="font-medium text-accent-primary hover:underline">
              Open Competition Workspace
            </Link>
          ) : (
            season && (
              <Link href="/admin/competitions" className="font-medium text-accent-primary hover:underline">
                Create Competition Workspace
              </Link>
            )
          )}
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <form action={formAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="mode" value={searchBy === "competition" ? "by_league" : "by_team"} />
            {searchBy === "competition" ? (
              selectedLeague && (
                <>
                  <input type="hidden" name="competitionExternalId" value={selectedLeague.externalLeagueId} />
                  <div className="space-y-1.5">
                    <Label>League</Label>
                    <p className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-text-primary">{selectedLeague.name}</span>
                      <span className="text-text-secondary">{selectedLeague.country ? `(${selectedLeague.country})` : ""}</span>
                      <button type="button" onClick={() => setSelectedLeague(null)} className="text-xs text-accent-primary underline underline-offset-4">
                        Change
                      </button>
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="season">Season</Label>
                    <Input id="season" name="season" placeholder="2024" className="w-24" value={season} onChange={(e) => setSeason(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="date">Date (optional)</Label>
                    <Input id="date" name="date" type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                </>
              )
            ) : (
              selectedTeam && (
                <>
                  <input type="hidden" name="teamExternalId" value={selectedTeam.externalTeamId} />
                  <div className="space-y-1.5">
                    <Label>Team</Label>
                    <p className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-text-primary">{selectedTeam.name}</span>
                      <span className="text-text-secondary">{selectedTeam.countryName ? `(${selectedTeam.countryName})` : ""}</span>
                      <button type="button" onClick={() => setSelectedTeam(null)} className="text-xs text-accent-primary underline underline-offset-4">
                        Change
                      </button>
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="team-date">Date (optional)</Label>
                    <Input id="team-date" name="date" type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
                    <p className="text-xs text-text-muted">Defaults to this team&apos;s next 10 fixtures.</p>
                  </div>
                </>
              )
            )}
            <Button type="submit" disabled={pending || (searchBy === "competition" && !selectedLeague) || (searchBy === "team" && !selectedTeam)}>
              {pending ? "Searching…" : "Search"}
            </Button>
          </form>

          {state.error && <p className="text-sm text-danger">{state.error}</p>}
          {state.providerDisabled && (
            <p className="text-sm text-text-secondary">
              The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code> and a valid <code>API_FOOTBALL_KEY</code> to search and
              import fixtures.
            </p>
          )}
          {!state.providerDisabled && !state.error && state.results.length === 0 && pending === false && (
            <p className="text-sm text-text-muted">No results yet — try a search above.</p>
          )}
        </CardContent>
      </Card>

      {state.results.length > 0 && <FixtureResultsList fixtures={state.results} />}
    </div>
  );
}
