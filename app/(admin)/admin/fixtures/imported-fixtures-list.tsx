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
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  scheduledStartUtc: string;
  poolCount: number;
  hidden: boolean;
}

export function ImportedFixturesList({
  fixtures,
  isSuperAdmin,
}: {
  fixtures: ImportedFixture[];
  isSuperAdmin: boolean;
}) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [hiddenOverrides, setHiddenOverrides] = useState<Map<string, boolean>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [fixtureIdFilter, setFixtureIdFilter] = useState("");

  const remaining = fixtures.filter((f) => !removed.has(f.id));
  const visible = remaining
    .filter((f) => f.externalFixtureId.includes(fixtureIdFilter.trim()))
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
        <h2 className="text-sm font-semibold text-text-primary">Imported fixtures ({visible.length})</h2>
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
      {visible.length === 0 ? (
        <p className="text-sm text-text-muted">No imported fixtures match that ID.</p>
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
