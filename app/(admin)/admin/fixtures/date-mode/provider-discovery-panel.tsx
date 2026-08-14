"use client";

// Phase 2 spec §10: an explicit, clearly separate provider action — never
// mounted (let alone fetched) until the admin opens it (see date-mode.tsx,
// which renders this only after a click, not on mount or a criteria
// change). This is the OLD by-date provider search + selective import
// flow, unchanged, just demoted from "the default browsing behavior" to
// "an explicit discovery tool" and given the fixture_date_search_cache
// REPURPOSE classification that implies (still a real, working cache —
// just never read/written by normal browsing anymore).
import { useCallback, useEffect, useState, useTransition } from "react";
import { searchFixturesByDateAction } from "@/lib/actions/fixture-discovery";
import { importFixturesAction } from "@/lib/actions/fixtures";
import type { DateRangePreset } from "@/lib/fixtures/date-window";
import type { FixtureDiscoveryResult } from "@/lib/fixtures/discovery";
import { groupAndSortFixtures } from "@/lib/fixtures/grouping";
import {
  defaultFixtureFilters,
  eligibleFixtureIds,
  filterFixtures,
  pruneSelectionToResultSet,
  type FixtureFilters,
} from "@/lib/fixtures/filters";
import { FixtureDateGroups } from "./fixture-date-groups";
import { RefreshButton } from "./date-toolbar";
import { Button } from "@/components/ui/button";

export function ProviderDiscoveryPanel({
  preset,
  customFrom,
  customTo,
  competitionExternalId,
  onImported,
}: {
  preset: DateRangePreset;
  customFrom: string;
  customTo: string;
  competitionExternalId: string | undefined;
  onImported: () => void;
}) {
  const [data, setData] = useState<FixtureDiscoveryResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [filters] = useState<FixtureFilters>(defaultFixtureFilters);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importPending, startImportTransition] = useTransition();
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [newlyImported, setNewlyImported] = useState<Set<string>>(new Set());

  const runSearch = useCallback(
    (forceRefresh: boolean) => {
      startTransition(async () => {
        const result = await searchFixturesByDateAction({
          preset,
          customFromDate: preset === "custom" ? customFrom : undefined,
          customToDate: preset === "custom" ? customTo : undefined,
          competitionExternalId,
          forceRefresh,
        });
        if (!result.success) {
          setValidationError(result.error);
          setData(null);
          return;
        }
        setValidationError(null);
        setData(result.result);
        setSelected((prev) => pruneSelectionToResultSet(prev, result.result.fixtures));
      });
    },
    [preset, customFrom, customTo, competitionExternalId],
  );

  // The one and only fetch this panel ever does happens on ITS OWN mount —
  // which only happens after the admin explicitly opens it (see
  // date-mode.tsx). Never re-fires on a later preset/date change on its
  // own; the parent unmounts and remounts this panel when criteria change
  // while it's open, which re-triggers this same one-shot effect.
  useEffect(() => {
    runSearch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only fetch; see comment above.
  }, []);

  const dateGroups = data ? groupAndSortFixtures(filterFixtures(data.fixtures, filters)) : [];
  const visibleEligibleIds = dateGroups.flatMap((g) => g.competitions.flatMap((c) => eligibleFixtureIds(c.fixtures)));

  const effectiveGroups = data
    ? groupAndSortFixtures(
        filterFixtures(
          data.fixtures.map((f) => (newlyImported.has(f.externalFixtureId) ? { ...f, isImported: true } : f)),
          filters,
        ),
      )
    : [];

  function importSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setImportMessage(null);
    startImportTransition(async () => {
      const results = await importFixturesAction(ids);
      const succeeded = results.filter((r) => r.success).map((r) => r.externalFixtureId);
      const failed = results.filter((r) => !r.success);
      setNewlyImported((prev) => new Set([...prev, ...succeeded]));
      setSelected((prev) => {
        const next = new Set(prev);
        succeeded.forEach((id) => next.delete(id));
        return next;
      });
      setImportMessage(
        failed.length > 0 ? `Imported ${succeeded.length}, ${failed.length} failed.` : `Imported ${succeeded.length} fixture${succeeded.length === 1 ? "" : "s"}.`,
      );
      if (succeeded.length > 0) onImported();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border-subtle p-3">
      <p className="text-xs text-text-muted">
        Provider results for this same range — anything imported here shows up in the local browse above once refreshed.
      </p>
      {validationError && <p className="text-sm text-danger">{validationError}</p>}
      {data && !validationError && !data.error && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-text-muted">
              {data.fixtures.length} fixture{data.fixtures.length === 1 ? "" : "s"} from the provider
            </p>
            <RefreshButton pending={pending} lastRefreshedLabel={null} onRefresh={() => runSearch(true)} />
          </div>
          {visibleEligibleIds.length > 0 && (
            <button type="button" onClick={() => setSelected(new Set(visibleEligibleIds))} className="text-xs font-medium text-accent-primary hover:underline">
              Select all not-yet-imported ({visibleEligibleIds.length})
            </button>
          )}
          {selected.size > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-accent-primary/40 bg-surface-primary p-2">
              <p className="text-xs text-text-primary">{selected.size} selected</p>
              <Button type="button" size="sm" disabled={importPending} onClick={importSelected}>
                {importPending ? "Importing…" : "Import selected"}
              </Button>
            </div>
          )}
          {importMessage && <p className="text-xs text-text-secondary">{importMessage}</p>}
          {effectiveGroups.length > 0 ? (
            <FixtureDateGroups
              dateGroups={effectiveGroups}
              timeZone={data.window.timeZone}
              selected={selected}
              disabled={importPending}
              onToggleFixture={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelectDate={(_key, ids) => setSelected((prev) => new Set([...prev, ...ids]))}
              onSelectCompetition={(_key, ids) => setSelected((prev) => new Set([...prev, ...ids]))}
            />
          ) : (
            <p className="text-xs text-text-muted">No provider fixtures found in this range.</p>
          )}
        </>
      )}
      {data?.error && <p className="text-sm text-danger">The provider search failed: {data.error}</p>}
      {pending && !data && <p className="text-xs text-text-muted">Searching the provider…</p>}
    </div>
  );
}
