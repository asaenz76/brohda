// Small-cohort suppression for Sponsor-facing analytics. PURE and client-safe: no database, no settings read — the threshold `k` is passed in (it comes from
// platform_settings.sponsor_intelligence_min_cohort), so there is exactly one place the rule is written and exactly one place the number lives.
//
// The rule: a figure that is based on fewer than `k` Members/events is never shown to a Sponsor, because a count of 1, 2 or 3 can point at a person. A zero is safe to show
// (it identifies nobody). Every Sponsor-facing number goes through here before it reaches a page.

/** A figure the Sponsor may see, or null when it is suppressed ("not enough data yet"). */
export type SuppressedCount = number | null;

/** The floor no configuration can go below: a count of 1 IS one person. (The database enforces the same floor on the setting.) */
export const MIN_COHORT_FLOOR = 2;

function effectiveThreshold(k: number): number {
  // A malformed threshold must never loosen privacy: anything not a usable integer falls back to the strictest sensible reading, not to "show everything".
  return Number.isInteger(k) && k >= MIN_COHORT_FLOOR ? k : Number.POSITIVE_INFINITY;
}

/** Show `n` only when it is zero (identifies nobody) or at least `k`. */
export function suppressCount(n: number, k: number): SuppressedCount {
  const threshold = effectiveThreshold(k);
  if (!Number.isFinite(n) || n < 0) return null;
  return n === 0 || n >= threshold ? n : null;
}

/**
 * A figure that is a SUBSET of another shown figure (for example "returning Members" out of "Members who made a Pick"). Showing the subset next to its total would also reveal
 * the remainder (total − subset), so the subset is shown only when BOTH the subset and its remainder are zero-or-at-least-k.
 */
export function suppressSubset(subset: number, total: number, k: number): SuppressedCount {
  const shown = suppressCount(subset, k);
  if (shown === null) return null;
  return suppressCount(total - subset, k) === null ? null : shown;
}

export interface BreakdownCell {
  key: string;
  label: string;
  count: number;
}

export interface SuppressedBreakdown {
  /** Cells that are large enough to show, biggest first. */
  cells: BreakdownCell[];
  /** The small cells merged into one "Other" figure — present only when that merged figure is itself at least `k`. Otherwise null and the small cells are simply not shown. */
  other: number | null;
}

/**
 * A breakdown (for example "sports these Members also pick"). Cells below `k` are not shown; they are merged into a single "Other" that is shown only if it is at least `k` itself.
 * The counts in a breakdown overlap (one Member can appear in several cells) and no total is shown beside it, so there is no remainder to subtract from.
 */
export function suppressBreakdown(cells: BreakdownCell[], k: number): SuppressedBreakdown {
  const threshold = effectiveThreshold(k);
  const sorted = [...cells].filter((c) => Number.isFinite(c.count) && c.count > 0).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const visible = sorted.filter((c) => c.count >= threshold);
  const mergedSmall = sorted.filter((c) => c.count < threshold).reduce((sum, c) => sum + c.count, 0);
  return { cells: visible, other: mergedSmall >= threshold ? mergedSmall : null };
}
