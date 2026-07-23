import { describe, expect, it, vi } from "vitest";
import { fetchInChunks } from "@/lib/pools/fetch";

describe("fetchInChunks", () => {
  it("returns an empty array without calling fetchChunk when given no ids", async () => {
    const fetchChunk = vi.fn();
    const result = await fetchInChunks([], fetchChunk);
    expect(result).toEqual([]);
    expect(fetchChunk).not.toHaveBeenCalled();
  });

  it("makes a single call and returns its rows when under the chunk size", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const fetchChunk = vi.fn(async (chunk: string[]) => ({ data: chunk.map((id) => ({ id })) }));

    const result = await fetchInChunks(ids, fetchChunk);

    expect(fetchChunk).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(50);
  });

  // The actual bug this protects against: a single .in() call with ~580+
  // ids fails with PostgREST's "URI too long" — this proves a large id
  // list gets split into multiple safely-sized requests instead of one
  // oversized one.
  it("splits a large id list into multiple chunks and merges every result", async () => {
    const ids = Array.from({ length: 620 }, (_, i) => `id-${i}`);
    const chunkSizes: number[] = [];
    const fetchChunk = vi.fn(async (chunk: string[]) => {
      chunkSizes.push(chunk.length);
      return { data: chunk.map((id) => ({ id })) };
    });

    const result = await fetchInChunks(ids, fetchChunk);

    expect(fetchChunk.mock.calls.length).toBeGreaterThan(1);
    // No single request ever carries the full id list.
    expect(Math.max(...chunkSizes)).toBeLessThan(620);
    expect(result).toHaveLength(620);
    expect(result.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it("treats a chunk returning null data as empty, not a thrown error", async () => {
    const fetchChunk = vi.fn(async () => ({ data: null }));
    const result = await fetchInChunks(["a", "b"], fetchChunk);
    expect(result).toEqual([]);
  });
});
