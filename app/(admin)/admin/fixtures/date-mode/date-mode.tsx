"use client";

// Phase 2 (local-first football browsing): normal By-date browsing is now
// pure local-DB (spec §1/§2) — the only network call this component makes
// on mount or on any preset/date/filter change is the local browse Server
// Action below, which never touches apiFootballProvider (see
// lib/actions/fixture-browse.ts's own header comment). The old
// provider-backed search still exists, but only inside
// <ProviderDiscoveryPanel>, which is never mounted until the admin
// explicitly opens the "Discover fixtures from provider" toggle (spec
// §10) — see regression coverage in
// tests/integration/local-fixture-browse.test.ts proving zero provider
// calls happen without that click.
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { browseFixturesByDateAction } from "@/lib/actions/fixture-browse";
import { DEFAULT_DATE_RANGE_PRESET, type DateRangePreset } from "@/lib/fixtures/date-window";
import type { LocalFixtureBrowseResult } from "@/lib/fixtures/local-browse";
import { groupAndSortLocalFixtures } from "@/lib/fixtures/local-grouping";
import { defaultLocalFixtureFilters, filterLocalFixtures, isDefaultLocalFixtureFilters, type LocalFixtureFilters } from "@/lib/fixtures/local-filters";
import { DateToolbar } from "./date-toolbar";
import { LocalFixtureDateGroups } from "../local-fixture-groups";
import { ProviderDiscoveryPanel } from "./provider-discovery-panel";
import { COMPETITION_GROUP_LABEL, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const ALL_GROUPS: CompetitionGroup[] = ["GLOBAL", "COSTA_RICA"];

function formatDateRangeLabel(localFromDate: string, localToDate: string): string {
  if (localFromDate === localToDate) return localFromDate;
  return `${localFromDate} – ${localToDate}`;
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

  const [windowInfo, setWindowInfo] = useState<{ localFromDate: string; localToDate: string; timeZone: string } | null>(null);
  const [result, setResult] = useState<LocalFixtureBrowseResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [hasSearchedOnce, setHasSearchedOnce] = useState(false);
  const [includeUnsupported, setIncludeUnsupported] = useState(false);
  const [showDiscovery, setShowDiscovery] = useState(false);

  const [filters, setFilters] = useState<LocalFixtureFilters>(defaultLocalFixtureFilters);

  const runLocalSearch = useCallback(() => {
    startTransition(async () => {
      const response = await browseFixturesByDateAction({
        preset,
        customFromDate: preset === "custom" ? customFrom : undefined,
        customToDate: preset === "custom" ? customTo : undefined,
        includeUnsupported,
      });
      setHasSearchedOnce(true);
      if (!response.success) {
        setValidationError(response.error);
        setResult(null);
        setWindowInfo(null);
        return;
      }
      setValidationError(null);
      setResult(response.result);
      setWindowInfo({ localFromDate: response.window.localFromDate, localToDate: response.window.localToDate, timeZone: response.window.timeZone });
    });
  }, [preset, customFrom, customTo, includeUnsupported]);

  // Local-DB query only — never the provider. Fires on mount and on every
  // date/preset/includeUnsupported change, which is exactly what spec §20
  // wants ("open Fixtures → results immediately from DB", "change Today →
  // Tomorrow → local query") since none of this spends provider quota.
  useEffect(() => {
    if (preset === "custom" && (!customFrom || !customTo)) return;
    runLocalSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLocalSearch already depends on exactly these.
  }, [preset, customFrom, customTo, includeUnsupported]);

  // URL persistence — unchanged from the previous implementation.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes router/pathname/searchParams to avoid a sync loop.
  }, [preset, customFrom, customTo, competitionExternalId]);

  const dateGroups = useMemo(() => {
    if (!result) return [];
    const scoped = competitionExternalId ? result.fixtures.filter((f) => f.competitionExternalId === competitionExternalId) : result.fixtures;
    return groupAndSortLocalFixtures(filterLocalFixtures(scoped, filters));
  }, [result, filters, competitionExternalId]);

  const visibleCount = dateGroups.reduce((sum, g) => sum + g.competitions.reduce((s, c) => s + c.fixtures.length, 0), 0);
  const countries = useMemo(() => [...new Set((result?.fixtures ?? []).map((f) => f.competitionCountry).filter((c): c is string => Boolean(c)))].sort(), [result]);
  const types = useMemo(() => [...new Set((result?.fixtures ?? []).map((f) => f.competitionType).filter((t): t is string => Boolean(t)))].sort(), [result]);

  const filtersActive = !isDefaultLocalFixtureFilters(filters);

  return (
    <div className="space-y-4">
      <DateToolbar preset={preset} onPresetChange={setPreset} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />

      {validationError && <p className="text-sm text-danger">{validationError}</p>}

      {result && windowInfo && !validationError && (
        <>
          <p className="text-xs text-text-muted">
            {formatDateRangeLabel(windowInfo.localFromDate, windowInfo.localToDate)} · {windowInfo.timeZone}
            {pending && " · refreshing…"}
          </p>

          <div className="rounded-lg border border-border-subtle p-3 text-xs text-text-secondary">
            <p>
              {result.counts.total} fixture{result.counts.total === 1 ? "" : "s"} · {result.counts.competitions} competition{result.counts.competitions === 1 ? "" : "s"} ·{" "}
              {result.counts.withPools} with pools · {result.counts.upcoming} upcoming · {result.counts.live} live · {result.counts.completed} completed
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
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as LocalFixtureFilters["status"] }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
              <option value="all">All statuses</option>
              <option value="UPCOMING">Upcoming</option>
              <option value="LIVE">Live</option>
              <option value="COMPLETED">Completed</option>
            </select>
            <select value={filters.poolStatus} onChange={(e) => setFilters((f) => ({ ...f, poolStatus: e.target.value as LocalFixtureFilters["poolStatus"] }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
              <option value="all">Any pool status</option>
              <option value="has_pool">Has pools</option>
              <option value="no_pool">No pools</option>
              <option value="eligible_only">Eligible for pool creation</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input type="checkbox" checked={includeUnsupported} onChange={(e) => setIncludeUnsupported(e.target.checked)} />
              Include unsupported competitions
            </label>
            {filtersActive && (
              <button type="button" onClick={() => setFilters(defaultLocalFixtureFilters())} className="text-xs font-medium text-accent-primary hover:underline">
                Clear filters
              </button>
            )}
          </div>

          {dateGroups.length > 0 ? (
            <LocalFixtureDateGroups dateGroups={dateGroups} timeZone={windowInfo.timeZone} />
          ) : (
            <EmptyState total={result.counts.total} filtersActive={filtersActive} onClearFilters={() => setFilters(defaultLocalFixtureFilters())} onChangeRange={() => setPreset(DEFAULT_DATE_RANGE_PRESET)} />
          )}
        </>
      )}

      {!hasSearchedOnce && !validationError && !result && <p className="text-sm text-text-muted">Loading fixtures…</p>}

      {!providerDisabled && (
        <div className="border-t border-border-subtle pt-3">
          <button type="button" onClick={() => setShowDiscovery((v) => !v)} className="text-xs font-medium text-accent-primary hover:underline">
            {showDiscovery ? "Hide" : "Discover fixtures from provider for this range"}
          </button>
          {showDiscovery && (
            <div className="mt-2">
              <ProviderDiscoveryPanel
                key={`${preset}:${customFrom}:${customTo}:${competitionExternalId ?? ""}`}
                preset={preset}
                customFrom={customFrom}
                customTo={customTo}
                competitionExternalId={competitionExternalId}
                onImported={runLocalSearch}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  total,
  filtersActive,
  onClearFilters,
  onChangeRange,
}: {
  total: number;
  filtersActive: boolean;
  onClearFilters: () => void;
  onChangeRange: () => void;
}) {
  if (total === 0) {
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
      <p>Fixtures exist, but none match the current filters.</p>
      {filtersActive && (
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onClearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
