"use client";

import { useMemo, useState, useTransition } from "react";
import { X } from "lucide-react";
import type { CompetitionManagerData } from "@/lib/actions/competitions";
import { getCatalogAvailabilityAction } from "@/lib/actions/competitions";
import type { CompetitionRow } from "@/lib/competitions/manager-data";
import { OPERATIONAL_STATUS_LABEL } from "@/lib/competitions/status";
import { IMPORT_STATUS_BADGE_CLASS, OPERATIONAL_STATUS_BADGE_CLASS } from "@/lib/competitions/badge-classes";
import {
  computeSeasonState,
  getPrimaryCoverageSummary,
  resolveDisplaySeason,
  SEASON_STATE_LABEL,
  type SeasonState,
} from "@/lib/competitions/catalog-enrichment";
import type { LeagueTier } from "@/lib/sports-data/priority-leagues";
import type { NormalizedLeague } from "@/lib/sports-data/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// timeZone: "UTC" avoids the season start/end date shifting a day
// backward in a non-UTC server timezone — these are date-only provider
// values (parsed as UTC midnight), not real instants.
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = new Date(iso).getTime() - Date.now();
  const days = Math.round(Math.abs(diffMs) / 86_400_000);
  const label = days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

interface CatalogRowVM {
  externalLeagueId: string;
  name: string;
  type: string | null;
  countryName: string | null;
  tier: LeagueTier | null;
  logoUrl: string | null;
  seasonLabel: string | null;
  seasonStartDate: string | null;
  seasonEndDate: string | null;
  seasonState: SeasonState;
  nextFixtureAt: string | null;
  fixturesWithin30Days: number | null; // null = not yet checked
  coverage: NormalizedLeague["seasons"][number]["coverage"] | null;
  importedRow: CompetitionRow | null;
  currentSeasonForImport: string | null; // the season to import if not yet imported
}

interface CatalogFilters {
  search: string;
  seasonStates: Set<SeasonState>;
  tiers: Set<string>;
  type: string;
  hasUpcoming: boolean;
  importedOnly: boolean;
  notImportedOnly: boolean;
  priorityOnly: boolean;
}

function defaultCatalogFilters(): CatalogFilters {
  return {
    search: "",
    seasonStates: new Set(),
    tiers: new Set(),
    type: "",
    hasUpcoming: false,
    importedOnly: false,
    notImportedOnly: false,
    priorityOnly: false,
  };
}

const SORT_RANK: Record<string, number> = {
  IMPORTED_ACTIVE: 0,
  TIER_A: 1,
  TIER_B: 2,
  TIER_C: 3,
  IN_SEASON: 4,
  STARTS_SOON: 5,
  OTHER: 6,
};

function sortRank(row: CatalogRowVM): number {
  if (row.importedRow?.operationalStatus === "ACTIVE") return SORT_RANK.IMPORTED_ACTIVE;
  if (row.tier === "A") return SORT_RANK.TIER_A;
  if (row.tier === "B") return SORT_RANK.TIER_B;
  if (row.tier === "C") return SORT_RANK.TIER_C;
  if (row.seasonState === "IN_SEASON") return SORT_RANK.IN_SEASON;
  if (row.seasonState === "STARTS_SOON") return SORT_RANK.STARTS_SOON;
  return SORT_RANK.OTHER;
}

export function AllCompetitionsTab({
  data,
  importPending,
  onImport,
}: {
  data: CompetitionManagerData;
  importPending: boolean;
  onImport: (externalLeagueId: string, season: string) => void;
}) {
  const [filters, setFilters] = useState<CatalogFilters>(defaultCatalogFilters);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [availability, setAvailability] = useState<Record<string, { upcomingFixtureCount: number; nextFixtureAt: string | null }>>({});
  const [, startTransition] = useTransition();

  const importedByExternalId = useMemo(() => {
    const map = new Map<string, CompetitionRow>();
    for (const row of data.imported) map.set(row.externalLeagueId, row);
    return map;
  }, [data.imported]);

  const rowsByCountry = useMemo(() => {
    const result: Array<[string, CatalogRowVM[]]> = [];
    for (const [country, leagues] of data.allByCountry) {
      const rows: CatalogRowVM[] = leagues.map((league) => {
        const importedRow = importedByExternalId.get(league.externalLeagueId) ?? null;
        const season = resolveDisplaySeason(league.seasons);
        const key = season ? `${league.externalLeagueId}:${season.year}` : null;
        const live = key ? availability[key] : undefined;

        const fixturesWithin30Days = importedRow
          ? importedRow.fixturesWithinRecommendationWindow
          : (live?.upcomingFixtureCount ?? null);
        const nextFixtureAt = importedRow ? importedRow.nextFixtureAt : (live?.nextFixtureAt ?? null);

        return {
          externalLeagueId: league.externalLeagueId,
          name: league.name,
          type: league.type,
          countryName: league.countryName,
          tier: null, // filled in below via tierByExternalId if present — kept simple here
          logoUrl: league.logoUrl,
          seasonLabel: importedRow?.season ?? season?.year ?? null,
          seasonStartDate: season?.startDate ?? null,
          seasonEndDate: season?.endDate ?? null,
          seasonState: computeSeasonState(season, { hasUpcomingFixtures: fixturesWithin30Days != null ? fixturesWithin30Days > 0 : undefined }),
          nextFixtureAt,
          fixturesWithin30Days,
          coverage: season?.coverage ?? null,
          importedRow,
          currentSeasonForImport: season?.year ?? null,
        };
      });
      result.push([country, rows]);
    }
    return result;
  }, [data.allByCountry, importedByExternalId, availability]);

  // Tier is resolved from the priority map indirectly via imported rows'
  // tier field when present; for not-yet-imported leagues we don't have a
  // per-row tier here without re-importing priority-leagues.ts client-side,
  // so this reads it off any already-imported CompetitionRow that shares
  // the externalLeagueId, and otherwise leaves it null (shown as no tier
  // badge) — matches every row already surfaced elsewhere in this tab.
  const enrichedRowsByCountry = useMemo(() => {
    return rowsByCountry.map(([country, rows]): [string, CatalogRowVM[]] => [
      country,
      rows.map((r) => ({ ...r, tier: r.importedRow?.tier ?? r.tier })),
    ]);
  }, [rowsByCountry]);

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const [, rows] of enrichedRowsByCountry) for (const r of rows) if (r.type) set.add(r.type);
    return [...set].sort();
  }, [enrichedRowsByCountry]);

  const searchActive = filters.search.trim().length > 0;

  function matchesFilters(row: CatalogRowVM, country: string): boolean {
    if (filters.tiers.size > 0 && (!row.tier || !filters.tiers.has(row.tier))) return false;
    if (filters.type && row.type !== filters.type) return false;
    if (filters.seasonStates.size > 0 && !filters.seasonStates.has(row.seasonState)) return false;
    if (filters.hasUpcoming && !(row.fixturesWithin30Days && row.fixturesWithin30Days > 0)) return false;
    if (filters.importedOnly && !row.importedRow) return false;
    if (filters.notImportedOnly && row.importedRow) return false;
    if (filters.priorityOnly && !row.tier) return false;
    if (searchActive) {
      const q = filters.search.trim().toLowerCase();
      if (!row.name.toLowerCase().includes(q) && !country.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  const filteredByCountry = useMemo(() => {
    return enrichedRowsByCountry
      .map(([country, rows]): [string, CatalogRowVM[]] => [country, rows.filter((r) => matchesFilters(r, country))])
      .filter(([, rows]) => rows.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchesFilters closes over filters/searchActive, both listed
  }, [enrichedRowsByCountry, filters, searchActive]);

  // Countries stay collapsed by default; a search auto-expands every
  // country still present in filteredByCountry (which, by construction,
  // only contains countries with at least one matching competition) —
  // derived at render time rather than synced via an effect, so it never
  // needs to "collapse back" state once the search is cleared, and
  // manual toggles (tracked in `expanded`) still apply once there's no
  // active search.
  function isCountryOpen(country: string): boolean {
    return searchActive || expanded.has(country);
  }

  function toggleCountry(country: string, rows: CatalogRowVM[]) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(country)) {
        next.delete(country);
        return next;
      }
      next.add(country);
      // Lazily fetch live availability for not-yet-imported rows only —
      // imported rows already have real data from our own fixtures table.
      const toCheck = rows
        .filter((r) => !r.importedRow && r.currentSeasonForImport && !(availability[`${r.externalLeagueId}:${r.currentSeasonForImport}`]))
        .map((r) => ({ externalLeagueId: r.externalLeagueId, season: r.currentSeasonForImport! }));
      if (toCheck.length > 0) {
        startTransition(async () => {
          const result = await getCatalogAvailabilityAction(toCheck);
          setAvailability((prev2) => ({ ...prev2, ...result }));
        });
      }
      return next;
    });
  }

  function toggleSeasonState(s: SeasonState) {
    setFilters((f) => {
      const next = new Set(f.seasonStates);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return { ...f, seasonStates: next };
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
        <div className="flex gap-1">
          {(["IN_SEASON", "STARTS_SOON", "OFF_SEASON"] as SeasonState[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggleSeasonState(s)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium",
                filters.seasonStates.has(s) ? "border-accent-primary bg-accent-primary/10 text-text-primary" : "border-border-subtle text-text-muted",
              )}
            >
              {SEASON_STATE_LABEL[s]}
            </button>
          ))}
        </div>
        <select
          value={filters.type}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
          className="h-8 rounded-md border border-border-subtle bg-transparent px-2 text-xs"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input type="checkbox" checked={filters.hasUpcoming} onChange={(e) => setFilters((f) => ({ ...f, hasUpcoming: e.target.checked }))} />
          Has upcoming fixtures
        </label>
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
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input type="checkbox" checked={filters.priorityOnly} onChange={(e) => setFilters((f) => ({ ...f, priorityOnly: e.target.checked }))} />
          Priority competitions only
        </label>
      </div>

      <div className="space-y-1">
        {filteredByCountry.map(([country, rows]) => {
          const sorted = [...rows].sort((a, b) => sortRank(a) - sortRank(b) || a.name.localeCompare(b.name));
          const inSeason = rows.filter((r) => r.seasonState === "IN_SEASON").length;
          const startsSoon = rows.filter((r) => r.seasonState === "STARTS_SOON").length;
          const imported = rows.filter((r) => r.importedRow).length;
          const isOpen = isCountryOpen(country);
          return (
            <div key={country} className="rounded-lg border border-border-subtle">
              <button
                type="button"
                onClick={() => toggleCountry(country, rows)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-text-primary"
              >
                <span>{country}</span>
                <span className="text-xs font-normal text-text-muted">
                  {inSeason} in season · {startsSoon} starting soon · {imported} imported · {rows.length} competitions
                </span>
              </button>
              {isOpen && (
                <div className="divide-y divide-border-subtle border-t border-border-subtle">
                  {sorted.map((row) => (
                    <CatalogRow key={row.externalLeagueId} row={row} disabled={importPending} onImport={onImport} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {filteredByCountry.length === 0 && (
          <p className="rounded-lg border border-border-subtle p-4 text-sm text-text-muted">No competitions match these filters.</p>
        )}
      </div>
    </div>
  );
}

function CatalogRow({
  row,
  disabled,
  onImport,
}: {
  row: CatalogRowVM;
  disabled: boolean;
  onImport: (externalLeagueId: string, season: string) => void;
}) {
  const coverage = getPrimaryCoverageSummary(row.coverage);
  const importedRow = row.importedRow;

  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-text-primary">{row.name}</p>
        <p className="text-xs text-text-muted">
          {row.countryName ?? "—"} · {row.type ?? "—"} · {row.tier ? `Tier ${row.tier}` : "Unranked"} · API ID {row.externalLeagueId}
        </p>
        <p className="text-xs text-text-muted">
          {row.seasonLabel ?? "—"} · {formatDate(row.seasonStartDate)} → {formatDate(row.seasonEndDate)}
        </p>
        <p className="text-xs text-text-muted">
          {SEASON_STATE_LABEL[row.seasonState]} · Next fixture {formatRelative(row.nextFixtureAt)} ·{" "}
          {row.fixturesWithin30Days == null ? "Fixtures in next 30 days: unknown" : `${row.fixturesWithin30Days} fixture(s) in next 30 days`}
        </p>
        <p className="flex flex-wrap gap-x-2 text-xs text-text-muted">
          {coverage.map((c) => (
            <span key={c.label}>
              {c.label} {c.mark === "YES" ? "✓" : c.mark === "NO" ? "✕" : "?"}
            </span>
          ))}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
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
          row.currentSeasonForImport && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => onImport(row.externalLeagueId, row.currentSeasonForImport!)}>
              Import
            </Button>
          )
        )}
      </div>
    </div>
  );
}
