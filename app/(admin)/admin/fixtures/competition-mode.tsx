"use client";

// Phase 2 (local-first football browsing): By-competition browsing is now
// pure local-DB (spec §1/§6/§7) — selecting a supported+imported
// competition/season calls only browseFixturesByCompetitionSeasonAction
// (lib/actions/fixture-browse.ts), which never touches
// apiFootballProvider. The old provider-backed league/team search still
// exists, but only inside the "Discover from provider" toggle below,
// never mounted until the admin explicitly opens it (spec §10).
import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { searchFixturesAction, type FixtureSearchState } from "@/lib/actions/fixtures";
import { browseFixturesByCompetitionSeasonAction } from "@/lib/actions/fixture-browse";
import type { LocalCompetitionOption } from "@/lib/fixtures/local-competition-options";
import type { LocalFixtureBrowseResult } from "@/lib/fixtures/local-browse";
import { groupAndSortLocalFixtures } from "@/lib/fixtures/local-grouping";
import { defaultLocalFixtureFilters, filterLocalFixtures, isDefaultLocalFixtureFilters, type LocalFixtureFilters } from "@/lib/fixtures/local-filters";
import { CompetitionSeasonSelect } from "./competition-season-select";
import { LocalFixtureDateGroups } from "./local-fixture-groups";
import { FixtureResultsList } from "./fixture-results-list";
import { LeagueSelect, type SelectableCompetition } from "./league-select";
import { TeamSearch } from "./team-search";
import type { NormalizedTeam } from "@/lib/sports-data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialSearchState: FixtureSearchState = { error: null, providerDisabled: false, results: [] };

export function CompetitionMode({
  options,
  providerDisabled,
}: {
  options: LocalCompetitionOption[];
  providerDisabled: boolean;
}) {
  const [selection, setSelection] = useState<{ externalLeagueId: string; season: string } | null>(null);
  const [result, setResult] = useState<LocalFixtureBrowseResult | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [filters, setFilters] = useState<LocalFixtureFilters>(defaultLocalFixtureFilters);
  const [showDiscovery, setShowDiscovery] = useState(false);

  const selectedOption = selection ? (options.find((c) => c.externalLeagueId === selection.externalLeagueId) ?? null) : null;
  const workspace = selectedOption?.seasons.find((s) => s.season === selection?.season) ?? null;

  async function handleSelect(externalLeagueId: string, season: string) {
    setSelection({ externalLeagueId, season });
    setPending(true);
    setBrowseError(null);
    const response = await browseFixturesByCompetitionSeasonAction(externalLeagueId, season);
    setPending(false);
    if (!response.success) {
      setBrowseError(response.error);
      setResult(null);
      return;
    }
    setResult(response.result);
  }

  const rounds = useMemo(() => [...new Set((result?.fixtures ?? []).map((f) => f.round).filter((r): r is string => Boolean(r)))], [result]);

  const dateGroups = useMemo(() => {
    if (!result) return [];
    return groupAndSortLocalFixtures(filterLocalFixtures(result.fixtures, filters));
  }, [result, filters]);

  const filtersActive = !isDefaultLocalFixtureFilters(filters);

  return (
    <div className="space-y-6">
      <CompetitionSeasonSelect options={options} onSelect={handleSelect} />

      {workspace && (
        <Link href={`/admin/competitions/${workspace.leagueSeasonImportId}`} className="text-xs font-medium text-accent-primary hover:underline">
          Open Competition Workspace
        </Link>
      )}

      {pending && <p className="text-sm text-text-muted">Loading fixtures…</p>}
      {browseError && <p className="text-sm text-danger">{browseError}</p>}

      {result && !pending && (
        <>
          <div className="rounded-lg border border-border-subtle p-3 text-xs text-text-secondary">
            <p>
              {result.counts.total} fixture{result.counts.total === 1 ? "" : "s"} · {result.counts.withPools} with pools · {result.counts.upcoming} upcoming ·{" "}
              {result.counts.live} live · {result.counts.completed} completed
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="comp-search">Team or search</Label>
              <Input id="comp-search" placeholder="Search teams…" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} className="h-8 w-56" />
            </div>
            {rounds.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="comp-round">Round</Label>
                <select id="comp-round" value={filters.round} onChange={(e) => setFilters((f) => ({ ...f, round: e.target.value }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
                  <option value="">All rounds</option>
                  {rounds.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="comp-status">Status</Label>
              <select id="comp-status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as LocalFixtureFilters["status"] }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
                <option value="all">All statuses</option>
                <option value="UPCOMING">Upcoming</option>
                <option value="LIVE">Live</option>
                <option value="COMPLETED">Completed</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="comp-pool">Pool status</Label>
              <select id="comp-pool" value={filters.poolStatus} onChange={(e) => setFilters((f) => ({ ...f, poolStatus: e.target.value as LocalFixtureFilters["poolStatus"] }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
                <option value="all">Any pool status</option>
                <option value="has_pool">Has pools</option>
                <option value="no_pool">No pools</option>
                <option value="eligible_only">Eligible for pool creation</option>
              </select>
            </div>
            {filtersActive && (
              <button type="button" onClick={() => setFilters(defaultLocalFixtureFilters())} className="text-xs font-medium text-accent-primary hover:underline">
                Clear filters
              </button>
            )}
          </div>

          {dateGroups.length > 0 ? (
            <LocalFixtureDateGroups dateGroups={dateGroups} timeZone="America/Costa_Rica" />
          ) : (
            <p className="text-sm text-text-muted">{result.counts.total === 0 ? "No fixtures imported for this season." : "Fixtures exist, but none match the current filters."}</p>
          )}
        </>
      )}

      {!providerDisabled && (
        <div className="border-t border-border-subtle pt-3">
          <button type="button" onClick={() => setShowDiscovery((v) => !v)} className="text-xs font-medium text-accent-primary hover:underline">
            {showDiscovery ? "Hide" : "Discover fixtures from provider"}
          </button>
          {showDiscovery && <ProviderCompetitionDiscovery />}
        </div>
      )}
    </div>
  );
}

/** The old provider-backed by-league/by-team search — unchanged, just
 * demoted to an explicit, never-auto-fired secondary tool (spec §10). */
function ProviderCompetitionDiscovery() {
  const [searchBy, setSearchBy] = useState<"competition" | "team">("competition");
  const [selectedLeague, setSelectedLeague] = useState<SelectableCompetition | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<NormalizedTeam | null>(null);
  const [season, setSeason] = useState("");
  const [date, setDate] = useState("");
  const [state, formAction, pending] = useActionState(searchFixturesAction, initialSearchState);

  return (
    <div className="mt-2 space-y-4 rounded-lg border border-dashed border-border-subtle p-3">
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
          {state.providerDisabled && <p className="text-sm text-text-secondary">The sports data provider isn&apos;t enabled.</p>}
          {!state.providerDisabled && !state.error && state.results.length === 0 && pending === false && (
            <p className="text-sm text-text-muted">No results yet — try a search above.</p>
          )}
        </CardContent>
      </Card>

      {state.results.length > 0 && <FixtureResultsList fixtures={state.results} />}
    </div>
  );
}
