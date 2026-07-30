import { describe, expect, it } from "vitest";
import { groupPoolTotalsByPoolId, groupPoolParticipantsByPoolId } from "@/lib/pools/fetch";

describe("groupPoolTotalsByPoolId", () => {
  it("never cross-attributes one pool's totals to another", () => {
    const map = groupPoolTotalsByPoolId([
      { pool_id: "pool-a", total_entries: 3, gross_pool: 3000 },
      { pool_id: "pool-b", total_entries: 7, gross_pool: 7000 },
    ]);

    expect(map.get("pool-a")).toEqual({ total_entries: 3, gross_pool: 3000 });
    expect(map.get("pool-b")).toEqual({ total_entries: 7, gross_pool: 7000 });
  });

  it("has no entry for a pool absent from the rows (zero-entries pool) — caller supplies the zero fallback", () => {
    const map = groupPoolTotalsByPoolId([{ pool_id: "pool-a", total_entries: 1, gross_pool: 1000 }]);

    expect(map.has("pool-c")).toBe(false);
    expect(map.get("pool-c")).toBeUndefined();
  });
});

describe("groupPoolParticipantsByPoolId", () => {
  it("never cross-attributes one pool's participants to another, and preserves per-pool order", () => {
    const map = groupPoolParticipantsByPoolId([
      { pool_id: "pool-a", user_id: "u1", display_name: "Alice", avatar_url: null },
      { pool_id: "pool-b", user_id: "u2", display_name: "Bob", avatar_url: null },
      { pool_id: "pool-a", user_id: "u3", display_name: "Carol", avatar_url: null },
    ]);

    expect(map.get("pool-a")).toEqual([
      { display_name: "Alice", avatar_url: null },
      { display_name: "Carol", avatar_url: null },
    ]);
    expect(map.get("pool-b")).toEqual([{ display_name: "Bob", avatar_url: null }]);
  });

  it("returns undefined (not an empty array) for a pool with zero participants — caller supplies the [] fallback", () => {
    const map = groupPoolParticipantsByPoolId([]);
    expect(map.get("pool-a")).toBeUndefined();
  });
});
