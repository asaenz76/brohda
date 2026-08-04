"use client";

import { useMemo, useState, useTransition } from "react";
import { X } from "lucide-react";
import type { CompetitionManagerData } from "@/lib/actions/competitions";
import { importSupportedCompetitionAction } from "@/lib/actions/competitions";
import { OPERATIONAL_STATUS_LABEL } from "@/lib/competitions/status";
import { IMPORT_STATUS_BADGE_CLASS, OPERATIONAL_STATUS_BADGE_CLASS } from "@/lib/competitions/badge-classes";
import { COMPETITION_GROUP_LABEL, type CompetitionGroup, type CompetitionType } from "@/lib/sports-data/supported-competitions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = new Date(iso).getTime() - Date.now();
  const days = Math.round(Math.abs(diffMs) / 86_400_000);
  const label = days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

interface CatalogFilters {
  search: string;
  groups: Set<CompetitionGroup>;
  type: CompetitionType | "";
  importedOnly: boolean;
  notImportedOnly: boolean;
}

function defaultCatalogFilters(): CatalogFilters {
  return { search: "", groups: new Set(), type: "", importedOnly: false, notImportedOnly: false };
}

/**
 * "All competitions" — every entry in SUPPORTED_COMPETITIONS (never a
 * live provider catalog fetch: this tab used to browse hundreds of
 * leagues worldwide, most of which PollPools will never support; now it
 * only ever shows the curated list, joined against import state already
 * on hand). Importing a not-yet-imported entry resolves its current
 * season live at that moment — the one explicit, admin-initiated
 * provider call this tab makes, and only on click.
 */
export function AllCompetitionsTab({
  data,
  importPending,
  onImport,
  setMessage,
}: {
  data: CompetitionManagerData;
  importPending: boolean;
  onImport: () => void;
  setMessage: (message: string | null) => void;
}) {
  const [filters, setFilters] = useState<CatalogFilters>(defaultCatalogFilters);
  const [, startTransition] = useTransition();
  const [importingId, setImportingId] = useState<string | null>(null);

  const types = useMemo(() => {
    const set = new Set<CompetitionType>();
    for (const row of data.allSupported) set.add(row.competition.type);
    return [...set];
  }, [data.allSupported]);

  const filtered = useMemo(() => {
    return data.allSupported.filter(({ competition, importedRow }) => {
      if (filters.groups.size > 0 && !filters.groups.has(competition.group)) return false;
      if (filters.type && competition.type !== filters.type) return false;
      if (filters.importedOnly && !importedRow) return false;
      if (filters.notImportedOnly && importedRow) return false;
      if (filters.search) {
        const q = filters.search.trim().toLowerCase();
        if (!competition.name.toLowerCase().includes(q) && !competition.country.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [data.allSupported, filters]);

  function toggleGroup(g: CompetitionGroup) {
    setFilters((f) => {
      const next = new Set(f.groups);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return { ...f, groups: next };
    });
  }

  function runImport(externalLeagueId: string) {
    setImportingId(externalLeagueId);
    startTransition(async () => {
      const result = await importSupportedCompetitionAction(externalLeagueId);
      setMessage(result.success ? "Import started." : result.error);
      setImportingId(null);
      if (result.success) onImport();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Input
            placeholder="Search country or competition…"
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
          {(["GLOBAL", "COSTA_RICA"] as CompetitionGroup[]).map((g) => (
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
        <select
          value={filters.type}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as CompetitionType | "" }))}
          className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t === "LEAGUE" ? "League" : "Cup"}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={filters.importedOnly}
            onChange={(e) => setFilters((f) => ({ ...f, importedOnly: e.target.checked, notImportedOnly: false }))}
          />
          Imported only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={filters.notImportedOnly}
            onChange={(e) => setFilters((f) => ({ ...f, notImportedOnly: e.target.checked, importedOnly: false }))}
          />
          Not imported only
        </label>
      </div>

      <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {filtered.map(({ competition, importedRow }) => (
          <div key={competition.externalLeagueId} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">{competition.name}</p>
              <p className="text-xs text-text-muted">
                {competition.country} · {COMPETITION_GROUP_LABEL[competition.group]} · {competition.type === "LEAGUE" ? "League" : "Cup"} · API ID{" "}
                {competition.externalLeagueId}
              </p>
              {importedRow && (
                <p className="text-xs text-text-muted">
                  Season {importedRow.season} · {importedRow.fixtureCountImported} fixture(s) imported · Next {formatRelative(importedRow.nextFixtureAt)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
                  importedRow ? IMPORT_STATUS_BADGE_CLASS.IMPORTED : IMPORT_STATUS_BADGE_CLASS.NOT_IMPORTED,
                )}
              >
                {importedRow ? "Imported" : "Not imported"}
              </span>
              {importedRow?.operationalStatus && (
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", OPERATIONAL_STATUS_BADGE_CLASS[importedRow.operationalStatus])}>
                  {OPERATIONAL_STATUS_LABEL[importedRow.operationalStatus]}
                </span>
              )}
              {importedRow ? (
                <a href={`/admin/competitions/${importedRow.leagueSeasonImportId}`}>
                  <Button size="sm" variant="outline">
                    Open
                  </Button>
                </a>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={importPending || importingId === competition.externalLeagueId}
                  onClick={() => runImport(competition.externalLeagueId!)}
                >
                  {importingId === competition.externalLeagueId ? "Importing…" : "Import"}
                </Button>
              )}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <p className="p-4 text-sm text-text-muted">No competitions match these filters.</p>}
      </div>
    </div>
  );
}
