"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { searchFixturesByDateAction } from "@/lib/actions/fixture-discovery";
import { importFixturesAction } from "@/lib/actions/fixtures";
import { DEFAULT_DATE_RANGE_PRESET, type DateRangePreset } from "@/lib/fixtures/date-window";
import type { FixtureDiscoveryResult } from "@/lib/fixtures/discovery";
import { groupAndSortFixtures } from "@/lib/fixtures/grouping";
import {
  defaultFixtureFilters,
  eligibleFixtureIds,
  filterFixtures,
  isDefaultFixtureFilters,
  pruneSelectionToResultSet,
  type FixtureFilters,
} from "@/lib/fixtures/filters";
import { DateToolbar, RefreshButton } from "./date-toolbar";
import { FixtureDateGroups } from "./fixture-date-groups";
import { COMPETITION_GROUP_LABEL, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const ALL_GROUPS: CompetitionGroup[] = ["GLOBAL", "COSTA_RICA"];

type Filters = FixtureFilters;
const defaultFilters = defaultFixtureFilters;
const isDefaultFilters = isDefaultFixtureFilters;

function formatDateRangeLabel(localFromDate: string, localToDate: string): string {
  if (localFromDate === localToDate) return localFromDate;
  return `${localFromDate} – ${localToDate}`;
}

function formatRelativeMinutes(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "Last refreshed just now";
  if (minutes === 1) return "Last refreshed 1 minute ago";
  return `Last refreshed ${minutes} minutes ago`;
}

export function DateMode({
  providerDisabled,
  initialPreset,
  initialCustomFrom,
  initialCustomTo,
  initialCompetitionExternalId,
}: {
  providerDisabled: boolean;
  initialPreset: DateRangePreset;
  initialCustomFrom: string;
  initialCustomTo: string;
  initialCompetitionExternalId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [preset, setPreset] = useState<DateRangePreset>(initialPreset);
  const [customFrom, setCustomFrom] = useState(initialCustomFrom);
  const [customTo, setCustomTo] = useState(initialCustomTo);
  const competitionExternalId = initialCompetitionExternalId || undefined;

  const [data, setData] = useState<FixtureDiscoveryResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [hasSearchedOnce, setHasSearchedOnce] = useState(false);

  const [filters, setFilters] = useState<Filters>(defaultFilters);
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
        setHasSearchedOnce(true);
        if (!result.success) {
          setValidationError(result.error);
          setData(null);
          return;
        }
        setValidationError(null);
        setData(result.result);
        // Clear any selection that no longer refers to a fixture in the
        // new result set — a changed provider query invalidates it.
        setSelected((prev) => pruneSelectionToResultSet(prev, result.result.fixtures));
      });
    },
    [preset, customFrom, customTo, competitionExternalId],
  );

  // Refetch only on provider-backed criteria changes — never for a
  // client-side filter/selection change (see the filters state below,
  // which never appears in this dependency list).
  useEffect(() => {
    if (providerDisabled) return;
    if (preset === "custom" && (!customFrom || !customTo)) return;
    runSearch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSearch already depends on exactly these; re-listing it would refire on every render since it's a new function identity each time.
  }, [preset, customFrom, customTo, competitionExternalId, providerDisabled]);

  // URL persistence — mode/range/dates/competition only (provider-backed
  // criteria), never the client-only filters below.
  const urlSyncedOnce = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("mode", "date");
    if (preset === "custom") {
      params.set("range", "custom");
      if (customFrom) params.set("from", customFrom);
      else params.delete("from");
      if (customTo) params.set("to", customTo);
      else params.delete("to");
    } else {
      params.set("range", preset);
      params.delete("from");
      params.delete("to");
    }
    if (competitionExternalId) params.set("competition", competitionExternalId);
    else params.delete("competition");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    urlSyncedOnce.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes router/pathname/searchParams to avoid a sync loop; re-runs only when the actual criteria change.
  }, [preset, customFrom, customTo, competitionExternalId]);

  const dateGroups = useMemo(() => {
    if (!data) return [];
    return groupAndSortFixtures(filterFixtures(data.fixtures, filters));
  }, [data, filters]);

  const visibleFixtureIds = useMemo(() => dateGroups.flatMap((g) => g.competitions.flatMap((c) => c.fixtures.map((f) => f.externalFixtureId))), [dateGroups]);
  const visibleEligibleIds = useMemo(
    () => dateGroups.flatMap((g) => g.competitions.flatMap((c) => eligibleFixtureIds(c.fixtures))),
    [dateGroups],
  );

  const totalFound = data?.fixtures.length ?? 0;
  const supportedCount = data?.fixtures.filter((f) => f.isSupported).length ?? 0;
  const importedCount = data?.fixtures.filter((f) => f.isImported).length ?? 0;
  const competitionCount = data ? new Set(data.fixtures.map((f) => f.competitionExternalId)).size : 0;
  const visibleCount = visibleFixtureIds.length;
  const countries = useMemo(() => [...new Set((data?.fixtures ?? []).map((f) => f.competitionCountry).filter((c): c is string => Boolean(c)))].sort(), [data]);
  const types = useMemo(() => [...new Set((data?.fixtures ?? []).map((f) => f.competitionType).filter((t): t is string => Boolean(t)))].sort(), [data]);

  function toggleFixture(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectDate(_localDateKey: string, ids: string[]) {
    setSelected((prev) => new Set([...prev, ...ids]));
  }

  function selectCompetition(_key: string, ids: string[]) {
    setSelected((prev) => new Set([...prev, ...ids]));
  }

  function selectAllVisible() {
    setSelected(new Set(visibleEligibleIds));
  }

  function clearSelection() {
    setSelected(new Set());
  }

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
        failed.length > 0
          ? `Imported ${succeeded.length}, ${failed.length} failed.`
          : `Imported ${succeeded.length} fixture${succeeded.length === 1 ? "" : "s"}.`,
      );
    });
  }

  const effectiveData = useMemo(() => {
    if (!data || newlyImported.size === 0) return data;
    return {
      ...data,
      fixtures: data.fixtures.map((f) => (newlyImported.has(f.externalFixtureId) ? { ...f, isImported: true } : f)),
    };
  }, [data, newlyImported]);

  const effectiveGroups = useMemo(() => {
    if (!effectiveData) return [];
    return groupAndSortFixtures(filterFixtures(effectiveData.fixtures, filters));
  }, [effectiveData, filters]);

  if (providerDisabled) {
    return (
      <p className="text-sm text-text-secondary">
        The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code> and a valid{" "}
        <code>API_FOOTBALL_KEY</code> to discover and import fixtures.
      </p>
    );
  }

  const filtersActive = !isDefaultFilters(filters);

  return (
    <div className="space-y-4">
      <DateToolbar preset={preset} onPresetChange={setPreset} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />

      {validationError && <p className="text-sm text-danger">{validationError}</p>}

      {data && !validationError && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-text-muted">
              {formatDateRangeLabel(data.window.localFromDate, data.window.localToDate)} · {data.window.timeZone}
            </p>
            <RefreshButton pending={pending} lastRefreshedLabel={formatRelativeMinutes(data.fetchedAt)} onRefresh={() => runSearch(true)} />
          </div>

          {!data.error && (
            <>
              <div className="rounded-lg border border-border-subtle p-3 text-xs text-text-secondary">
                <p>
                  {totalFound} fixture{totalFound === 1 ? "" : "s"} found · {supportedCount} supported fixture{supportedCount === 1 ? "" : "s"} ·{" "}
                  {importedCount} already imported · {competitionCount} competition{competitionCount === 1 ? "" : "s"}
                </p>
                <p className="mt-0.5 text-text-muted">After filters: {visibleCount} visible fixture{visibleCount === 1 ? "" : "s"}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Input placeholder="Search teams or competitions…" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} className="h-8 w-56 pr-7" />
                  {filters.search && (
                    <button type="button" aria-label="Clear search" onClick={() => setFilters((f) => ({ ...f, search: "" }))} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary">
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="flex gap-1">
                  {ALL_GROUPS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() =>
                        setFilters((f) => {
                          const next = new Set(f.groups);
                          if (next.has(g)) next.delete(g);
                          else next.add(g);
                          return { ...f, groups: next };
                        })
                      }
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs font-medium",
                        filters.groups.has(g) ? "border-accent-primary bg-accent-primary/10 text-text-primary" : "border-border-subtle text-text-muted",
                      )}
                    >
                      {COMPETITION_GROUP_LABEL[g]}
                    </button>
                  ))}
                </div>
                <select value={filters.country} onChange={(e) => setFilters((f) => ({ ...f, country: e.target.value }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
                  <option value="">All countries</option>
                  {countries.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select value={filters.competitionType} onChange={(e) => setFilters((f) => ({ ...f, competitionType: e.target.value }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
                  <option value="">All types</option>
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select value={filters.importStatus} onChange={(e) => setFilters((f) => ({ ...f, importStatus: e.target.value as Filters["importStatus"] }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
                  <option value="not_imported">Not imported</option>
                  <option value="imported">Imported</option>
                  <option value="all">All</option>
                </select>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={filters.includeUnsupported} onChange={(e) => setFilters((f) => ({ ...f, includeUnsupported: e.target.checked }))} />
                  Include unsupported competitions
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={filters.hasOddsOnly} onChange={(e) => setFilters((f) => ({ ...f, hasOddsOnly: e.target.checked }))} />
                  Has odds
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={filters.excludeFriendlies} onChange={(e) => setFilters((f) => ({ ...f, excludeFriendlies: e.target.checked }))} />
                  Exclude friendlies
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={filters.excludeYouth} onChange={(e) => setFilters((f) => ({ ...f, excludeYouth: e.target.checked }))} />
                  Exclude youth
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={filters.excludeReserve} onChange={(e) => setFilters((f) => ({ ...f, excludeReserve: e.target.checked }))} />
                  Exclude reserve
                </label>
                {filtersActive && (
                  <button type="button" onClick={() => setFilters(defaultFilters())} className="text-xs font-medium text-accent-primary hover:underline">
                    Clear filters
                  </button>
                )}
              </div>

              {selected.size > 0 && (
                <div className="sticky bottom-16 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent-primary/40 bg-surface-primary p-3 shadow-lg">
                  <p className="text-sm text-text-primary">
                    {selected.size} fixture{selected.size === 1 ? "" : "s"} selected ·{" "}
                    {new Set([...selected].map((id) => effectiveData?.fixtures.find((f) => f.externalFixtureId === id)?.competitionExternalId)).size} competitions
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={importPending} onClick={clearSelection}>
                      Clear selection
                    </Button>
                    <Button type="button" size="sm" disabled={importPending || pending} onClick={importSelected}>
                      {importPending ? "Importing…" : "Import selected"}
                    </Button>
                  </div>
                </div>
              )}
              {importMessage && <p className="text-xs text-text-secondary">{importMessage}</p>}

              <div className="flex items-center gap-2">
                {visibleEligibleIds.length > 0 && (
                  <button type="button" onClick={selectAllVisible} className="text-xs font-medium text-accent-primary hover:underline">
                    Select all visible ({visibleEligibleIds.length})
                  </button>
                )}
              </div>

              {effectiveGroups.length > 0 ? (
                <FixtureDateGroups dateGroups={effectiveGroups} timeZone={data.window.timeZone} selected={selected} disabled={importPending} onToggleFixture={toggleFixture} onSelectDate={selectDate} onSelectCompetition={selectCompetition} />
              ) : (
                <EmptyState totalFound={totalFound} filtersActive={filtersActive} onClearFilters={() => setFilters(defaultFilters())} onChangeRange={() => setPreset(DEFAULT_DATE_RANGE_PRESET)} />
              )}
            </>
          )}
        </>
      )}

      {data?.error && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
          <p className="font-medium text-danger">The provider search failed.</p>
          <p className="mt-1 text-text-muted">{data.error}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" disabled={pending} onClick={() => runSearch(true)}>
            {pending ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      {!hasSearchedOnce && !validationError && !data && <p className="text-sm text-text-muted">Fixture data has not been refreshed yet.</p>}
    </div>
  );
}

function EmptyState({
  totalFound,
  filtersActive,
  onClearFilters,
  onChangeRange,
}: {
  totalFound: number;
  filtersActive: boolean;
  onClearFilters: () => void;
  onChangeRange: () => void;
}) {
  if (totalFound === 0) {
    return (
      <div className="rounded-lg border border-border-subtle p-4 text-sm text-text-muted">
        <p>No fixtures are scheduled in this date range.</p>
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onChangeRange}>
          Change date range
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border-subtle p-4 text-sm text-text-muted">
      <p>{filtersActive ? "Fixtures exist, but none match the current filters." : "All matching fixtures have already been imported."}</p>
      {filtersActive && (
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onClearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
