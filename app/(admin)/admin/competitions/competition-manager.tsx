"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  startCompetitionImportAction,
  retryCompetitionImportAction,
  type CompetitionManagerData,
  type RecommendedCompetition,
} from "@/lib/actions/competitions";
import type { CompetitionRow } from "@/lib/competitions/manager-data";
import { NEEDS_ATTENTION_LABEL, OPERATIONAL_STATUS_LABEL } from "@/lib/competitions/status";
import { IMPORT_STATUS_BADGE_CLASS, OPERATIONAL_STATUS_BADGE_CLASS } from "@/lib/competitions/badge-classes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const TABS = ["Recommended", "Imported", "Needs attention", "All competitions"] as const;
type Tab = (typeof TABS)[number];

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
  tiers: Set<string>;
  country: string;
  type: string;
  hasUpcoming: boolean;
}

function defaultFilters(tab: Tab): Filters {
  if (tab === "Recommended") {
    return { search: "", tiers: new Set(["A", "B"]), country: "", type: "", hasUpcoming: true };
  }
  return { search: "", tiers: new Set(), country: "", type: "", hasUpcoming: false };
}

function filterCompetitionRows(rows: CompetitionRow[], filters: Filters): CompetitionRow[] {
  return rows.filter((r) => {
    if (filters.search && !r.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
    if (filters.tiers.size > 0 && (!r.tier || !filters.tiers.has(r.tier))) return false;
    if (filters.country && r.countryName !== filters.country) return false;
    if (filters.type && r.type !== filters.type) return false;
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
      setData(fresh);
    });
  }

  function toggleTier(t: string) {
    setFilters((f) => {
      const next = new Set(f.tiers);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return { ...f, tiers: next };
    });
  }

  // Snapshotted once per mount, not read fresh on every filter pass — this
  // is an approximate "within 14 days" filter, not a live countdown, so it
  // doesn't need to tick, and reading Date.now() directly inside a useMemo
  // callback trips React's purity rule (the memo body must be idempotent
  // across re-renders with the same inputs).
  const [nowMs] = useState(() => Date.now());

  const filteredRecommended = useMemo(() => {
    return data.recommended.filter((r) => {
      if (filters.search && !r.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
      if (filters.tiers.size > 0 && !filters.tiers.has(r.tier)) return false;
      if (filters.country && r.countryName !== filters.country) return false;
      if (filters.type && r.type !== filters.type) return false;
      if (filters.hasUpcoming && r.nextFixtureAt) {
        const days = (new Date(r.nextFixtureAt).getTime() - nowMs) / 86_400_000;
        if (days > 14) return false;
      }
      return true;
    });
  }, [data.recommended, filters, nowMs]);

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

  const countries = useMemo(() => {
    const set = new Set<string>();
    for (const r of data.recommended) if (r.countryName) set.add(r.countryName);
    for (const r of data.imported) if (r.countryName) set.add(r.countryName);
    return [...set].sort();
  }, [data]);

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
          <Input
            placeholder="Search…"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="h-8 w-48"
          />
          <div className="flex gap-1">
            {["A", "B", "C"].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTier(t)}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs font-medium",
                  filters.tiers.has(t) ? "border-accent-primary bg-accent-primary/10 text-text-primary" : "border-border-subtle text-text-muted",
                )}
              >
                Tier {t}
              </button>
            ))}
          </div>
          <select
            value={filters.country}
            onChange={(e) => setFilters((f) => ({ ...f, country: e.target.value }))}
            className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs"
          >
            <option value="">All countries</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={filters.hasUpcoming}
              onChange={(e) => setFilters((f) => ({ ...f, hasUpcoming: e.target.checked }))}
            />
            {tab === "Recommended" ? "Fixture within 14 days" : "Active only"}
          </label>
        </div>
      )}

      {tab === "Recommended" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-muted">{filteredRecommended.length} recommended competition(s)</p>
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
              <p className="p-4 text-sm text-text-muted">No recommended competitions match these filters.</p>
            )}
          </div>
        </div>
      )}

      {tab === "Imported" && <CompetitionRowsList rows={filteredImported} onRetry={runRetry} pending={pending} />}
      {tab === "Needs attention" && <CompetitionRowsList rows={filteredNeedsAttention} onRetry={runRetry} pending={pending} showReasons />}

      {tab === "All competitions" && (
        <div className="space-y-1">
          {data.allByCountry.map(([country, leagues]) => (
            <details key={country} className="rounded-lg border border-border-subtle">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-text-primary">
                {country} <span className="text-xs font-normal text-text-muted">({leagues.length})</span>
              </summary>
              <div className="divide-y divide-border-subtle border-t border-border-subtle">
                {leagues.map((l) => {
                  const imported = data.importedExternalLeagueIds.has(l.externalLeagueId);
                  const currentSeason = l.seasons.find((s) => s.current);
                  return (
                    <div key={l.externalLeagueId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="text-text-primary">
                        {l.name} {l.type ? <span className="text-xs text-text-muted">({l.type})</span> : null}
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge
                          label={imported ? "Imported" : "Not imported"}
                          className={imported ? IMPORT_STATUS_BADGE_CLASS.IMPORTED : IMPORT_STATUS_BADGE_CLASS.NOT_IMPORTED}
                        />
                        {!imported && currentSeason && (
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => runImport(l.externalLeagueId, currentSeason.year)}>
                            Import
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}
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
              {competition.countryName ? `— ${competition.countryName}` : ""} · Tier {competition.tier}
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
              {row.countryName ? `— ${row.countryName}` : ""} {row.tier ? `· Tier ${row.tier}` : ""} · Season {row.season} · League ID{" "}
              {row.externalLeagueId}
            </span>
            <p className="text-xs text-text-muted">
              {row.fixtureCountImported} fixture(s) imported · Next {formatRelative(row.nextFixtureAt)} · Last synced{" "}
              {formatRelative(row.lastSyncedAt)}
            </p>
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
