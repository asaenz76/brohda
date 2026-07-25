import type { MetricValue } from "./types";

// `current`/`previous` are nullable: `null` means "not computable" (e.g.
// return-on-entries with zero volume), never a misleading 0.
export function buildMetric(current: number | null, previous: number | null | undefined): MetricValue {
  if (previous === undefined || previous === null || current === null) {
    return { current, previous: previous ?? null, changeAbsolute: null, changePercentage: null };
  }
  const changeAbsolute = current - previous;
  const changePercentage = previous !== 0 ? changeAbsolute / Math.abs(previous) : null;
  return { current, previous, changeAbsolute, changePercentage };
}
