"use client";

import { useState, useTransition } from "react";
import { importFixturesAction, type FixtureSearchResult } from "@/lib/actions/fixtures";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FixtureResultRow } from "./fixture-result-row";

export function FixtureResultsList({ fixtures }: { fixtures: FixtureSearchResult[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkWarning, setBulkWarning] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const importableIds = fixtures
    .map((f) => f.externalFixtureId)
    .filter((id) => !imported.has(id));
  const allSelected = importableIds.length > 0 && importableIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(importableIds));
  }

  function importSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkError(null);
    setBulkWarning(null);
    startTransition(async () => {
      const results = await importFixturesAction(ids);
      const succeeded = results.filter((r) => r.success).map((r) => r.externalFixtureId);
      const failed = results.filter((r) => !r.success);
      const warned = results.filter((r) => r.success && r.warning);

      setImported((prev) => new Set([...prev, ...succeeded]));
      setSelected((prev) => {
        const next = new Set(prev);
        succeeded.forEach((id) => next.delete(id));
        return next;
      });
      if (failed.length > 0) {
        setBulkError(`${failed.length} fixture${failed.length > 1 ? "s" : ""} failed to import.`);
      }
      if (warned.length > 0) {
        setBulkWarning(
          `${warned.length} fixture${warned.length > 1 ? "s were" : " was"} imported from an unsupported competition — hidden from pool creation.`,
        );
      }
    });
  }

  return (
    <div className="space-y-3">
      {importableIds.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-secondary px-4 py-2.5">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
            Select all ({importableIds.length})
          </label>
          <Button type="button" size="sm" disabled={selected.size === 0 || isPending} onClick={importSelected}>
            {isPending ? "Importing…" : `Import selected (${selected.size})`}
          </Button>
        </div>
      )}
      {bulkError && <p className="text-sm text-danger">{bulkError}</p>}
      {bulkWarning && <p className="text-sm text-warning-muted">{bulkWarning}</p>}
      <div className="space-y-2">
        {fixtures.map((fixture) => (
          <FixtureResultRow
            key={fixture.externalFixtureId}
            fixture={fixture}
            selected={selected.has(fixture.externalFixtureId)}
            onToggleSelect={() => toggle(fixture.externalFixtureId)}
            imported={imported.has(fixture.externalFixtureId)}
            onImported={() => setImported((prev) => new Set(prev).add(fixture.externalFixtureId))}
          />
        ))}
      </div>
    </div>
  );
}
