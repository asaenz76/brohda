"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import {
  startCompetitionImportAction,
  retryCompetitionImportAction,
  refreshRecommendationsNowAction,
  type CompetitionManagerData,
  type RecommendedCompetition,
} from "@/lib/actions/competitions";
import type { CompetitionRow } from "@/lib/competitions/manager-data";
import { NEEDS_ATTENTION_LABEL, OPERATIONAL_STATUS_LABEL } from "@/lib/competitions/status";
import { IMPORT_STATUS_BADGE_CLASS, OPERATIONAL_STATUS_BADGE_CLASS } from "@/lib/competitions/badge-classes";
import { RECOMMENDATION_WINDOW_DAYS } from "@/lib/competitions/constants";
import { COMPETITION_GROUP_LABEL, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import { AllCompetitionsTab } from "./all-competitions-tab";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const TABS = ["Recommended", "Imported", "Needs attention", "All competitions"] as const;
type Tab = (typeof TABS)[number];

const ALL_GROUPS: CompetitionGroup[] = ["GLOBAL", "COSTA_RICA"];

function Badge({ label, className }: { label: string; className?: string }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", className)}>{label}</span>;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const days = Math.round(abs / 86_400_000);
  const label = days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

interface Filters {
  search: string;
  groups: Set<CompetitionGroup>;
  hasUpcoming: boolean;
}

function defaultFilters(tab: Tab): Filters {
  if (tab === "Recommended") {
    return { search: "", groups: new Set(ALL_GROUPS), hasUpcoming: true };
  }
  return { search: "", groups: new Set(), hasUpcoming: false };
}

function filterCompetitionRows(rows: CompetitionRow[], filters: Filters): CompetitionRow[] {
  return rows.filter((r) => {
    if (filters.search && !r.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
    if (filters.groups.size > 0 && (!r.group || !filters.groups.has(r.group))) return false;
    if (filters.hasUpcoming && r.operationalStatus !== "ACTIVE") return false;
    return true;
  });
}

export function CompetitionManager({ initialData }: { initialData: CompetitionManagerData }) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<Tab>("Recommended");
  const [filters, setFilters] = useState<Filters>(() => defaultFilters("Recommended"));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function switchTab(next: Tab) {
    setTab(next);
    setFilters(defaultFilters(next));
    setSelected(new Set());
  }

  function refresh() {
    startTransition(async () => {
      const fresh = await (await import("@/lib/actions/competitions")).getCompetitionManagerDataAction();
      if (fresh.success) {
        setData(fresh.data);
        setMessage(null);
      } else {
        // Keep showing the last-known-good data rather than blanking the
        // page — but the error must still be visible, not silently
        // dropped (the exact failure mode this action's rewrite fixes).
        setMessage(fresh.error);
      }
    });
  }

  function toggleGroup(g: CompetitionGroup) {
    setFilters((f) => {
      const next = new Set(f.groups);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return { ...f, groups: next };
    });
  }

  // Snapshotted once per mount, not read fresh on every filter pass — this
  // is an approximate "within 14 days" filter, not a live countdown, so it
  // doesn't need to tick, and reading Date.now() directly inside a useMemo
  // callback trips React's purity rule (the memo body must be idempotent
  // across re-renders with the same inputs).
  const [nowMs] = useState(() => Date.now());

  // Whether any filter has been touched away from its tab default — drives
  // which of the distinct empty-state messages the Recommended tab shows
  // (an active filter narrowing zero results reads very differently from
  // there genuinely being nothing to recommend).
  const recommendedFiltersActive = filters.search !== "" || filters.groups.size !== ALL_GROUPS.length || !filters.hasUpcoming;

  const filteredRecommended = useMemo(() => {
    return data.recommended.filter((r) => {
      if (filters.search && !r.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
      if (filters.groups.size > 0 && !filters.groups.has(r.group)) return false;
      if (filters.hasUpcoming && r.nextFixtureAt) {
        const days = (new Date(r.nextFixtureAt).getTime() - nowMs) / 86_400_000;
        if (days > RECOMMENDATION_WINDOW_DAYS) return false;
      }
      return true;
    });
  }, [data.recommended, filters, nowMs]);

  const [refreshing, setRefreshing] = useState(false);
  function refreshRecommendationsNow() {
    setRefreshing(true);
    startTransition(async () => {
      const result = await refreshRecommendationsNowAction();
      setMessage(
        result.success
          ? `Checked ${result.checked} supported competition(s), refreshed ${result.refreshed}${result.errors > 0 ? `, ${result.errors} failed` : ""}.`
          : result.error,
      );
      setRefreshing(false);
      refresh();
    });
  }

  const filteredImported = useMemo(() => filterCompetitionRows(data.imported, filters), [data.imported, filters]);
  const filteredNeedsAttention = useMemo(
    () => filterCompetitionRows(data.needsAttention, filters),
    [data.needsAttention, filters],
  );

  function runImport(externalLeagueId: string, season: string) {
    startTransition(async () => {
      const result = await startCompetitionImportAction(externalLeagueId, season);
      setMessage(result.success ? "Import started." : result.error);
      if (result.success) refresh();
    });
  }

  function runImportSelected() {
    startTransition(async () => {
      for (const key of selected) {
        const [externalLeagueId, season] = key.split(":");
        await startCompetitionImportAction(externalLeagueId, season);
      }
      setMessage(`Imported ${selected.size} competition(s).`);
      setSelected(new Set());
      refresh();
    });
  }

  function runRetry(jobId: string) {
    startTransition(async () => {
      const result = await retryCompetitionImportAction(jobId);
      setMessage(result.success ? "Retry completed." : result.error);
      refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border-subtle">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => switchTab(t)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium",
              tab === t ? "border-accent-primary text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {t}
            {t === "Needs attention" && data.needsAttention.length > 0 && (
              <span className="ml-1.5 rounded-full bg-warning-muted/20 px-1.5 text-[11px] text-warning-muted">
                {data.needsAttention.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {message && <p className="text-xs text-text-secondary">{message}</p>}

      {tab !== "All competitions" && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Input
              placeholder={tab === "Recommended" ? "Search recommended competitions…" : "Search…"}
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              className="h-8 w-56 pr-7"
            />
            {filters.search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setFilters((f) => ({ ...f, search: "" }))}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="flex gap-1">
            {ALL_GROUPS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => toggleGroup(g)}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs font-medium",
                  filters.groups.has(g) ? "border-accent-primary bg-accent-primary/10 text-text-primary" : "border-border-subtle text-text-muted",
                )}
              >
                {COMPETITION_GROUP_LABEL[g]}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={filters.hasUpcoming}
              onChange={(e) => setFilters((f) => ({ ...f, hasUpcoming: e.target.checked }))}
            />
            {tab === "Recommended" ? `Fixture within ${RECOMMENDATION_WINDOW_DAYS} days` : "Active only"}
          </label>
        </div>
      )}

      {tab === "Recommended" && (
        <div className="space-y-2">
          {data.recommendedCacheStatus !== "FRESH" && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-warning-muted/40 bg-warning-muted/10 px-3 py-2">
              <p className="text-xs text-text-secondary">
                {data.recommendedCacheStatus === "NOT_CHECKED"
                  ? "Recommendations have not been checked yet."
                  : "Recommendation data is stale."}
              </p>
              <Button size="sm" variant="outline" disabled={pending || refreshing} onClick={refreshRecommendationsNow}>
                {refreshing ? "Refreshing…" : "Refresh recommendations"}
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-xs text-text-muted">{filteredRecommended.length} recommended competition(s)</p>
              {data.recommendedCacheStatus === "FRESH" && (
                <Button size="sm" variant="ghost" disabled={pending || refreshing} onClick={refreshRecommendationsNow} className="h-6 px-1.5 text-xs">
                  {refreshing ? "Refreshing…" : "Refresh"}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {selected.size > 0 && (
                <Button size="sm" disabled={pending} onClick={runImportSelected}>
                  Import selected ({selected.size})
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={pending || filteredRecommended.length === 0}
                onClick={() => {
                  startTransition(async () => {
                    for (const r of filteredRecommended) {
                      await startCompetitionImportAction(r.externalLeagueId, r.season);
                    }
                    setMessage(`Imported ${filteredRecommended.length} recommended competition(s).`);
                    refresh();
                  });
                }}
              >
                Import all recommended
              </Button>
            </div>
          </div>
          <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
            {filteredRecommended.map((r) => (
              <RecommendedRow
                key={`${r.externalLeagueId}:${r.season}`}
                competition={r}
                selected={selected.has(`${r.externalLeagueId}:${r.season}`)}
                onToggleSelect={() =>
                  setSelected((s) => {
                    const key = `${r.externalLeagueId}:${r.season}`;
                    const next = new Set(s);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                onImport={() => runImport(r.externalLeagueId, r.season)}
                disabled={pending}
              />
            ))}
            {filteredRecommended.length === 0 && (
              <p className="p-4 text-sm text-text-muted">
                {data.recommendedCacheStatus === "NOT_CHECKED"
                  ? "Recommendations have not been refreshed yet."
                  : recommendedFiltersActive
                    ? "No recommended competitions match these filters."
                    : data.supportedCompetitionsEligible > 0 && data.supportedCompetitionsAlreadyImported === data.supportedCompetitionsEligible
                      ? "All currently recommended competitions have already been imported."
                      : "No supported competitions are currently ready to import."}
              </p>
            )}
          </div>
        </div>
      )}

      {tab === "Imported" && <CompetitionRowsList rows={filteredImported} onRetry={runRetry} pending={pending} />}
      {tab === "Needs attention" && <CompetitionRowsList rows={filteredNeedsAttention} onRetry={runRetry} pending={pending} showReasons />}

      {tab === "All competitions" && <AllCompetitionsTab data={data} importPending={pending} onImport={refresh} setMessage={setMessage} />}
    </div>
  );
}

function RecommendedRow({
  competition,
  selected,
  onToggleSelect,
  onImport,
  disabled,
}: {
  competition: RecommendedCompetition;
  selected: boolean;
  onToggleSelect: () => void;
  onImport: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <input type="checkbox" checked={selected} onChange={onToggleSelect} />
        <div>
          <p className="text-sm font-medium text-text-primary">
            {competition.name}{" "}
            <span className="text-xs font-normal text-text-muted">
              — {competition.countryName} · {COMPETITION_GROUP_LABEL[competition.group]}
            </span>
          </p>
          <p className="text-xs text-text-muted">
            Season {competition.season} · {competition.upcomingFixtureCount} fixture(s) in the next 30 days · Next{" "}
            {formatRelative(competition.nextFixtureAt)}
          </p>
        </div>
      </div>
      <Button size="sm" disabled={disabled} onClick={onImport}>
        Import
      </Button>
    </div>
  );
}

function CompetitionRowsList({
  rows,
  onRetry,
  pending,
  showReasons = false,
}: {
  rows: CompetitionRow[];
  onRetry: (jobId: string) => void;
  pending: boolean;
  showReasons?: boolean;
}) {
  return (
    <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
      {rows.map((row) => (
        <div key={`${row.externalLeagueId}:${row.season}`} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0">
            <Link
              href={row.leagueSeasonImportId ? `/admin/competitions/${row.leagueSeasonImportId}` : "#"}
              className="text-sm font-medium text-text-primary hover:underline"
            >
              {row.name}
            </Link>{" "}
            <span className="text-xs text-text-muted">
              {row.countryName ? `— ${row.countryName}` : ""} {row.group ? `· ${COMPETITION_GROUP_LABEL[row.group]}` : ""} · Season {row.season} ·
              League ID {row.externalLeagueId}
            </span>
            <p className="text-xs text-text-muted">
              {row.fixtureCountImported} fixture(s) imported · Next {formatRelative(row.nextFixtureAt)} · Last synced{" "}
              {formatRelative(row.lastSyncedAt)}
            </p>
            {!row.isSupported && (
              <p className="text-xs text-text-muted">This competition is no longer supported — its data is kept, but it&apos;s never synchronized.</p>
            )}
            {showReasons && row.needsAttentionReasons.length > 0 && (
              <p className="text-xs text-warning-muted">{row.needsAttentionReasons.map((r) => NEEDS_ATTENTION_LABEL[r]).join(" · ")}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge label={row.importStatus} className={IMPORT_STATUS_BADGE_CLASS[row.importStatus]} />
            {row.operationalStatus && (
              <Badge label={OPERATIONAL_STATUS_LABEL[row.operationalStatus]} className={OPERATIONAL_STATUS_BADGE_CLASS[row.operationalStatus]} />
            )}
            {row.importStatus === "IMPORT_FAILED" && row.latestJobId && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => onRetry(row.latestJobId!)}>
                Retry
              </Button>
            )}
            {row.leagueSeasonImportId && (
              <Link href={`/admin/competitions/${row.leagueSeasonImportId}`}>
                <Button size="sm" variant="outline">
                  Open
                </Button>
              </Link>
            )}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="p-4 text-sm text-text-muted">Nothing here.</p>}
    </div>
  );
}
