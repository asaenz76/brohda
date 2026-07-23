import { describe, expect, it } from "vitest";
import {
  wrapAxisLabelFormatter,
  wrapAxisNumberFormatter,
  wrapTooltipLabelFormatter,
  wrapTooltipValueFormatter,
} from "@/lib/analytics/format";
import { formatCents } from "@/lib/utils/money";

// Recharts is plain JS calling convention — it doesn't respect the
// wrapper's declared TS arity, it just calls the function with however
// many positional args it has. Cast to simulate that at the call site
// (the whole point of this suite is proving extra args are safely
// ignored at runtime, which TS's arity check would otherwise prevent us
// from even writing).
function callWithExtraArgs(fn: (value: unknown) => string, ...args: unknown[]): string {
  return (fn as (...args: unknown[]) => string)(...args);
}

// Regression guard for a Recharts footgun: axis tickFormatter is invoked
// as (value, index) and Tooltip formatter/labelFormatter receive several
// positional args beyond the raw value. A bare formatter reference (e.g.
// formatCents, whose second parameter is `currency`) would receive the
// tick index as `currency`, producing `new Intl.NumberFormat(..., {
// currency: 4 })` -> RangeError. These wrappers must ignore every
// argument beyond the first, regardless of how many Recharts passes.
describe("chart formatter wrappers", () => {
  it("wrapAxisNumberFormatter never forwards a second argument to the underlying formatter", () => {
    const wrapped = wrapAxisNumberFormatter(formatCents);
    expect(() => callWithExtraArgs(wrapped, 500, 4)).not.toThrow();
    expect(callWithExtraArgs(wrapped, 500, 4)).toBe(formatCents(500));
  });

  it("wrapAxisLabelFormatter never forwards a second argument", () => {
    const calls: unknown[][] = [];
    const wrapped = wrapAxisLabelFormatter((label: string) => {
      calls.push([label]);
      return label.toUpperCase();
    });
    expect(callWithExtraArgs(wrapped, "jul 22", 3)).toBe("JUL 22");
    expect(calls).toEqual([["jul 22"]]);
  });

  it("wrapTooltipValueFormatter never forwards extra Recharts tooltip args", () => {
    const wrapped = wrapTooltipValueFormatter(formatCents);
    expect(() => callWithExtraArgs(wrapped, 500, "Net result", {}, 2, [])).not.toThrow();
    expect(callWithExtraArgs(wrapped, 500, "Net result", {}, 2, [])).toBe(formatCents(500));
  });

  it("wrapTooltipLabelFormatter never forwards extra Recharts tooltip args", () => {
    const wrapped = wrapTooltipLabelFormatter((label: string) => label.toUpperCase());
    expect(callWithExtraArgs(wrapped, "jul 22", [])).toBe("JUL 22");
  });

  it("axis/tooltip wrappers degrade safely for non-number / non-string values instead of throwing", () => {
    expect(wrapAxisNumberFormatter(formatCents)(null)).toBe("");
    expect(wrapAxisLabelFormatter((l: string) => l)(null)).toBe("");
    expect(wrapTooltipValueFormatter(formatCents)(null)).toBe("");
    expect(wrapTooltipLabelFormatter((l: string) => l)(null)).toBe("");
  });
});
