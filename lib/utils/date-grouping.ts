// Ledger date-grouping (spec X.6's "Venmo-style ledger", Phase 7). Pure and
// unit-tested — the Activity page is the only caller today, but this has no
// dependency on it.

export type DateGroupLabel = "Today" | "Yesterday" | "This week" | "Earlier";

const GROUP_ORDER: readonly DateGroupLabel[] = ["Today", "Yesterday", "This week", "Earlier"];

// UTC, not local time: keeps the grouping deterministic regardless of the
// server/test-runner's timezone. A "day" boundary shifting a few hours
// from any given user's actual local midnight is an acceptable trade-off
// for a "roughly how recent" ledger grouping label, not a financial value.
function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

/** Buckets a single timestamp relative to `now` (defaults to the real clock). */
export function dateGroupLabel(dateIso: string, now: Date = new Date()): DateGroupLabel {
  const day = startOfDay(new Date(dateIso));
  const today = startOfDay(now);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);

  if (diffDays <= 0) return "Today"; // also covers minor clock skew into the future
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "This week";
  return "Earlier";
}

/**
 * Groups items into Today/Yesterday/This week/Earlier sections, in that
 * fixed order, omitting any section with no items. Preserves each item's
 * relative order within its section.
 */
export function groupByDate<T>(
  items: readonly T[],
  getDateIso: (item: T) => string,
  now: Date = new Date(),
): Array<{ label: DateGroupLabel; items: T[] }> {
  const buckets = new Map<DateGroupLabel, T[]>();

  for (const item of items) {
    const label = dateGroupLabel(getDateIso(item), now);
    const bucket = buckets.get(label);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(label, [item]);
    }
  }

  return GROUP_ORDER.filter((label) => buckets.has(label)).map((label) => ({
    label,
    items: buckets.get(label)!,
  }));
}
