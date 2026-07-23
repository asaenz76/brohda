import { formatCents } from "@/lib/utils/money";

// Analytics-specific display formatting — kept separate from
// lib/utils/money.ts (which formats basis points, a fixed-precision fee
// representation) since ROI/accuracy are arbitrary fractions.
export function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  const formatted = percent.toFixed(1).replace(/\.0$/, "");
  return `${formatted}%`;
}

// Prefixes a "+" on positive amounts — Intl's currency formatter already
// prepends "-" to negatives, but never "+" to positives.
export function formatSignedCents(cents: number): string {
  const formatted = formatCents(cents);
  return cents > 0 ? `+${formatted}` : formatted;
}

// timeZone must be the user's chosen analytics_timezone, not the viewer's
// device zone — a chart bucketed by "Jul 31 in America/Costa_Rica" must
// label that same point "Jul 31", never re-derive the label in whatever
// zone the browser happens to be running in.
export function formatChartDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

// Recharts invokes axis tickFormatter as (value, index) and Tooltip
// formatter/labelFormatter with several positional args beyond the raw
// value — handing it a bare formatter reference (e.g. formatCents, whose
// second parameter is `currency`) lets the tick index leak into that
// parameter. These wrappers pin the arity to exactly one argument
// regardless of how many arguments Recharts actually passes, and are the
// single place every chart component should get this behavior from
// (rather than each component redefining its own closures).
export function wrapAxisNumberFormatter(formatter?: (value: number) => string): (value: unknown) => string {
  return (value: unknown) => (typeof value === "number" && formatter ? formatter(value) : "");
}

export function wrapAxisLabelFormatter(formatter?: (label: string) => string): (label: unknown) => string {
  return (label: unknown) => (typeof label === "string" && formatter ? formatter(label) : "");
}

export function wrapTooltipValueFormatter(formatter?: (value: number) => string): (value: unknown) => string {
  return (value: unknown) => (typeof value === "number" && formatter ? formatter(value) : String(value ?? ""));
}

export function wrapTooltipLabelFormatter(formatter?: (label: string) => string): (label: unknown) => string {
  return (label: unknown) => (typeof label === "string" && formatter ? formatter(label) : String(label ?? ""));
}
