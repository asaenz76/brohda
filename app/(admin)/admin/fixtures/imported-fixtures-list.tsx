"use client";

import { useState, useTransition } from "react";
import { deleteFixtureAction } from "@/lib/actions/fixtures";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ImportedFixture {
  id: string;
  externalFixtureId: string;
  sport: string | null;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  competitionCountry: string | null;
  scheduledStartUtc: string;
  hasPost: boolean;
}

// Several countries have leagues that share the exact same name (e.g.
// "Primera División" — Costa Rica, Peru, Chile, Uruguay all use it) —
// same disambiguation convention already used by the Feed page's league
// filter and LeagueIdentity.
function leagueKey(name: string, country: string | null): string {
  return country ? `${country}|${name}` : name;
}
function leagueLabel(name: string, country: string | null): string {
  return country ? `${country} | ${name}` : name;
}

export function ImportedFixturesList({
  fixtures,
  isSuperAdmin,
  heading = "Imported fixtures",
}: {
  fixtures: ImportedFixture[];
  isSuperAdmin: boolean;
  heading?: string;
}) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [fixtureIdFilter, setFixtureIdFilter] = useState("");
  const [sportFilter, setSportFilter] = useState("");
  const [leagueFilter, setLeagueFilter] = useState("");

  const remaining = fixtures.filter((f) => !removed.has(f.id));

  const sportOptions = [...new Set(remaining.map((f) => f.sport).filter((s): s is string => s != null))].sort();
  const leagueOptions = [
    ...new Map(
      remaining
        .filter((f): f is typeof f & { competitionName: string } => f.competitionName != null)
        .map((f) => {
          const key = leagueKey(f.competitionName, f.competitionCountry);
          return [key, { key, label: leagueLabel(f.competitionName, f.competitionCountry) }] as const;
        }),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label));

  const visible = remaining
    .filter((f) => f.externalFixtureId.includes(fixtureIdFilter.trim()))
    .filter((f) => (sportFilter ? f.sport === sportFilter : true))
    .filter((f) => (leagueFilter ? leagueKey(f.competitionName ?? "", f.competitionCountry) === leagueFilter : true));

  if (remaining.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text-primary">
          {heading} ({visible.length})
        </h2>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="filter-sport">Sport</Label>
          <select
            id="filter-sport"
            aria-label="Filter by sport"
            value={sportFilter}
            onChange={(e) => setSportFilter(e.target.value)}
            className="h-8 w-40 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">All sports</option>
            {sportOptions.map((sport) => (
              <option key={sport} value={sport}>
                {sport.charAt(0).toUpperCase() + sport.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-league">League</Label>
          <select
            id="filter-league"
            aria-label="Filter by league"
            value={leagueFilter}
            onChange={(e) => setLeagueFilter(e.target.value)}
            className="h-8 w-56 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">All leagues</option>
            {leagueOptions.map((league) => (
              <option key={league.key} value={league.key}>
                {league.label}
              </option>
            ))}
          </select>
        </div>
        {isSuperAdmin && (
          <div className="space-y-1.5">
            <Label htmlFor="filter-fixture-id">Fixture ID</Label>
            <Input
              id="filter-fixture-id"
              value={fixtureIdFilter}
              onChange={(e) => setFixtureIdFilter(e.target.value)}
              placeholder="Search fixture ID"
              className="w-56"
            />
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-text-muted">No imported fixtures match these filters.</p>
      ) : (
        <div className="space-y-2">
          {visible.map((fixture) => (
            <FixtureManagementRow
              key={fixture.id}
              fixture={fixture}
              isSuperAdmin={isSuperAdmin}
              onDeleted={() => setRemoved((prev) => new Set(prev).add(fixture.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FixtureManagementRow({
  fixture,
  isSuperAdmin,
  onDeleted,
}: {
  fixture: ImportedFixture;
  isSuperAdmin: boolean;
  onDeleted: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteFixtureAction(fixture.id);
      if (!result.success) {
        setError(result.error);
        setConfirmingDelete(false);
        return;
      }
      onDeleted();
    });
  }

  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
            {fixture.homeTeamName} vs {fixture.awayTeamName}
            {/* Internal provider ID — only meaningful for super admins
                debugging imports/duplicates, so it's hidden from regular
                admins rather than shown as a normal-looking meta detail. */}
            {isSuperAdmin && (
              <span className="rounded-full bg-surface-secondary px-2 py-0.5 font-mono text-xs font-normal text-text-muted">
                ID: {fixture.externalFixtureId}
              </span>
            )}
          </div>
          <div className="text-xs text-text-muted">
            {fixture.competitionName ?? "Unknown competition"} ·{" "}
            {new Date(fixture.scheduledStartUtc).toLocaleString()}
          </div>
          {error && <div className="text-xs text-danger">{error}</div>}
        </div>
        <div className="flex items-center gap-2">
          {fixture.hasPost ? (
            <span className="text-xs text-text-muted">In use (has a Post)</span>
          ) : !isSuperAdmin ? null : confirmingDelete ? (
            <>
              <Button type="button" variant="destructive" size="sm" disabled={isPending} onClick={handleDelete}>
                {isPending ? "Deleting…" : "Confirm delete"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
