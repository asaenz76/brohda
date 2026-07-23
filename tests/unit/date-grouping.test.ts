import { describe, expect, it } from "vitest";
import { dateGroupLabel, groupByDate } from "@/lib/utils/date-grouping";

const NOW = new Date("2026-03-15T14:00:00Z"); // a Sunday, mid-afternoon UTC

describe("dateGroupLabel", () => {
  it("same calendar day -> Today", () => {
    expect(dateGroupLabel("2026-03-15T00:05:00Z", NOW)).toBe("Today");
    expect(dateGroupLabel("2026-03-15T23:55:00Z", NOW)).toBe("Today");
  });

  it("a moment in the future (clock skew) still counts as Today, not a crash", () => {
    expect(dateGroupLabel("2026-03-16T00:00:00Z", NOW)).toBe("Today");
  });

  it("exactly one calendar day back -> Yesterday", () => {
    expect(dateGroupLabel("2026-03-14T23:59:00Z", NOW)).toBe("Yesterday");
    expect(dateGroupLabel("2026-03-14T00:00:00Z", NOW)).toBe("Yesterday");
  });

  it("just before the Yesterday/This week boundary", () => {
    expect(dateGroupLabel("2026-03-13T12:00:00Z", NOW)).toBe("This week");
  });

  it("exactly 7 days back is still This week", () => {
    expect(dateGroupLabel("2026-03-08T12:00:00Z", NOW)).toBe("This week");
  });

  it("8 days back rolls over to Earlier", () => {
    expect(dateGroupLabel("2026-03-07T12:00:00Z", NOW)).toBe("Earlier");
  });

  it("well in the past -> Earlier", () => {
    expect(dateGroupLabel("2025-01-01T00:00:00Z", NOW)).toBe("Earlier");
  });
});

describe("groupByDate", () => {
  it("groups in fixed order, omitting empty sections", () => {
    const items = [
      { id: "a", createdAt: "2026-03-15T10:00:00Z" }, // Today
      { id: "b", createdAt: "2026-03-01T10:00:00Z" }, // Earlier
      { id: "c", createdAt: "2026-03-15T09:00:00Z" }, // Today
    ];

    const groups = groupByDate(items, (i) => i.createdAt, NOW);

    expect(groups.map((g) => g.label)).toEqual(["Today", "Earlier"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["b"]);
  });

  it("empty input produces no groups", () => {
    expect(groupByDate([], (i: never) => i, NOW)).toEqual([]);
  });

  it("preserves input order within a section", () => {
    const items = [
      { id: 1, createdAt: "2026-03-15T08:00:00Z" },
      { id: 2, createdAt: "2026-03-15T20:00:00Z" },
      { id: 3, createdAt: "2026-03-15T12:00:00Z" },
    ];
    const groups = groupByDate(items, (i) => i.createdAt, NOW);
    expect(groups[0].items.map((i) => i.id)).toEqual([1, 2, 3]);
  });
});
