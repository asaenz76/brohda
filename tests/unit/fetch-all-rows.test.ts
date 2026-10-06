import { describe, expect, it } from "vitest";
import { fetchAllRows } from "@/lib/utils/batch";

// A fake PostgREST: serves `total` rows by inclusive range, but never more than `cap` per response, exactly like max_rows.
function fakeTable(total: number, cap = 1000) {
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to, from + cap - 1, total - 1);
    const data = from > end ? [] : Array.from({ length: end - from + 1 }, (_, i) => ({ id: from + i }));
    return { data, error: null };
  };
  return { fetchPage, calls };
}

describe("fetchAllRows — whole-table reads page instead of silently truncating at the server's row cap", () => {
  it("returns every row of a table larger than one response, in order, with no gaps or duplicates", async () => {
    const { fetchPage } = fakeTable(2030);
    const rows = await fetchAllRows(fetchPage);
    expect(rows).toHaveLength(2030);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2030 }, (_, i) => i));
  });

  it("an empty table is one call and an empty array", async () => {
    const { fetchPage, calls } = fakeTable(0);
    expect(await fetchAllRows(fetchPage)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a table that is an exact multiple of the page size takes one extra empty call to confirm the end — and loses nothing", async () => {
    const { fetchPage } = fakeTable(1000);
    expect(await fetchAllRows(fetchPage)).toHaveLength(1000);
  });

  it("a small table is a single page", async () => {
    const { fetchPage, calls } = fakeTable(7);
    expect(await fetchAllRows(fetchPage)).toHaveLength(7);
    expect(calls).toHaveLength(1);
  });

  it("an error from any page is thrown, never swallowed into a partial result", async () => {
    let n = 0;
    const failing = async () => (++n === 2 ? { data: null, error: { message: "boom" } } : { data: Array.from({ length: 500 }, (_, i) => ({ id: i })), error: null });
    await expect(fetchAllRows(failing)).rejects.toMatchObject({ message: "boom" });
  });
});
