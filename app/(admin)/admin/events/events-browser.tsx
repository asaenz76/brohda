"use client";

// Phase 4: the Events page's own local-DB browsing loop — a sibling to
// /admin/fixtures' DateMode, generalized across sport. The only network
// call this component makes on mount or on any preset/date/sport/filter
// change is browseEventsAction (lib/actions/events.ts), which never
// touches either provider client (spec §6) — see regression coverage in
// tests/integration/admin-events.test.ts.
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { browseEventsAction } from "@/lib/actions/events";
import { DEFAULT_DATE_RANGE_PRESET, type DateRangePreset } from "@/lib/fixtures/date-window";
import type { EventSport, LocalFixtureBrowseResult } from "@/lib/fixtures/local-browse";
import { groupAndSortLocalEvents } from "@/lib/fixtures/local-event-grouping";
import { defaultEventFilters, filterEvents, type EventFilters } from "@/lib/fixtures/event-filters";
import { ALL_EVENT_SPORTS, SPORT_META } from "@/lib/fixtures/sport-meta";
import { DateToolbar } from "../fixtures/date-mode/date-toolbar";
import { EventDateGroups } from "./event-groups";
import { serializeSportParam } from "./sport-param";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function formatDateRangeLabel(localFromDate: string, localToDate: string): string {
  if (localFromDate === localToDate) return localFromDate;
  return `${localFromDate} – ${localToDate}`;
}

export function EventsBrowser({
  initialPreset,
  initialCustomFrom,
  initialCustomTo,
  initialSports,
  initialCompetitionExternalId,
  initialSearch,
  initialStatus,
  initialPoolStatus,
}: {
  initialPreset: DateRangePreset;
  initialCustomFrom: string;
  initialCustomTo: string;
  initialSports: EventSport[];
  initialCompetitionExternalId: string;
  initialSearch: string;
  initialStatus: string;
  initialPoolStatus: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [preset, setPreset] = useState<DateRangePreset>(initialPreset);
  const [customFrom, setCustomFrom] = useState(initialCustomFrom);
  const [customTo, setCustomTo] = useState(initialCustomTo);
  const [sports, setSports] = useState<Set<EventSport>>(new Set(initialSports));

  const [result, setResult] = useState<LocalFixtureBrowseResult | null>(null);
  const [windowInfo, setWindowInfo] = useState<{ localFromDate: string; localToDate: string; timeZone: string } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [hasSearchedOnce, setHasSearchedOnce] = useState(false);

  // `sports` (above) is its own state because it also drives the server
  // query (fewer rows fetched, not just a client-side hide); `filters`
  // holds only the fields that ever filter an already-fetched result set.
  // The two are combined into one EventFilters object at use time (see
  // `effectiveFilters` below) rather than duplicating `sports` into
  // `filters` via a syncing effect.
  const [filters, setFilters] = useState<Omit<EventFilters, "sports">>(() => ({
    competitionExternalId: initialCompetitionExternalId,
    search: initialSearch,
    status: (initialStatus as EventFilters["status"]) || "all",
    poolStatus: (initialPoolStatus as EventFilters["poolStatus"]) || "all",
  }));
  const effectiveFilters: EventFilters = useMemo(() => ({ ...filters, sports }), [filters, sports]);

  const runSearch = useCallback(() => {
    startTransition(async () => {
      const response = await browseEventsAction({
        preset,
        customFromDate: preset === "custom" ? customFrom : undefined,
        customToDate: preset === "custom" ? customTo : undefined,
        sports: [...sports],
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
  }, [preset, customFrom, customTo, sports]);

  useEffect(() => {
    if (preset === "custom" && (!customFrom || !customTo)) return;
    runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSearch already depends on exactly these.
  }, [preset, customFrom, customTo, sports]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
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
    const sportParam = serializeSportParam([...sports]);
    if (sports.size === ALL_EVENT_SPORTS.length) params.delete("sport");
    else params.set("sport", sportParam);
    if (filters.competitionExternalId) params.set("competition", filters.competitionExternalId);
    else params.delete("competition");
    if (filters.search) params.set("q", filters.search);
    else params.delete("q");
    if (filters.status !== "all") params.set("status", filters.status);
    else params.delete("status");
    if (filters.poolStatus !== "all") params.set("pool", filters.poolStatus);
    else params.delete("pool");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes router/pathname/searchParams to avoid a sync loop.
  }, [preset, customFrom, customTo, sports, filters.competitionExternalId, filters.search, filters.status, filters.poolStatus]);

  const dateGroups = useMemo(() => {
    if (!result) return [];
    return groupAndSortLocalEvents(filterEvents(result.fixtures, effectiveFilters));
  }, [result, effectiveFilters]);

  const visibleCount = dateGroups.reduce((sum, dg) => sum + dg.sports.reduce((s, sg) => s + sg.competitions.reduce((cs, c) => cs + c.fixtures.length, 0), 0), 0);

  const competitionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of result?.fixtures ?? []) {
      if (f.competitionExternalId && !seen.has(f.competitionExternalId)) seen.set(f.competitionExternalId, f.competitionName ?? f.competitionExternalId);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [result]);

  const filtersActive = filters.search !== "" || filters.competitionExternalId !== "" || filters.status !== "all" || filters.poolStatus !== "all";

  function resetFilters() {
    const { sports: _sports, ...rest } = defaultEventFilters([...sports]);
    void _sports;
    setFilters(rest);
  }

  function toggleSport(sport: EventSport) {
    setSports((prev) => {
      const next = new Set(prev);
      if (next.has(sport)) {
        if (next.size === 1) return prev; // never allow zero sports selected
        next.delete(sport);
      } else {
        next.add(sport);
      }
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {ALL_EVENT_SPORTS.map((sport) => {
          const meta = SPORT_META[sport];
          return (
            <button
              key={sport}
              type="button"
              onClick={() => toggleSport(sport)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium",
                sports.has(sport) ? "border-accent-primary bg-accent-primary/10 text-text-primary" : "border-border-subtle text-text-muted hover:text-text-secondary",
              )}
            >
              <span aria-hidden="true">{meta.icon}</span>
              {meta.label}
            </button>
          );
        })}
      </div>

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
              {result.counts.total} event{result.counts.total === 1 ? "" : "s"} · {result.counts.competitions} competition{result.counts.competitions === 1 ? "" : "s"} ·{" "}
              {result.counts.withPools} with pools · {result.counts.upcoming} upcoming · {result.counts.live} live · {result.counts.completed} final
            </p>
            <p className="mt-0.5 text-text-muted">After filters: {visibleCount} visible event{visibleCount === 1 ? "" : "s"}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Input
                placeholder="Search teams, competitions, round…"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                className="h-8 w-56 pr-7"
              />
              {filters.search && (
                <button type="button" aria-label="Clear search" onClick={() => setFilters((f) => ({ ...f, search: "" }))} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary">
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            <select
              value={filters.competitionExternalId}
              onChange={(e) => setFilters((f) => ({ ...f, competitionExternalId: e.target.value }))}
              className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs"
            >
              <option value="">All competitions</option>
              {competitionOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as EventFilters["status"] }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
              <option value="all">All statuses</option>
              <option value="UPCOMING">Upcoming</option>
              <option value="LIVE">Live</option>
              <option value="COMPLETED">Final</option>
            </select>
            <select value={filters.poolStatus} onChange={(e) => setFilters((f) => ({ ...f, poolStatus: e.target.value as EventFilters["poolStatus"] }))} className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs">
              <option value="all">Any pool status</option>
              <option value="has_pool">Has pools</option>
              <option value="no_pool">No pools yet</option>
            </select>
            {filtersActive && (
              <button type="button" onClick={resetFilters} className="text-xs font-medium text-accent-primary hover:underline">
                Clear filters
              </button>
            )}
          </div>

          {dateGroups.length > 0 ? (
            <EventDateGroups dateGroups={dateGroups} timeZone={windowInfo.timeZone} />
          ) : (
            <EmptyState total={result.counts.total} filtersActive={filtersActive} onClearFilters={resetFilters} onChangeRange={() => setPreset(DEFAULT_DATE_RANGE_PRESET)} />
          )}
        </>
      )}

      {!hasSearchedOnce && !validationError && !result && <p className="text-sm text-text-muted">Loading events…</p>}
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
        <p>No events are scheduled in this date range.</p>
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onChangeRange}>
          Change date range
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border-subtle p-4 text-sm text-text-muted">
      <p>Events exist, but none match the current filters.</p>
      {filtersActive && (
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onClearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
