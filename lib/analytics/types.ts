// Shared analytics types (Phase 1 foundation). Trimmed to what the user
// analytics page (Phase 2) actually uses — admin/super-admin filters
// (sport/competition/template/admin/user) land with later phases once
// there's cross-user data to slice.

// THIS_SEASON is deliberately not included: there's no unified
// cross-competition season boundary in the schema (fixtures.season is a
// free-text per-competition string), so a single "this season" cutoff
// can't be computed reliably. Revisit if a real need shows up.
export type DateRangePreset = "7D" | "30D" | "90D" | "THIS_MONTH" | "YTD" | "ALL_TIME" | "CUSTOM";

export interface AnalyticsFilters {
  preset: DateRangePreset;
  dateFrom?: Date;
  dateTo?: Date;
}

// `current`/`previous` are nullable: `null` means "not computable" (e.g.
// return-on-entries with zero volume), never a misleading 0.
export interface MetricValue {
  current: number | null;
  previous?: number | null;
  changeAbsolute?: number | null;
  changePercentage?: number | null;
}

export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

export interface AnalyticsResponse<T> {
  data: T;
  generatedAt: string;
  filters: { dateFrom: string; dateTo: string };
}
