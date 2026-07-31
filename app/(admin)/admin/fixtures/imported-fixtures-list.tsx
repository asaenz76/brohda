"use client";

import { useState, useTransition } from "react";
import { deleteFixtureAction, setFixturesHiddenAction } from "@/lib/actions/fixtures";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  poolCount: number;
  hidden: boolean;
}

// Several countries have leagues that share the exact same name (e.g.
// "Primera División" — Costa Rica, Peru, Chile, Uruguay all use it) —
// same disambiguation convention already used by the Feed page's league
// filter and PoolLeagueHeader.
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
  const [hiddenOverrides, setHiddenOverrides] = useState<Map<string, boolean>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
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
    .filter((f) => (leagueFilter ? leagueKey(f.competitionName ?? "", f.competitionCountry) === leagueFilter : true))
    .map((f) => ({ ...f, hidden: hiddenOverrides.get(f.id) ?? f.hidden }));

  const allSelected = visible.length > 0 && visible.every((f) => selected.has(f.id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visible.map((f) => f.id)));
  }

  function bulkSetHidden(hidden: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkError(null);
    startTransition(async () => {
      const result = await setFixturesHiddenAction(ids, hidden);
      if (!result.success) {
        setBulkError(result.error);
        return;
      }
      setHiddenOverrides((prev) => {
        const next = new Map(prev);
        ids.forEach((id) => next.set(id, hidden));
        return next;
      });
    });
  }

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
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-secondary px-4 py-2.5">
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
              Select all ({visible.length})
            </label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selected.size === 0 || isPending}
                onClick={() => bulkSetHidden(true)}
              >
                {isPending ? "Updating…" : `Hide from dropdown (${selected.size})`}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={selected.size === 0 || isPending}
                onClick={() => bulkSetHidden(false)}
              >
                Unhide ({selected.size})
              </Button>
            </div>
          </div>
          {bulkError && <p className="text-sm text-danger">{bulkError}</p>}
          <div className="space-y-2">
            {visible.map((fixture) => (
              <FixtureManagementRow
                key={fixture.id}
                fixture={fixture}
                selected={selected.has(fixture.id)}
                isSuperAdmin={isSuperAdmin}
                onToggleSelect={() => toggleSelect(fixture.id)}
                onHiddenChanged={(hidden) =>
                  setHiddenOverrides((prev) => new Map(prev).set(fixture.id, hidden))
                }
                onDeleted={() => setRemoved((prev) => new Set(prev).add(fixture.id))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FixtureManagementRow({
  fixture,
  selected,
  isSuperAdmin,
  onToggleSelect,
  onHiddenChanged,
  onDeleted,
}: {
  fixture: ImportedFixture;
  selected: boolean;
  isSuperAdmin: boolean;
  onToggleSelect: () => void;
  onHiddenChanged: (hidden: boolean) => void;
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

  function handleToggleHidden() {
    setError(null);
    startTransition(async () => {
      const result = await setFixturesHiddenAction([fixture.id], !fixture.hidden);
      if (!result.success) {
        setError(result.error);
        return;
      }
      onHiddenChanged(!fixture.hidden);
    });
  }

  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={`Select ${fixture.homeTeamName} vs ${fixture.awayTeamName}`}
        />
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
            {fixture.homeTeamName} vs {fixture.awayTeamName}
            {fixture.hidden && (
              <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-xs font-normal text-text-muted">
                Hidden from dropdown
              </span>
            )}
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
          <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleToggleHidden}>
            {fixture.hidden ? "Unhide" : "Hide from dropdown"}
          </Button>
          {fixture.poolCount > 0 ? (
            <span className="text-xs text-text-muted">
              In use ({fixture.poolCount} pool{fixture.poolCount > 1 ? "s" : ""})
            </span>
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
